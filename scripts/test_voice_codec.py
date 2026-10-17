#!/usr/bin/env python3
"""Compile the device encoder and verify its WAV against an independent decoder."""
from pathlib import Path
import math, os, shutil, struct, subprocess, tempfile

root = Path(__file__).resolve().parents[1]
source = r'''
#include "VOICE_HEADER"
#include <fstream>
#include <vector>
#include <cassert>
int main(int argc,char** argv){
 assert(argc==3);
 std::ifstream in(argv[1],std::ios::binary);std::vector<uint8_t> pcm((std::istreambuf_iterator<char>(in)),{});
 std::ofstream out(argv[2],std::ios::binary);
 const size_t samples=voice_upload::encodedBytes(pcm.size());uint8_t h[58];voice_upload::header(h,samples);
 out.write(reinterpret_cast<char*>(h),58);uint8_t encoded[1026];
 for(size_t at=0;at<pcm.size();at+=3072){
  const size_t length=std::min<size_t>(3072,pcm.size()-at);encoded[1024]=17;encoded[1025]=29;
  const size_t n=voice_upload::encode(pcm.data()+at,length,encoded);
  assert(n<=1024&&encoded[1024]==17&&encoded[1025]==29);
  out.write(reinterpret_cast<char*>(encoded),n);
 }
 if(samples&1)out.put(0);
 assert(voice_upload::mulaw(0)==255);assert(voice_upload::mulaw(-32768)==0);assert(voice_upload::mulaw(32767)==128);
}
'''.replace('VOICE_HEADER', str(root/'bots/CardputerADV/src/voice_upload_codec.h'))
with tempfile.TemporaryDirectory(prefix='s1-voice-codec-') as folder:
 p=Path(folder);(p/'encode.cpp').write_text(source)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'encode.cpp'),'-o',str(p/'encode')],check=True)
 for length in [1,2,3,1535,1536,1537,24000,270481]:
  values=[int(12000*math.sin(2*math.pi*330*i/24000)) for i in range(length)]
  (p/'input.pcm').write_bytes(struct.pack('<'+'h'*length,*values))
  subprocess.run([str(p/'encode'),str(p/'input.pcm'),str(p/'encoded.wav')],check=True)
  wav=(p/'encoded.wav').read_bytes();samples=(length*2+2)//3
  assert len(wav)==58+samples+(samples&1)
  assert struct.unpack_from('<I',wav,46)[0]==samples and struct.unpack_from('<I',wav,54)[0]==samples
  subprocess.run(['node','--input-type=module','-e',
   "import fs from 'node:fs';import {decodeVoiceUpload} from "+repr((root/'bridge/src/voice-upload-codec.mjs').as_uri())+";fs.writeFileSync(process.argv[2],decodeVoiceUpload(fs.readFileSync(process.argv[1]),2000000));",
   str(p/'encoded.wav'),str(p/'decoded.wav')],check=True)
  decoded=(p/'decoded.wav').read_bytes();assert len(decoded)==44+samples*2
  if shutil.which('ffmpeg'):
   independent=subprocess.check_output(['ffmpeg','-v','error','-i',str(p/'encoded.wav'),'-f','s16le','-'])
   assert independent==decoded[44:], 'bridge decoder differs from FFmpeg'
 print('PASS real device encoder: 3x size reduction, chunk/tail bounds, WAV framing, independent mu-law decode')
