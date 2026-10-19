#!/usr/bin/env python3
"""Compile the actual voice POST against failed/prepared worker and SD fixtures.

No network/device/provider is contacted. The clock and worker result are
injected; the routing, guards and cleanup are the production C++ function.
Use --baseline-ref ef29c84197b3cbf3dc14e4100960afcfce5fafc6 for the actual
0.2.181 negative control when that commit is available in the local clone.
"""
import argparse
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'bots/CardputerADV/src/main_parts/035_main.cpp.inc'


def extract_post(text):
    start = text.index('bool postRawVoiceTurn(')
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


CPP_FIXTURES = r'''
#include "reply_connection.h"
#include "network_recovery.h"
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>
class String {
 public:
  std::string value;
  String()=default;
  String(const char* s):value(s?s:""){}
  String(std::string s):value(std::move(s)){}
  template<class T, std::enable_if_t<std::is_integral_v<T>,int> = 0>
  String(T n):value(std::to_string(n)){}
  bool isEmpty()const{return value.empty();}
  const char* c_str()const{return value.c_str();}
  size_t length()const{return value.size();}
  void reserve(size_t n){value.reserve(n);}
  String& operator+=(const String& s){value+=s.value;return *this;}
};
String operator+(const String& a,const String& b){return String(a.value+b.value);}
enum class Worker { Failed, Busy, Disconnected, Ready };
struct SocketStats {unsigned stops=0,destructs=0,noDelay=0;};
struct Fixture {
 Worker worker=Worker::Failed;
 uint32_t now=0,workerDelay=4000,uiPumps=0;
 bool wifi=true,tls=true,ownsPerf=true,fs=true,file=true;
 bool writeHeaders=true,writeBody=true,parseHeaders=true,readBody=true;
 int statusCode=200,contentLength=-2;
 unsigned perfBegin=0,perfEnd=0,starts=0,takes=0,dials=0;
 unsigned headerWrites=0,fileWrites=0,ramWrites=0,parses=0,bodyReads=0;
 unsigned opens=0,closes=0,removes=0,restores=0;
 SocketStats prepared,stack;
 std::vector<uint8_t> recording,delivered;
 std::string openedPath,headers,diag,response="{\"reply\":\"Four\"}";
};
Fixture fixture;
class WiFiClient {
 public:
  SocketStats* stats;
  bool online;
  explicit WiFiClient(SocketStats* s=nullptr,bool connected=false):stats(s?s:&fixture.stack),online(connected){}
  virtual ~WiFiClient(){++stats->destructs;}
  virtual bool connected(){return online;}
  virtual int connect(const char*,uint16_t){++fixture.dials;fixture.now+=18500;return 0;}
  void setTimeout(uint32_t){}
  void setNoDelay(bool){++stats->noDelay;}
  void stop(){++stats->stops;online=false;}
};
class WiFiClientSecure:public WiFiClient {};
reply_connection::OneShot<WiFiClient> gVoiceReplyConnection;
network_recovery::Policy gNetworkRecovery;
extern bool gVoicePreconnectEarly;
void cancelVoicePreconnect(){gVoicePreconnectEarly=false;gVoiceReplyConnection.clear();}
class File {
 public:
  bool valid=false;
  File()=default;
  explicit File(bool v):valid(v){}
  explicit operator bool()const{return valid;}
  void close(){assert(valid);++fixture.closes;valid=false;}
};
namespace fs {class FS {
 public:
  File open(const String& path,const char*){++fixture.opens;fixture.openedPath=path.value;return File(fixture.file);}
  bool remove(const String&){++fixture.removes;fixture.recording.clear();return true;}
};}
fs::FS filesystem;
bool gVoiceDialBusy=false,gVoiceReplySpeechBusy=false,gVoiceNoticeVisible=true,gCanvasSpriteActive=true,gVoicePreconnectEarly=false;
String gHubHost="bridge.invalid",gDeviceId="test-device",gDeviceToken="fixture-token";
uint16_t gHubPort=443;
constexpr unsigned kMicSampleRate=16000,kTtsDefaultSampleRate=24000,kTurnHttpTimeoutMs=65000;
constexpr const char* kDeviceAudioTurnRawPath="/api/device-audio-turn-raw";
constexpr const char* kAppVersion="test";
constexpr int MALLOC_CAP_8BIT=0;
struct Esp {unsigned getFreeHeap(){return 64000;}} ESP;
unsigned heap_caps_get_largest_free_block(int){return 32000;}
unsigned long millis(){return fixture.now;}
template<class... T> void logf(const char*,T...){}
bool beginVoiceWifiPerformance(){++fixture.perfBegin;return fixture.ownsPerf;}
void endVoiceWifiPerformance(){++fixture.perfEnd;}
bool ensureWifiForHttp(const char*,unsigned){return fixture.wifi;}
void setHttpDiag(const String& value){fixture.diag=value.value;}
void setStatus(const String&){}
void render(){}
void clearEmojiCache(){}
bool hubUsesTls(){return fixture.tls;}
bool releaseUiCanvasForNetwork(const char*){gCanvasSpriteActive=false;return true;}
void restoreUiCanvasAfterNetwork(){++fixture.restores;gCanvasSpriteActive=true;}
void configureSecureClient(WiFiClientSecure&){}
const char* tlsVerifyMode(){return "fixture";}
void beginVoicePreconnect(){++fixture.starts;gVoiceDialBusy=true;}
std::unique_ptr<WiFiClient> takeVoicePreconnect(){
 ++fixture.takes;fixture.now+=fixture.workerDelay;fixture.uiPumps+=fixture.workerDelay/10;
 gVoiceDialBusy=fixture.worker==Worker::Busy;
 if(fixture.worker==Worker::Ready || fixture.worker==Worker::Disconnected)
  return std::make_unique<WiFiClient>(&fixture.prepared,fixture.worker==Worker::Ready);
 return nullptr;
}
String currentConversationKey(){return "fixture-conversation";}
bool writeClientAll(WiFiClient&,const String& headers,const char*){
 ++fixture.headerWrites;fixture.headers=headers.value;return fixture.writeHeaders;
}
fs::FS* activeVoiceFs(){return fixture.fs?&filesystem:nullptr;}
bool writeClientAllFileStaged(WiFiClient&,File& file,size_t count,const char*){
 assert(file.valid);++fixture.fileWrites;assert(count<=fixture.recording.size());
 if(fixture.writeBody)fixture.delivered.assign(fixture.recording.begin(),fixture.recording.begin()+count);
 return fixture.writeBody;
}
bool writeClientAllStaged(WiFiClient&,const uint8_t* data,size_t count,const char*){
 ++fixture.ramWrites;assert(data);if(fixture.writeBody)fixture.delivered.assign(data,data+count);
 return fixture.writeBody;
}
enum class VoiceRequestPhase {Idle,Processing};
VoiceRequestPhase gVoiceRequestPhase=VoiceRequestPhase::Idle;
bool parseHttpStatusAndHeaders(WiFiClient&,int& status,int& length,uint32_t&,uint32_t){
 ++fixture.parses;if(!fixture.parseHeaders)return false;
 status=fixture.statusCode;length=fixture.contentLength==-2?int(fixture.response.size()):fixture.contentLength;return true;
}
bool readHttpResponseBody(WiFiClient&,int,String& response,uint32_t){
 ++fixture.bodyReads;response=fixture.response;return fixture.readBody;
}
void reset(Worker worker=Worker::Failed){
 gVoiceReplyConnection.clear();gVoicePreconnectEarly=false;
 fixture=Fixture{};fixture.worker=worker;gVoiceDialBusy=gVoiceReplySpeechBusy=false;
 gVoiceNoticeVisible=gCanvasSpriteActive=true;gVoiceRequestPhase=VoiceRequestPhase::Idle;
 gHubHost="bridge.invalid";gHubPort=443;
 fixture.recording.resize(32044);
 for(size_t i=0;i<fixture.recording.size();++i)fixture.recording[i]=static_cast<uint8_t>(i*17);
}
bool invoke(bool file=true,bool wav=true){
 int status=789;String response="stale";
 const bool result=postRawVoiceTurn(file?nullptr:fixture.recording.data(),file?String("/voice/retained.wav"):String(),
                                  32000,"fixture-turn",status,response,file&&wav);
 if(result){assert(status==fixture.statusCode);assert(response.value==fixture.response);}
 else {assert(status==-1);assert(response.isEmpty());}
 assert(fixture.perfBegin==1 && fixture.perfEnd==(fixture.ownsPerf?1U:0U));
 assert(fixture.removes==0 && fixture.recording.size()==32044);
 return result;
}
'''

# The invoker uses a declaration so that the production function body, including
# its own default argument, is inserted without changing it.
DECLARATION = '''
bool postRawVoiceTurn(const uint8_t*,const String&,size_t,const String&,int&,String&,bool);
'''

CPP_TESTS = r'''
void noSideEffects(){
 assert(fixture.dials==0 && fixture.headerWrites==0 && fixture.fileWrites==0 && fixture.ramWrites==0);
 assert(fixture.parses==0 && fixture.bodyReads==0 && fixture.opens==0 && fixture.closes==0);
 assert(fixture.delivered.empty());
}
void failureTests(){
 for(const bool tls:{true,false}){
  for(const Worker mode:{Worker::Failed,Worker::Busy,Worker::Disconnected}){
   reset(mode);fixture.tls=tls;
   const auto original=fixture.recording;
   assert(!invoke());noSideEffects();assert(fixture.recording==original);
   assert(fixture.now==4000 && fixture.uiPumps==400);
   assert(fixture.starts==1 && fixture.takes==1);
   if(mode==Worker::Busy)assert(fixture.diag.find("still preparing")!=std::string::npos);
   else assert(fixture.diag.find("bridge connection unavailable")!=std::string::npos);
  }
 }
 std::puts("PASS actual POST rejects failed/busy/disconnected worker, no fallback dial/upload/delete; fixture delay 4000 ms only");
}
void successTests(){
 for(const bool tls:{true,false}){
  for(const bool file:{true,false}){
   reset(Worker::Ready);fixture.tls=tls;gHubPort=tls?8443:8080;
   const auto original=fixture.recording;
   assert(invoke(file));assert(fixture.now==4000 && fixture.dials==0);
   assert(fixture.headerWrites==1 && fixture.parses==1 && fixture.bodyReads==1);
   assert(fixture.fileWrites==(file?1U:0U) && fixture.ramWrites==(file?0U:1U));
   assert(fixture.prepared.stops==0 && fixture.prepared.destructs==0);
   assert(fixture.headers.find("Connection: keep-alive\r\n")!=std::string::npos);
   auto kept=gVoiceReplyConnection.take(gHubHost.c_str(),gHubPort,fixture.now);
   assert(kept && kept->connected() && gVoiceReplyConnection.empty());
   kept->stop();kept.reset();
   assert(fixture.prepared.stops==1 && fixture.prepared.destructs==1);
   assert(fixture.prepared.noDelay==1 && fixture.recording==original);
   const size_t bytes=file?32044:32000;
   assert(fixture.delivered==std::vector<uint8_t>(original.begin(),original.begin()+bytes));
   assert(fixture.headers.find("Content-Length: "+std::to_string(bytes)+"\r\n")!=std::string::npos);
   assert(fixture.headers.find(std::string("Content-Type: ")+(file?"audio/wav":"application/octet-stream"))!=std::string::npos);
   assert(fixture.headers.find("X-Turn-Id: fixture-turn\r\n")!=std::string::npos);
   assert(fixture.headers.find("Host: bridge.invalid:"+std::to_string(gHubPort))!=std::string::npos);
   assert(fixture.opens==(file?1U:0U) && fixture.closes==(file?1U:0U));
   if(file)assert(fixture.openedPath=="/voice/retained.wav");
   assert(gVoiceRequestPhase==VoiceRequestPhase::Processing);
  }
 }
 std::puts("PASS actual POST uploads identical WAV/RAM bytes once, parses reply and transfers the socket once to same-origin TTS");
}
void cleanupTests(){
 for(unsigned fault=0;fault<5;++fault){
  reset(Worker::Ready);
  if(fault==0)fixture.writeHeaders=false;
  if(fault==1)fixture.fs=false;
  if(fault==2)fixture.file=false;
  if(fault==3)fixture.writeBody=false;
  if(fault==4)fixture.parseHeaders=false;
  const auto original=fixture.recording;
  assert(!invoke());assert(fixture.dials==0 && fixture.recording==original);
  assert(fixture.prepared.stops==1 && fixture.prepared.destructs==1);
  assert(fixture.bodyReads==0);
  if(fault==0)assert(fixture.fileWrites==0 && fixture.opens==0);
  if(fault==1 || fault==2)assert(fixture.fileWrites==0 && fixture.closes==0);
  if(fault==3 || fault==4)assert(fixture.fileWrites==1 && fixture.closes==1);
 }
 reset();fixture.wifi=false;assert(!invoke());assert(fixture.starts==0);noSideEffects();
 reset();gVoiceReplySpeechBusy=true;assert(!invoke());assert(fixture.starts==0);noSideEffects();
 reset();fixture.ownsPerf=false;assert(!invoke());noSideEffects();
 std::puts("PASS HTTP/SD failure cleanup retains recording and restores owned Wi-Fi performance on every tested return");
}
void earlyAndReuseGuards(){
 for(auto worker:{Worker::Ready,Worker::Failed,Worker::Busy,Worker::Disconnected}){
  reset(worker);gVoicePreconnectEarly=true;fixture.workerDelay=0;
  assert(invoke()==(worker==Worker::Ready));
  assert(fixture.starts==0 && fixture.takes==1 && fixture.dials==0 && !gVoicePreconnectEarly);
 }
 for(int fault=0;fault<3;++fault){
  reset(Worker::Ready);
  if(fault==0)fixture.readBody=false;
  if(fault==1)fixture.contentLength=-1;
  if(fault==2)fixture.statusCode=503;
  assert(invoke());assert(gVoiceReplyConnection.empty());
  assert(fixture.prepared.stops==1 && fixture.prepared.destructs==1);
 }
 std::puts("PASS early worker is consumed without a second dial, and incomplete/unknown-length/error responses never retain a socket");
}
int main(){failureTests();successTests();cleanupTests();earlyAndReuseGuards();}
'''

CPP_NEGATIVE = r'''
int main(){
 reset(Worker::Failed);const auto original=fixture.recording;
 assert(!invoke());assert(fixture.now==4000+18500 && fixture.dials==1);
 assert(fixture.headerWrites==0 && fixture.fileWrites==0 && fixture.ramWrites==0);
 assert(fixture.recording==original);
 std::puts("NEGATIVE CONTROL actual 0.2.181 POST: failed worker 4000 ms + synchronous fallback 18500 ms = 22500 ms in fixture");
}
'''


def run_case(source, tests):
    # Insert a forward declaration before the fixture invoker, then compile the
    # extracted source unmodified; do not duplicate its branching in the test.
    split = CPP_FIXTURES.index('bool invoke(')
    code = CPP_FIXTURES[:split] + DECLARATION + CPP_FIXTURES[split:] + source + tests
    with tempfile.TemporaryDirectory(prefix='s1-voice-connect-') as directory:
        cpp = Path(directory) / 'test.cpp'
        binary = Path(directory) / 'test'
        cpp.write_text(code)
        subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        '-I', str(ROOT / 'bots/CardputerADV/src'), str(cpp), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', help='Optional available Git ref for the old actual POST negative control')
    args = parser.parse_args()
    if args.baseline_ref:
        baseline = subprocess.run(['git', 'show', f'{args.baseline_ref}:{SOURCE}'], cwd=ROOT,
                                  check=True, capture_output=True, text=True).stdout
        run_case(extract_post(baseline), CPP_NEGATIVE)
    run_case(extract_post((ROOT / SOURCE).read_text()), CPP_TESTS)


if __name__ == '__main__':
    main()
