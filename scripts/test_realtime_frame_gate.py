#!/usr/bin/env python3
"""Exercise the real RT frame gate with split TLS input and upstream readCb.

The optional upstream consumer is extracted at test time from the pinned
WebSockets 2.7.3 dependency (LGPL-2.1); no library implementation is vendored.
Set S1_ADV_WEBSOCKETS_SOURCE to its src/WebSockets.cpp when installed elsewhere.
Use --require-upstream after PlatformIO dependency installation in CI.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def extract_function(text, signature):
    start = text.index(signature)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def upstream_source(required):
    configured = os.environ.get('S1_ADV_WEBSOCKETS_SOURCE')
    source = Path(configured) if configured else ROOT / 'bots/CardputerADV/.pio/libdeps/cardputer_adv/WebSockets/src/WebSockets.cpp'
    if not source.is_file():
        if configured or required:
            raise SystemExit('Pinned WebSockets source missing; install PlatformIO dependencies or set S1_ADV_WEBSOCKETS_SOURCE.')
        return None
    manifest = json.loads((source.parent.parent / 'library.json').read_text())
    if manifest.get('version') != '2.7.3':
        raise SystemExit('Expected the reviewed WebSockets 2.7.3 consumer, not another library version.')
    return source


CPP_COMMON = r'''
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <string>
#include <vector>
#include <sys/types.h>
uint32_t clockMs=0;
unsigned moreYields=0, normalYields=0;
unsigned long millis(){return clockMs;}
struct TestInput {
 virtual ~TestInput()=default;
 virtual bool connected()=0;
 virtual int available()=0;
 virtual int read(uint8_t*,size_t)=0;
};
struct FakeTls:TestInput {
 bool online=true;std::deque<uint8_t> bytes;
 std::vector<uint8_t> delayed;uint32_t releaseAt=0;
 size_t maxRead=std::numeric_limits<size_t>::max();
 void feed(const std::vector<uint8_t>& data){bytes.insert(bytes.end(),data.begin(),data.end());}
 bool connected()override{return online;}
 int available()override {
  if(!delayed.empty() && clockMs>=releaseAt){feed(delayed);delayed.clear();}
  return static_cast<int>(bytes.size());
 }
 int read(uint8_t* target,size_t length)override {
  available();length=std::min({length,maxRead,bytes.size()});
  for(size_t i=0;i<length;++i){target[i]=bytes.front();bytes.pop_front();}
  return static_cast<int>(length);
 }
 int read(){uint8_t byte=0;return read(&byte,1)==1?byte:-1;}
};
std::vector<uint8_t> slice(const std::vector<uint8_t>& v,size_t begin,size_t end){return {v.begin()+begin,v.begin()+end};}
std::vector<uint8_t> frame(uint8_t opcode,size_t payload,bool fin=true){
 std::vector<uint8_t> out={static_cast<uint8_t>((fin?0x80:0)|opcode)};
 if(payload<126)out.push_back(static_cast<uint8_t>(payload));
 else if(payload<=65535){out.push_back(126);out.push_back(payload>>8);out.push_back(payload);}
 else {out.push_back(127);for(int shift=56;shift>=0;shift-=8)out.push_back(static_cast<uint64_t>(payload)>>shift);}
 for(size_t i=0;i<payload;++i)out.push_back(static_cast<uint8_t>(opcode==1?'A'+i%26:i*17));
 return out;
}
'''


def upstream_consumer(source):
    if source is None:
        return ''
    method = extract_function(source.read_text(), 'bool WebSockets::readCb(')
    return r'''
#define WEBSOCKETS_NETWORK_TYPE 8
#define NETWORK_ESP8266_ASYNC 9
#define WEBSOCKETS_TCP_TIMEOUT 5000
#define DEBUG_WEBSOCKETS(...) ((void)0)
#define WEBSOCKETS_YIELD_MORE() (++clockMs,++moreYields)
#define WEBSOCKETS_YIELD() (++normalYields)
struct WSclient_t {TestInput* tcp=nullptr;};
using WSreadWaitCb=std::function<void(WSclient_t*,bool)>;
class WebSockets {public:bool readCb(WSclient_t*,uint8_t*,size_t,WSreadWaitCb);};
''' + method + r'''
void negativeControl(){
 const auto payload=frame(1,198);WebSockets library;
 // Normal fragmented delivery blocks the old consumer until its tail arrives.
 clockMs=0;moreYields=0;FakeTls delayed;
 delayed.feed(slice(payload,0,7));delayed.delayed=slice(payload,7,payload.size());delayed.releaseAt=250;
 WSclient_t client{&delayed};std::vector<uint8_t> received(payload.size());int callbacks=0;
 assert(library.readCb(&client,received.data(),received.size(),[&](WSclient_t*,bool ok){assert(ok);++callbacks;}));
 assert(clockMs==250 && callbacks==1 && received==payload);
 // Missing tail reproduces the observed five-second blocking timeout.
 clockMs=0;moreYields=0;FakeTls stalled;stalled.feed(slice(payload,0,7));client.tcp=&stalled;callbacks=0;
 assert(!library.readCb(&client,received.data(),received.size(),[&](WSclient_t*,bool ok){assert(!ok);++callbacks;}));
 assert(clockMs==5001 && callbacks==1 && moreYields==5001);
 std::puts("NEGATIVE CONTROL upstream WebSockets 2.7.3: partial TLS frame blocks 250 ms; missing tail blocks 5001 ms");
}
'''


CPP_GATE = r'''
#include "realtime_frame_gate.h"
using realtime_transport::FrameGate;
using GateError=FrameGate::Error;
struct GateInput:TestInput {
 FrameGate& gate;bool online=true;size_t maxRead=std::numeric_limits<size_t>::max();
 explicit GateInput(FrameGate& g):gate(g){}
 bool connected()override{return online || gate.available()>0;}
 int available()override{return static_cast<int>(gate.available());}
 int read(uint8_t* out,size_t length)override{return gate.read(out,std::min(length,maxRead));}
};
void pumpAvailable(FrameGate& gate,FakeTls& tls){
 // Model the proxy contract: read only bytes available now, never wait for
 // the rest of a header/payload and never consume bytes of a following frame.
 unsigned calls=0;uint8_t chunk[257];const auto start=clockMs;
 while(!gate.ready() && gate.error()==GateError::None && tls.available()>0){
  assert(gate.wanted()>0);
  const size_t want=std::min({sizeof(chunk),gate.wanted(),static_cast<size_t>(tls.available())});
  const int got=tls.read(chunk,want);assert(got>0);
  assert(gate.append(chunk,static_cast<size_t>(got))==static_cast<size_t>(got));
  assert(++calls<=FrameGate::kMaxPayload+14);
 }
 assert(clockMs==start);
}
std::vector<uint8_t> consume(FrameGate& gate,bool smallReads=false,bool sourceClosed=false){
 assert(gate.ready() && gate.available()>0);
 const size_t total=gate.available();std::vector<uint8_t> received(total);
 GateInput input(gate);input.online=!sourceClosed;if(smallReads)input.maxRead=3;
 const auto beforeClock=clockMs,beforeWait=moreYields;
#ifdef S1_HAVE_UPSTREAM
 WebSockets library;WSclient_t client{&input};
 auto read=[&](size_t offset,size_t size){
  int called=0;
  assert(library.readCb(&client,received.data()+offset,size,[&](WSclient_t*,bool ok){assert(ok);++called;}));
  assert(called==1);
 };
 // Match the upstream header, extended length and payload read boundaries.
 read(0,2);size_t header=2;const unsigned length=received[1]&127U;
 if(length==126){read(2,2);header=4;}
 if(length==127){read(2,8);header=10;}
 if(total>header)read(header,total-header);
#else
 size_t offset=0;
 while(offset<total){int got=input.read(received.data()+offset,total-offset);assert(got>0);offset+=static_cast<size_t>(got);}
#endif
 assert(clockMs==beforeClock && moreYields==beforeWait);
 assert(!gate.ready() && gate.available()==0 && gate.buffered()==0 && gate.error()==GateError::None);
 uint8_t empty=0;assert(gate.read(&empty,1)==-1);
 return received;
}
void splitFrames(){
 for(const size_t payload:{size_t{0},size_t{69},size_t{198},size_t{1448},size_t{1908},size_t{2048},size_t{4096},FrameGate::kMaxPayload}){
  const auto wire=frame(2,payload);
  // Every prefix length of the extended header, then one byte at a time.
  for(size_t first=0;first<=std::min(size_t{10},wire.size()-1);++first){
   FrameGate gate;FakeTls tls;clockMs=0;tls.maxRead=7;
   tls.feed(slice(wire,0,first));pumpAvailable(gate,tls);
   assert(!gate.ready() && gate.available()==0);uint8_t byte=0;assert(gate.read(&byte,1)==-1);
   for(size_t n=first;n<wire.size();++n){
    tls.feed(slice(wire,n,n+1));pumpAvailable(gate,tls);
    if(n+1<wire.size())assert(!gate.ready() && gate.available()==0);
    assert(gate.buffered()<=FrameGate::kMaxPayload+14);
   }
   assert(consume(gate,true)==wire);assert(tls.available()==0);
  }
 }
 std::puts("PASS split headers and payloads, 0/69/198/1448/1908/2048/4096/max payload, partial consumer reads");
}
void delayedTail(){
 FrameGate gate;FakeTls tls;const auto wire=frame(1,198);clockMs=0;
 tls.feed(slice(wire,0,7));tls.delayed=slice(wire,7,wire.size());tls.releaseAt=250;
 pumpAvailable(gate,tls);assert(clockMs==0 && gate.available()==0);
 for(unsigned tick=1;tick<250;++tick){clockMs=tick;pumpAvailable(gate,tls);assert(gate.available()==0);}
 // The caller had 249 independent opportunities to service Escape/heartbeat.
 clockMs=250;pumpAvailable(gate,tls);assert(consume(gate)==wire);
 FrameGate stalled;FakeTls missing;missing.feed(slice(wire,0,7));clockMs=0;pumpAvailable(stalled,missing);
 for(unsigned tick=1;tick<=5001;++tick){clockMs=tick;pumpAvailable(stalled,missing);assert(stalled.available()==0);}
 assert(stalled.error()==GateError::None); // The socket owner owns the wall-clock deadline.
 std::puts("PASS delayed/missing tail never busy-waits or exposes partial frame");
}
void sequence(){
 std::vector<std::vector<uint8_t>> frames;
 for(unsigned i=0;i<48;++i){
  frames.push_back(frame(2,1448));
  if(i%4==0){frames.push_back(frame(9,2));frames.push_back(frame(10,2));}
  if(i%7==0)frames.push_back(frame(1,i%2==0?69:198));
 }
 frames.push_back(frame(2,17,false));frames.push_back(frame(0,19));
 frames.push_back(frame(8,2));
 std::vector<uint8_t> all;for(const auto& f:frames)all.insert(all.end(),f.begin(),f.end());
 FrameGate gate;FakeTls tls;tls.maxRead=11;tls.feed(all);size_t delivered=0;clockMs=0;
 while(tls.available()>0){pumpAvailable(gate,tls);assert(gate.ready());assert(consume(gate)==frames.at(delivered++));}
 assert(delivered==frames.size());
 std::puts("PASS continuous PCM/text/ping/pong/continuation/close frames delivered once in order");
}
void invalidHeaders(){
 const std::vector<std::vector<uint8_t>> invalid={
  {0xc2,0},                 // RSV extension not negotiated.
  {0x82,0x80},              // A server must not mask frames.
  {0x83,0},                 // Reserved opcode.
  {0x09,0},                 // Fragmented ping control frame.
  {0x89,126,0,126},         // Control payload exceeds 125 bytes.
  {0x82,127,0x80,0,0,0,0,0,0,0} // Invalid 64-bit high bit.
 };
 for(const auto& bad:invalid){
  FrameGate gate;FakeTls tls;tls.feed(bad);pumpAvailable(gate,tls);
  assert(gate.error()!=GateError::None && !gate.ready() && gate.available()==0);
  assert(gate.buffered()<=14);gate.reset();assert(gate.error()==GateError::None && gate.buffered()==0);
  const auto valid=frame(1,69);FakeTls next;next.feed(valid);pumpAvailable(gate,next);assert(consume(gate)==valid);
 }
 auto tooLarge=frame(2,FrameGate::kMaxPayload+1);tooLarge.resize(4);
 FrameGate gate;FakeTls tls;tls.feed(tooLarge);pumpAvailable(gate,tls);
 assert(gate.error()==GateError::Oversize && gate.available()==0 && gate.buffered()<=14);
 std::puts("PASS invalid RSV/mask/opcode/control/64-bit lengths and oversize rejected before body allocation");
}
void disconnectAndReuse(){
 FrameGate gate;FakeTls tls;const auto wire=frame(1,198);tls.feed(slice(wire,0,7));pumpAvailable(gate,tls);
 assert(gate.buffered()>0 && !gate.ready());tls.online=false;
 // No consumer is called on an incomplete closed connection; owner resets.
 gate.reset();assert(gate.buffered()==0 && gate.available()==0 && gate.error()==GateError::None);
 const auto next=frame(2,1448);FakeTls fresh;fresh.feed(next);pumpAvailable(gate,fresh);assert(consume(gate,true,true)==next);
 for(unsigned i=0;i<32;++i){auto large=frame(1,4096);fresh.feed(large);pumpAvailable(gate,fresh);assert(consume(gate)==large);}
 std::puts("PASS close-midframe reset, complete buffered frame after EOF, overflow-buffer reuse");
}
void gateTests(){splitFrames();delayedTail();sequence();invalidHeaders();disconnectAndReuse();}
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-upstream',action='store_true')
    parser.add_argument('--upstream-only',action='store_true')
    args=parser.parse_args()
    source=upstream_source(args.require_upstream or args.upstream_only)
    code=CPP_COMMON+upstream_consumer(source)
    if source:
        code+='\n#define S1_HAVE_UPSTREAM 1\n'
    if not args.upstream_only:
        if not (ROOT/'bots/CardputerADV/src/realtime_frame_gate.h').is_file():
            raise SystemExit('Frame gate helper missing from this source checkout.')
        code+=CPP_GATE
    code+='\nint main(){'
    if source:
        code+='negativeControl();'
    if not args.upstream_only:
        code+='gateTests();'
    code+='}\n'
    with tempfile.TemporaryDirectory(prefix='s1-rt-frame-gate-') as directory:
        cpp=Path(directory)/'test.cpp';cpp.write_text(code)
        binary=Path(directory)/'test'
        subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',
                        '-I',str(ROOT/'bots/CardputerADV/src'),str(cpp),'-o',str(binary)],check=True)
        subprocess.run([str(binary)],check=True)
    if source:
        print(json.dumps({'upstream_version':'2.7.3','source_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}))
    else:
        print('SKIP upstream negative/consumer control: PlatformIO dependency not installed; gate tests still executed.')


if __name__=='__main__':
    main()
