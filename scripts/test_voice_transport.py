#!/usr/bin/env python3
"""Fault-inject the actual RAM/SD writers, including the observed fragmented heap."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'
source = (parts / '034_main.cpp.inc').read_text()
stage = source[:source.index('bool writeClientAll(WiFiClient& client, const String&')]
writers = source[source.index('bool writeClientAllStaged('):source.index('bool connectHubClient(')]
constant = re.search(r'constexpr size_t kHttpStageChunkBytes = [^;]+;', (parts / '001_main.cpp.inc').read_text()).group()
code = r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <new>
#include <memory>
#include <string>
#include <vector>
#include <algorithm>
using std::min;
// The device had 62 KB free but its largest contiguous block was 16,372 B.
// Limit all nothrow array allocations while the body is being sent. The old
// 16,384 B allocation fails here, even with a perfectly connected socket.
bool fragmented=false;size_t allocationsDuringBody=0;
void* operator new[](size_t n,const std::nothrow_t&) noexcept {
 if(fragmented){++allocationsDuringBody;if(n>16372)return nullptr;}return std::malloc(n);
}
struct String:std::string {
 using std::string::string;String(const std::string& s):std::string(s){}
 String(unsigned n):std::string(std::to_string(n)){}
};
uint32_t now=0,step=1,loseWifiAt=0;uint8_t gVoiceRequestProgress=0;
uint32_t millis(){return now;}
constexpr int WL_CONNECTED=3;
struct {int status(){return loseWifiAt&&now>=loseWifiAt?0:WL_CONNECTED;}} WiFi;
void pumpBlockingNetworkUi(){now+=step;}
String diag;
void setHttpDiag(String text){diag=text;}
void setStatus(String){}void logf(const char*,...){}
struct WiFiClient {
 std::vector<uint8_t> output;size_t maxWrite=1023,disconnectAt=SIZE_MAX;
 int calls=0;bool stall=false,intermittent=false;
 bool connected(){return output.size()<disconnectAt;}
 size_t write(const uint8_t* p,size_t n){
  ++calls;if(stall||(intermittent&&calls%5==0))return 0;
  n=min(n,min(maxWrite,disconnectAt-output.size()));
  output.insert(output.end(),p,p+n);return n;
 }
};
struct File {
 const std::vector<uint8_t>& saved;size_t pos=0,maxRead=1031;
 size_t read(uint8_t* out,size_t n){n=min(n,min(maxRead,saved.size()-pos));
  memcpy(out,saved.data()+pos,n);pos+=n;return n;}
};
'''
code += constant + '\n' + stage + '\n' + writers
code += r'''
void reset(){now=0;step=1;loseWifiAt=0;diag="";gVoiceRequestProgress=0;assert(!gHttpStageInUse);}
bool send(bool file,WiFiClient& client,const std::vector<uint8_t>& data,size_t advertised=0){
 File saved{data};fragmented=true;
 bool ok=file?writeClientAllFileStaged(client,saved,advertised?advertised:data.size(),"voice_body"):
  writeClientAllStaged(client,data.data(),data.size(),"voice_body");
 fragmented=false;assert(!gHttpStageInUse);return ok;
}
int main(){
 fragmented=true;auto* oldStage=new(std::nothrow)uint8_t[16384];assert(!oldStage);
 fragmented=false;allocationsDuringBody=0;
 for(size_t bytes:{size_t(1),size_t(4095),size_t(4096),size_t(4097),size_t(8192),size_t(749612)}){
  std::vector<uint8_t> audio(bytes);for(size_t i=0;i<bytes;++i)audio[i]=uint8_t(i*17+3);
  for(bool file:{false,true}){
   reset();WiFiClient c;c.output.reserve(bytes);c.intermittent=true;
   assert(send(file,c,audio)&&c.output==audio&&gVoiceRequestProgress==100);
  }
 }
 assert(allocationsDuringBody==0); // Never allocate the staging buffer after TLS.
 const std::vector<uint8_t> saved(749612,0x5a),original=saved;
 for(bool file:{false,true}){
  reset();step=1000;WiFiClient stalled;stalled.stall=true;
  assert(!send(file,stalled,saved)&&now<=7000&&stalled.output.empty());
  reset();WiFiClient disconnected;disconnected.disconnectAt=8192;
  assert(!send(file,disconnected,saved)&&disconnected.output.size()==8192);
  reset();loseWifiAt=3;WiFiClient lost;
  assert(!send(file,lost,saved)&&now<=3);
  reset();WiFiClient good;good.output.reserve(saved.size());
  assert(send(file,good,saved)&&good.output==saved); // Error released the lease.
 }
 reset();WiFiClient shortFile;assert(!send(true,shortFile,saved,saved.size()+44));
 assert(shortFile.output==saved&&saved==original); // Failure cannot delete/alter the note.
 reset();WiFiClient c;File file{saved};
 {HttpStageLease outer;assert(outer);assert(!writeClientAllFileStaged(c,file,saved.size(),"voice_body"));
  assert(file.pos==0&&c.output.empty()&&gHttpStageInUse);}
 assert(!gHttpStageInUse&&kHttpStageChunkBytes<=4096);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-transport-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual RAM/SD body writers: 749612 bytes with fragmented heap, partial I/O, stalls, disconnect, Wi-Fi loss, short file and lease recovery')
