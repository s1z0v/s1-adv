#!/usr/bin/env python3
"""Actual worker/decoder lifecycle against deterministic TCP, scheduler and PCM slots."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1];src=root/'bots/CardputerADV/src'
production=(src/'internet_radio_transport.cpp').read_text()
start=production.index('#include <Arduino.h>');end=production.index('namespace internet_radio {',start)
stubs=r'''
#include <vector>
#include <deque>
#include <string>
#include <fstream>
#include <iterator>
#include <functional>
#include <cassert>
#include <algorithm>
#include <cstdio>
uint32_t clockMs=0;
uint32_t millis(){return clockMs;}
constexpr int MALLOC_CAP_8BIT=1;
bool allocateFails=false,createFails=false,connectFails=false;
void*heap_caps_malloc(size_t n,int){return allocateFails?nullptr:malloc(n);}
size_t heap_caps_get_largest_free_block(int){return 100000;}
struct{int getFreeHeap(){return 150000;}}ESP;
using portMUX_TYPE=int;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) ((void)(x))
#define portEXIT_CRITICAL(x) ((void)(x))
#define pdMS_TO_TICKS(x) (x)
constexpr int pdPASS=1;
void(*scheduled)(void*)=nullptr;
int xTaskCreate(void(*f)(void*),const char*,int n,void*,int,void*){assert(n==24576);if(createFails)return 0;assert(!scheduled);scheduled=f;return pdPASS;}
void vTaskDelete(void*){}
struct IPAddress{
 uint8_t a[4]={};IPAddress()=default;IPAddress(uint8_t x,uint8_t y,uint8_t z,uint8_t w){a[0]=x;a[1]=y;a[2]=z;a[3]=w;}
 bool fromString(const char*s){unsigned x,y,z,w;char extra;if(sscanf(s,"%u.%u.%u.%u%c",&x,&y,&z,&w,&extra)!=4||x>255||y>255||z>255||w>255)return false;*this=IPAddress(x,y,z,w);return true;}
 uint8_t operator[](int i)const{return a[i];}
};
using err_t=int;constexpr int ERR_OK=0,ERR_INPROGRESS=1;
struct ip_addr_t{uint32_t value=0x08080808;};
#define IP_IS_V4(x) true
#define ip_2_ip4(x) (x)
#define ip4_addr_get_u32(x) ((x)->value)
uint32_t lwip_ntohl(uint32_t x){return x;}
int dns_gethostbyname(const char*,ip_addr_t*addr,void(*)(const char*,const ip_addr_t*,void*),void*){addr->value=0x08080808;return ERR_OK;}
int tcpip_callback(void(*f)(void*),void*p){f(p);return ERR_OK;}
std::string response,request;std::function<void()>readHook;
struct WiFiClient{
 size_t pos=0;bool open=false;
 int fd(){return 123;}
 void setTimeout(int){}
 bool connect(IPAddress,uint16_t,int timeout){assert(timeout==600);pos=0;open=!connectFails;return open;}
 size_t write(const uint8_t*p,size_t n){request.assign((const char*)p,n);assert(request.find("Authorization:")==std::string::npos);return n;}
 int available(){return open?int(response.size()-pos):0;}
 bool connected(){return open&&pos<response.size();}
 int read(uint8_t*p,size_t n){n=std::min(n,response.size()-pos);memcpy(p,response.data()+pos,n);pos+=n;if(readHook)readHook();return int(n);}
 void stop(){open=false;}
};
constexpr int MSG_DONTWAIT=1;
int send(int fd,const void*p,size_t n,int flags){assert(fd==123&&flags==MSG_DONTWAIT);request.assign((const char*)p,n);assert(request.find("Authorization:")==std::string::npos);return int(n);}
uint64_t hashPcm(const int16_t*p,size_t n){uint64_t h=1469598103934665603ULL;for(size_t i=0;i<n;++i){h^=uint16_t(p[i]);h*=1099511628211ULL;}return h;}
struct Frame{const int16_t*data;size_t n;uint64_t hash;uint32_t end;};
struct FakeSpeaker{
 std::deque<Frame>queue;unsigned rendered=0;size_t maxQueued=0;
 size_t isPlaying(uint8_t channel){assert(channel==7);return queue.size();}
 bool playRaw(const int16_t*p,size_t n,uint32_t hz,bool stereo,int repeat,uint8_t channel,bool stop){
  assert(channel==7&&!stop&&repeat==1&&queue.size()<2&&hz==44100&&stereo);
  assert(n>0&&n<=2304);for(auto&f:queue)assert(f.data!=p);
  uint32_t end=(queue.empty()?clockMs:queue.back().end)+uint32_t(n*1000/(hz*2));queue.push_back({p,n,hashPcm(p,n),end});maxQueued=std::max(maxQueued,queue.size());return true;
 }
 void advance(){while(!queue.empty()&&clockMs>=queue.front().end){auto&f=queue.front();assert(f.hash==hashPcm(f.data,f.n));queue.pop_front();++rendered;}}
};
struct{FakeSpeaker Speaker;}M5Cardputer;
void vTaskDelay(unsigned n){clockMs+=n;M5Cardputer.Speaker.advance();}
'''
# The production worker is compiled unchanged except platform includes are
# replaced with test doubles. Parser/decoder/cancel/cleanup logic stays actual.
code=production[:start]+stubs+production[end:]+r'''
std::string chunks(const std::string&s){std::string w;for(size_t pos=0;pos<s.size();pos+=333){auto b=s.substr(pos,333);char h[16];snprintf(h,sizeof(h),"%zx\r\n",b.size());w+=h;w+=b;w+="\r\n";}return w+"0\r\n\r\n";}
void execute(){assert(scheduled);auto f=scheduled;scheduled=nullptr;f(nullptr);assert(!internet_radio::busy()&&M5Cardputer.Speaker.queue.empty());}
int main(int argc,char**argv){
 assert(argc==2);std::ifstream in(argv[1],std::ios::binary);std::string mp3((std::istreambuf_iterator<char>(in)),{});assert(mp3.size()>10000);
 const std::string header="HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n";
 response=header+"\r\n"+mp3;
 assert(internet_radio::start("http://radio.example/stream"));assert(internet_radio::busy());assert(!internet_radio::start("http://radio.example/second"));execute();
 assert(internet_radio::error()==internet_radio::Error::None&&internet_radio::bytes()==mp3.size());
 assert(M5Cardputer.Speaker.rendered>30&&M5Cardputer.Speaker.maxQueued==2);
 // Real MP3 carried inside ICY metadata inside HTTP chunks; parser order must
 // dechunk first and strip metadata second, byte-perfect to the real decoder.
 std::string icy;for(size_t pos=0;pos<mp3.size();pos+=777){auto b=mp3.substr(pos,777);icy+=b;if(b.size()==777){icy+=char(1);icy+="StreamTitle=xxxx";}}
 response=header+"Transfer-Encoding: chunked\r\nicy-metaint: 777\r\n\r\n"+chunks(icy);
 assert(internet_radio::start("http://radio.example/stream"));execute();assert(internet_radio::error()==internet_radio::Error::None&&internet_radio::bytes()==mp3.size());
 // Cancellation before worker begins, and while TCP data arrives, both drain
 // any live PCM before worker-owned buffers and ownership can disappear.
 assert(internet_radio::start("http://radio.example/stream"));internet_radio::stop();assert(internet_radio::busy());execute();assert(internet_radio::state()==internet_radio::State::Idle);
 readHook=[](){internet_radio::stop();};assert(internet_radio::start("http://radio.example/stream"));execute();readHook={};assert(internet_radio::state()==internet_radio::State::Idle);
 allocateFails=true;assert(internet_radio::start("http://radio.example/stream"));execute();assert(internet_radio::error()==internet_radio::Error::NoMemory);allocateFails=false;
 createFails=true;assert(!internet_radio::start("http://radio.example/stream")&&!internet_radio::busy());createFails=false;
 connectFails=true;assert(internet_radio::start("http://radio.example/stream"));execute();assert(internet_radio::error()==internet_radio::Error::Connect);connectFails=false;
 assert(!internet_radio::start("https://radio.example/stream"));
 assert(internet_radio::start("http://127.0.0.1/stream"));execute();assert(internet_radio::error()==internet_radio::Error::PublicHttpOnly);
 for(auto wire:{std::string("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\nx"),header+"\r\nnot mp3",header+"Transfer-Encoding: chunked\r\n\r\n3\r\nab"}){
  response=wire;assert(internet_radio::start("http://radio.example/stream"));execute();assert(internet_radio::state()==internet_radio::State::Error);
 }
 puts("PASS actual radio worker: bounded TCP/ICY/chunked MP3 decode, two safe PCM slots, async cancel and release, allocation/task/connect/malformed/public-IP failures (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-radio-worker-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1.2:sample_rate=44100','-ac','2','-c:a','libmp3lame','-b:a','128k',str(p/'test.mp3')],check=True)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-g','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I'+str(src),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test'),str(p/'test.mp3')],check=True,timeout=90)
