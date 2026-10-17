#!/usr/bin/env python3
"""Copy user-provided NES files to SD:/nes over USB, with device SHA-256 readback."""
import argparse,hashlib,json,os,select,termios,time,tty
from pathlib import Path

class Device:
    def __init__(self,port):
        self.fd=os.open(port,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
        tty.setraw(self.fd)
        state=termios.tcgetattr(self.fd);state[2]&=~termios.HUPCL
        termios.tcsetattr(self.fd,termios.TCSANOW,state)
        self.buffer=b''
    def send(self,line):
        data=(line+'\n').encode()
        while data:
            select.select([],[self.fd],[],5)
            data=data[os.write(self.fd,data):]
    def wait(self,marker,timeout=25):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            while b'\n' in self.buffer:
                raw,self.buffer=self.buffer.split(b'\n',1)
                line=raw.decode(errors='replace').strip()
                if line.startswith('[NES_PUT] ERR'):raise RuntimeError(line)
                if marker in line:return line
                if 'Guru Meditation' in line:raise RuntimeError('Device panic')
            if select.select([self.fd],[],[],.1)[0]:
                self.buffer+=os.read(self.fd,8192)
        raise TimeoutError(marker)
    def close(self):os.close(self.fd)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',required=True)
    parser.add_argument('roms',type=Path,nargs='+')
    args=parser.parse_args()
    sources=[]
    for path in args.roms:
        data=path.read_bytes()
        if not 16<=len(data)<=1024*1024 or data[:4]!=b'NES\x1a':
            raise SystemExit(f'Not a supported iNES file: {path}')
        if not path.name.lower().endswith('.nes') or len(path.name)>96 or '..' in path.name:
            raise SystemExit(f'Unsupported filename: {path.name}')
        sources.append((path,data,hashlib.sha256(data).hexdigest()))
    device=Device(args.port)
    receipts=[]
    try:
        device.send('nes.exit')
        device.send('nes.put.abort');device.wait('[NES_PUT] ABORTED')
        for path,data,digest in sources:
            for attempt in range(8):
                try:
                    device.send(f'nes.put.begin {len(data)} {digest} {path.name}')
                    device.wait('[NES_PUT] READY');break
                except RuntimeError as error:
                    if 'busy/header' not in str(error) or attempt==7:raise
                    time.sleep(1)
            for offset in range(0,len(data),384):
                block=data[offset:offset+384]
                device.send(f'nes.put.chunk {offset} {block.hex()}')
                ack=device.wait('[NES_PUT] ACK ')
                if int(ack.rsplit(' ',1)[-1])!=offset+len(block):raise RuntimeError('Offset mismatch')
            device.send('nes.put.end');device.wait('[NES_PUT] DONE',timeout=45)
            receipts.append({'file':path.name,'bytes':len(data),'sha256':digest,'sd_sha256_verified':True})
            print(json.dumps(receipts[-1]),flush=True)
    except BaseException:
        device.send('nes.put.abort')
        raise
    finally:device.close()
    return receipts

if __name__=='__main__':main()
