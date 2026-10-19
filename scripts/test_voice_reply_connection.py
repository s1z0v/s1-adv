#!/usr/bin/env python3
"""Exercise actual one-shot ownership and the actual speech worker offline.

The HTTP fixture deliberately models Arduino 2.0.14's closed-client behavior:
end() does not detach its raw client pointer when connected() is false. A
destructor touching a deleted external client is therefore a failing test.
Its URL overload also models beginInternal's initial empty-host comparison:
an attached connected client is stopped before the parsed origin is assigned.
The explicit-origin overload avoids that branch (Arduino HTTPClient.cpp
177-196 versus 300-305). These are offline library-behavior fixtures.
Production structures/functions are extracted unchanged, not reimplemented.
No network, audio device, credentials, or persistent recordings are touched.
"""
import argparse
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'bots/CardputerADV/src/main_parts/065_main.cpp.inc'


def extract(text, signature, structure=False):
    start = text.index(signature)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    if structure:
        end = text.index(';', end) + 1
    return text[start:end]


CPP_FIXTURES = r'''
#include "reply_connection.h"
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <string>
#include <vector>
using std::min;
class String {
 public:
  std::string value;
  String()=default;String(const char* s):value(s?s:""){}String(std::string s):value(std::move(s)){}
  bool isEmpty()const{return value.empty();}
  bool startsWith(const char* s)const{return value.rfind(s,0)==0;}
  const char* c_str()const{return value.c_str();}
  long toInt()const{try{return std::stol(value);}catch(...){return 0;}}
};
String operator+(const String& a,const String& b){return String(a.value+b.value);}
constexpr uint32_t kTtsDefaultSampleRate=24000;
constexpr const char* kTlsRootCaPem="fixture-reviewed-root";
uint32_t gVoiceReplySpeechGeneration=10;
struct Reply {
 int code=200,expected=6;
 std::vector<uint8_t> bytes={1,2,3,4,5,6};
 String rate="24000";
 bool beginOk=true,holdOpen=false,stall=false,readError=false;
 size_t maxRead=4096;
};
struct ClientState {
 unsigned id=0;bool alive=true,online=false,secure=false,ca=false;
 size_t offset=0;int reply=-1;unsigned stops=0;
};
struct Fixture {
 uint32_t now=100;
 bool wifi=true,cancelBegin=false,cancelPost=false,cancelRead=false,cancelled=false,sizeMismatch=false;
 size_t writeLimit=std::numeric_limits<size_t>::max();
 unsigned created=0,destroyed=0,httpCreated=0,httpDestroyed=0,posts=0,dials=0,reads=0;
 unsigned urlBegins=0,explicitBegins=0;
 std::map<const void*,ClientState> clients;
 std::vector<Reply> replies={Reply{}};
 std::vector<std::string> bodies,urls,trace;
 std::vector<std::pair<std::string,std::string>> headers;
 std::vector<std::pair<unsigned,unsigned>> bindings;
};
Fixture f;
void cancel(){if(!f.cancelled){++gVoiceReplySpeechGeneration;f.cancelled=true;}}
class WiFiClient {
 public:
  explicit WiFiClient(bool online=false){f.clients[this]={++f.created,true,online,false,false,0,-1,0};}
  virtual ~WiFiClient(){auto& s=state();f.trace.push_back("client.destroy:"+std::to_string(s.id));s.alive=false;++f.destroyed;}
  ClientState& state()const{
   auto found=f.clients.find(this);
   assert(found!=f.clients.end() && "Unknown external HTTP client");
   assert(found->second.alive && "HTTP accessed client after external owner destroyed it");
   return found->second;
  }
  bool connected(){auto& s=state();return s.online;}
  int available(){
   auto& s=state();if(s.reply<0)return 0;
   const auto& reply=f.replies.at(s.reply);
   if(reply.code<0 || reply.stall)return 0;
   return static_cast<int>(reply.bytes.size()-s.offset);
  }
  int read(uint8_t* out,size_t count){
   auto& s=state();auto& reply=f.replies.at(s.reply);++f.reads;
   if(reply.readError){s.online=false;return -1;}
   count=min({count,reply.maxRead,reply.bytes.size()-s.offset});
   std::memcpy(out,reply.bytes.data()+s.offset,count);s.offset+=count;
   if(s.offset==reply.bytes.size() && !reply.holdOpen)s.online=false;
   if(f.cancelRead)cancel();
   return static_cast<int>(count);
  }
  void stop(){auto& s=state();++s.stops;s.online=false;f.trace.push_back("client.stop:"+std::to_string(s.id));}
  void flush(){auto& s=state();if(s.reply>=0)s.offset=f.replies.at(s.reply).bytes.size();}
};
class WiFiClientSecure:public WiFiClient {
 public:
  WiFiClientSecure(){state().secure=true;}
  void setCACert(const char* ca){assert(std::strcmp(ca,kTlsRootCaPem)==0);state().ca=true;}
  void setHandshakeTimeout(unsigned seconds){assert(seconds==12);}
};
class HTTPClient {
 WiFiClient* client_=nullptr;
 unsigned index_=0,id_=0;
 String host_;
 void attach(WiFiClient& client){client_=&client;f.bindings.emplace_back(id_,client_->state().id);}
 bool finishBegin(const std::string& url){
  f.urls.push_back(url);if(f.cancelBegin)cancel();return f.replies.at(index_).beginOk;
 }
 public:
  HTTPClient():index_(f.httpCreated),id_(++f.httpCreated){f.trace.push_back("http.new:"+std::to_string(id_));}
  ~HTTPClient(){
   // Same lifetime-relevant behavior as the installed Arduino destructor.
   if(client_)client_->stop();
   ++f.httpDestroyed;f.trace.push_back("http.destroy:"+std::to_string(id_));
  }
  void setConnectTimeout(int value){assert(value==4000);}
  void setTimeout(unsigned value){assert(value==20000);}
  void setReuse(bool value){assert(!value);}
  bool begin(WiFiClient& client,const String& url){
   ++f.urlBegins;attach(client);
   const auto scheme=url.value.find("://");assert(scheme!=std::string::npos);
   const auto start=scheme+3,end=url.value.find('/',start);
   const std::string authority=url.value.substr(start,end-start);
   const std::string host=authority.substr(0,authority.find(':'));
   // Arduino begin(client,url) sets _client first; beginInternal sees the
   // initially empty _host as a host switch and calls disconnect(true).
   if(host_.value!=host && connected()){
    if(client_->available()>0)client_->flush();
    client_->stop(); // preserveClient=true keeps the external pointer attached.
   }
   host_=host;
   return finishBegin(url.value);
  }
  bool begin(WiFiClient& client,const String& host,uint16_t port,const String& path,bool https){
   ++f.explicitBegins;attach(client);
   // The actual five-argument overload assigns origin fields directly; it
   // does not run beginInternal's host-change/disconnect branch.
   assert(!host.isEmpty() && path.startsWith("/"));host_=host;
   std::string url=(https?"https://":"http://")+host.value;
   if(port!=(https?443:80))url+=":"+std::to_string(port);
   return finishBegin(url+path.value);
  }
  void collectHeaders(const char** names,size_t count){assert(count==1 && std::string(names[0])=="X-Audio-Sample-Rate");}
  void addHeader(const char* name,const String& value){f.headers.emplace_back(name,value.value);}
  int POST(const String& body){
   assert(client_);auto& s=client_->state();auto& reply=f.replies.at(index_);
   ++f.posts;f.bodies.push_back(body.value);
   if(!s.online){++f.dials;if(s.secure)assert(s.ca && "Fresh HTTPS must use reviewed CA");s.online=true;}
   s.reply=index_;s.offset=0;if(reply.code<0)s.online=false;
   f.now+=13;if(f.cancelPost)cancel();return reply.code;
  }
  String header(const char* name){assert(std::string(name)=="X-Audio-Sample-Rate");return f.replies.at(index_).rate;}
  int getSize(){return f.replies.at(index_).expected;}
  WiFiClient* getStreamPtr(){return client_;}
  bool connected(){return client_ && (client_->available()>0 || client_->connected());}
  void end(){
   f.trace.push_back("http.end:"+std::to_string(id_));
   // Arduino disconnect(false) leaves _client intact when already closed.
   if(connected()){if(client_->available()>0)client_->flush();client_->stop();client_=nullptr;}
  }
};
class File;
namespace fs {
struct FS {
 std::string name;
 bool canOpen=true;
 unsigned opens=0,closes=0,flushes=0;
 std::map<std::string,std::vector<uint8_t>> files;
 std::vector<std::string> removed;
 explicit FS(const char* n):name(n){}
 ::File open(const String&,const char*);
};
}
class File {
 fs::FS* fs_=nullptr;std::string path_;bool open_=false;
 public:
  File()=default;
  File(fs::FS* fs,const String& path):fs_(fs),path_(path.value),open_(fs&&fs->canOpen){if(open_)fs_->files[path_].clear();}
  File(const File&)=delete;File& operator=(const File&)=delete;
  File(File&& other):fs_(other.fs_),path_(std::move(other.path_)),open_(other.open_){other.open_=false;}
  ~File(){close();}
  explicit operator bool()const{return open_;}
  size_t write(const uint8_t* bytes,size_t count){
   if(!open_)return 0;count=min(count,f.writeLimit);
   auto& out=fs_->files[path_];out.insert(out.end(),bytes,bytes+count);return count;
  }
  void flush(){if(open_)++fs_->flushes;}
  size_t size()const{if(!open_)return 0;const size_t n=fs_->files.at(path_).size();return f.sizeMismatch&&n?n-1:n;}
  void close(){if(open_){++fs_->closes;open_=false;}}
};
'''

CPP_FS = r'''
namespace fs {
File FS::open(const String& path,const char* mode){assert(std::string(mode)=="w");++opens;return File(this,path);}
}
fs::FS primary("primary"),secondary("secondary");
void fsRemove(fs::FS& fs,const String& path){fs.removed.push_back(path.value);fs.files.erase(path.value);}
size_t writeRecordedBytes(File& file,const uint8_t* bytes,size_t count){return file.write(bytes,count);}
constexpr int WL_CONNECTED=3;
struct Wifi {int status(){return f.wifi?WL_CONNECTED:0;}} WiFi;
uint32_t millis(){return f.now;}
void delay(unsigned ms){f.now+=ms;}
void reset(){
 assert(f.created==f.destroyed && f.httpCreated==f.httpDestroyed);
 f=Fixture{};gVoiceReplySpeechGeneration=10;
 primary=fs::FS("primary");secondary=fs::FS("secondary");
 for(auto* fs:{&primary,&secondary}){
  fs->files["/voice/retained.wav"]={91,92,93};
  fs->files["/voice/__reply_11.pcm"]={81,82};
 }
}
void assertClean(){
 assert(f.created==f.destroyed && f.httpCreated==f.httpDestroyed);
 for(const auto& binding:f.bindings){
  const auto http=std::find(f.trace.begin(),f.trace.end(),"http.destroy:"+std::to_string(binding.first));
  const auto client=std::find(f.trace.begin(),f.trace.end(),"client.destroy:"+std::to_string(binding.second));
  assert(http!=f.trace.end() && client!=f.trace.end() && http<client);
 }
 for(auto* fs:{&primary,&secondary}){
  assert(fs->files.at("/voice/retained.wav")==std::vector<uint8_t>({91,92,93}));
  assert(fs->files.at("/voice/__reply_11.pcm")==std::vector<uint8_t>({81,82}));
  for(const auto& removed:fs->removed)assert(removed=="/voice/__reply_10.pcm");
 }
}
'''

CPP_TESTS = r'''
using Handoff=reply_connection::OneShot<WiFiClient>;
std::unique_ptr<VoiceSpeechResult> invoke(bool kept=true,bool fallback=false,size_t limit=8192){
 auto payload=std::make_unique<VoiceSpeechPayload>();
 payload->url="https://fixture.invalid/api/device-tts";payload->token="fixture-token";
 payload->host="fixture.invalid";payload->port=443;payload->requestPath="/api/device-tts";
 payload->body="{\"text\":\"Four\"}";payload->path="/voice/__reply_10.pcm";
 payload->fs=&primary;payload->fallbackFs=fallback?&secondary:nullptr;
 payload->maxBytes=limit;payload->generation=10;
 if(kept){
  auto secure=std::make_unique<WiFiClientSecure>();secure->setCACert(kTlsRootCaPem);
  secure->state().online=true;payload->connection=std::move(secure);
 }
 auto result=std::unique_ptr<VoiceSpeechResult>(performVoiceReplySpeech(payload.release()));
 assert(result && result->generation==10 && result->path.value=="/voice/__reply_10.pcm");
 assertClean();return result;
}
void handoffOwnership(){
 reset();
 {
  Handoff cache;auto client=std::make_unique<WiFiClient>(true);auto* identity=client.get();
  assert(cache.retain(std::move(client),"fixture.invalid",443,0) && !client && !cache.empty());
  auto taken=cache.take("fixture.invalid",443,4999);assert(taken.get()==identity && cache.empty());
  assert(!cache.take("fixture.invalid",443,4999));
 }
 assertClean();
 reset();{
  Handoff cache;auto client=std::make_unique<WiFiClient>(true);auto* identity=client.get();
  std::string host="fixture.invalid";assert(cache.retain(std::move(client),host.c_str(),443,0));
  host="changed.invalid";auto taken=cache.take("fixture.invalid",443,1);assert(taken.get()==identity);
 }assertClean();
 reset();{
  Handoff cache;const std::string host(253,'a');
  assert(cache.retain(std::make_unique<WiFiClient>(true),host.c_str(),443,0));
  auto taken=cache.take(host.c_str(),443,1);assert(taken);
 }assertClean();
 for(unsigned mode=0;mode<5;++mode){
  reset();Handoff cache;assert(cache.retain(std::make_unique<WiFiClient>(true),"fixture.invalid",443,0));
  if(mode==0)assert(!cache.take("other.invalid",443,1));
  if(mode==1)assert(!cache.take("fixture.invalid",80,1));
  if(mode==2)assert(!cache.take(nullptr,443,1));
  if(mode==3)assert(!cache.take("fixture.invalid",443,5000));
  if(mode==4){cache.clear();assert(!cache.take("fixture.invalid",443,1));}
  assert(cache.empty());assertClean();
 }
 for(unsigned mode=0;mode<5;++mode){
  reset();Handoff cache;auto client=std::make_unique<WiFiClient>(mode!=0);
  const std::string tooLong(254,'a');
  const char* host=mode==1?nullptr:mode==2?"":mode==3?tooLong.c_str():"fixture.invalid";
  if(mode==4)client.reset();
  assert(!cache.retain(std::move(client),host,443,0));assert(cache.empty());assertClean();
 }
 reset();{
  Handoff cache;auto client=std::make_unique<WiFiClient>(true);auto* ptr=client.get();
  std::string host="fixture.invalid";assert(cache.retain(std::move(client),host.c_str(),443,UINT32_MAX-2000U));
  host="changed.invalid";cache.expire(2998);assert(!cache.empty());
  ptr->stop();assert(!cache.take("fixture.invalid",443,2998));assert(cache.empty());
 }assertClean();
 reset();{
  Handoff cache;assert(cache.retain(std::make_unique<WiFiClient>(true),"fixture.invalid",443,UINT32_MAX-2000U));
  cache.expire(2999);assert(cache.empty());
 }assertClean();
 reset();{
  Handoff cache;assert(cache.retain(std::make_unique<WiFiClient>(true),"fixture.invalid",443,0));
  assert(cache.retain(std::make_unique<WiFiClient>(true),"second.invalid",8443,20));
  assert(f.destroyed==1);auto taken=cache.take("second.invalid",8443,21);assert(taken);
 }assertClean();
 std::puts("PASS actual OneShot ownership/origin/once-only/expiry/wrap/disconnection/replacement");
}
void libraryOverloadControl(){
 // Documented negative control: an otherwise reusable client is forcibly
 // stopped by the original URL-overload call, requiring a new POST dial.
 reset();{
  auto client=std::make_unique<WiFiClient>(true);
  {HTTPClient http;assert(http.begin(*client,"https://fixture.invalid/api/device-tts"));
   assert(!client->connected());assert(http.POST("fixture speech")==200);assert(f.dials==1);
   http.end();}
 }assertClean();assert(f.urlBegins==1 && f.explicitBegins==0);
 reset();{
  auto client=std::make_unique<WiFiClient>(true);
  {HTTPClient http;assert(http.begin(*client,"fixture.invalid",443,"/api/device-tts",true));
   assert(client->connected());assert(http.POST("fixture speech")==200);assert(f.dials==0);
   http.end();}
 }assertClean();assert(f.urlBegins==0 && f.explicitBegins==1);
 std::puts("NEGATIVE CONTROL faithful Arduino URL overload closes kept client and redials; explicit-origin overload preserves it");
}
void successAndRetry(){
 for(const bool kept:{true,false}){
  reset();auto result=invoke(kept);
  assert(result->ok && result->bytes==6 && result->code==200 && result->keptSocket==kept && !result->retriedSocket);
  assert(f.posts==1 && f.dials==(kept?0U:1U));
  assert(f.urlBegins==0 && f.explicitBegins==1);
  assert(primary.files.at(result->path.value)==f.replies[0].bytes && primary.closes==1);
  assert(primary.removed.empty());
 }
 reset();f.replies[0].code=-5;f.replies.push_back(Reply{});
 auto recovered=invoke();assert(recovered->ok && recovered->keptSocket && recovered->retriedSocket);
 assert(f.posts==2 && f.dials==1 && f.bodies[0]==f.bodies[1]);
 for(const auto& url:f.urls)assert(url=="https://fixture.invalid/api/device-tts");
 reset();f.replies[0].code=-5;f.replies.push_back(Reply{});f.replies[1].code=-1;
 auto failed=invoke();assert(!failed->ok && failed->retriedSocket && f.posts==2 && f.dials==1);
 reset();f.replies[0].code=-1;failed=invoke(false);assert(!failed->ok && !failed->retriedSocket && f.posts==1 && f.dials==1);
 for(const int code:{400,401,403,429,500,503}){
  reset();f.replies[0].code=code;auto result=invoke();
  assert(!result->ok && !result->retriedSocket && f.posts==1 && f.dials==0 && result->code==code);
 }
 std::puts("PASS actual speech worker kept/fresh success, CA-verified fresh dial, exactly one stateless retry, no HTTP-error retry");
}
void cancellation(){
 for(const bool kept:{true,false})for(unsigned point=0;point<5;++point){
  reset();f.cancelBegin=point==0;f.cancelPost=point==1 || point==3;f.cancelRead=point==2;
  if(point==3)f.replies[0].code=-5;
  if(point==4)++gVoiceReplySpeechGeneration;
  auto result=invoke(kept);assert(!result->ok && !result->retriedSocket);
  const unsigned posts=(point==0 || point==4)?0U:1U;
  assert(f.posts==posts && f.dials==(kept?0U:posts) && gVoiceReplySpeechGeneration==11);
  assert(primary.files.find(result->path.value)==primary.files.end());
 }
 std::puts("PASS actual cancellation before POST/after POST/during body prevents usable playback result and stale-socket retry");
}
void dataAndStorage(){
 for(const int invalid:{-1,0,5,8194}){
  reset();f.replies[0].expected=invalid;if(invalid==5)f.replies[0].bytes.resize(5);
  auto result=invoke();assert(!result->ok && f.posts==1 && primary.files.find(result->path.value)==primary.files.end());
 }
 reset();f.replies[0].expected=10;auto shortBody=invoke();assert(!shortBody->ok && shortBody->bytes==6);
 reset();f.replies[0].readError=true;auto readFailure=invoke();assert(!readFailure->ok && readFailure->bytes==0);
 reset();f.replies[0].expected=8192;f.replies[0].bytes.resize(8192,17);f.replies[0].maxRead=73;
 auto exact=invoke();assert(exact->ok && exact->bytes==8192);
 reset();f.replies[0].expected=8194;f.replies[0].bytes.resize(8194,23);
 auto fallback=invoke(true,true);assert(fallback->ok && fallback->fs==&secondary && fallback->bytes==8194);
 assert(primary.opens==0 && secondary.opens==1 && primary.removed.empty());
 reset();f.replies[0].expected=4*1024*1024+2;
 auto huge=invoke(true,true);assert(!huge->ok && primary.opens==0 && secondary.opens==0);
 reset();f.replies[0].expected=8194;f.replies[0].bytes.resize(8194,19);secondary.canOpen=false;
 auto fallbackFailure=invoke(true,true);assert(!fallbackFailure->ok && fallbackFailure->fs==&secondary);
 assert(primary.removed.empty() && secondary.removed.size()==1);
 for(unsigned failure=0;failure<3;++failure){
  reset();if(failure==0)primary.canOpen=false;
  if(failure==1)f.writeLimit=2;if(failure==2)f.sizeMismatch=true;
  auto result=invoke();assert(!result->ok && primary.files.find(result->path.value)==primary.files.end());
 }
 reset();f.replies[0].rate="999";auto rate=invoke();assert(rate->ok && rate->sampleRate==kTtsDefaultSampleRate);
 reset();f.replies[0].rate="16000";rate=invoke();assert(rate->ok && rate->sampleRate==16000);
 reset();f.replies[0].stall=true;f.replies[0].holdOpen=true;
 auto stalled=invoke();assert(!stalled->ok && f.now>=45113 && f.now<=45115);
 reset();f.wifi=false;auto offline=invoke();assert(!offline->ok && f.posts==0 && f.dials==0);
 reset();f.replies[0].beginOk=false;auto beginFailure=invoke();assert(!beginFailure->ok && f.posts==0 && f.dials==0);
 std::puts("PASS actual short/odd/unknown/max/stalled/read/FS failures, bounded fallback storage and generation-owned cleanup");
}
int main(){handoffOwnership();libraryOverloadControl();successAndRetry();cancellation();dataAndStorage();}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', action='store_true')
    args = parser.parse_args()
    source = SOURCE.read_text()
    declarations = extract(source, 'struct VoiceSpeechPayload', True) + '\n'
    declarations += extract(source, 'struct VoiceSpeechResult', True) + '\n'
    worker = extract(source, 'VoiceSpeechResult* performVoiceReplySpeech(')
    code = CPP_FIXTURES + CPP_FS + declarations + worker + CPP_TESTS
    flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror']
    if args.sanitize:
        flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
    with tempfile.TemporaryDirectory(prefix='s1-voice-reply-') as directory:
        cpp = Path(directory) / 'test.cpp'
        binary = Path(directory) / 'test'
        cpp.write_text(code)
        subprocess.run([os.environ.get('CXX', 'c++'), *flags, '-I', str(ROOT / 'bots/CardputerADV/src'),
                        str(cpp), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
    print('Scope: actual handoff/worker with offline HTTP/FS/lifetime fixtures; physical latency needs hardware measurement.')


if __name__ == '__main__':
    main()
