#!/usr/bin/env python3
"""Run production VLC worker with deterministic WiFi/mDNS/TCP and real threads."""
from pathlib import Path
import os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src'
JSON=ROOT/'bots/CardputerADV/.pio/libdeps/cardputer_adv/ArduinoJson/src'
STUB=r'''
#pragma once
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>
#include <string>
#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdint>
inline auto epoch=std::chrono::steady_clock::now();
inline uint32_t millis(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-epoch).count();}
inline void vTaskDelay(unsigned n){std::this_thread::sleep_for(std::chrono::milliseconds(n));}
#define pdMS_TO_TICKS(n) (n)
#define pdPASS 1
inline std::thread task;
inline std::atomic<int> tasks{0},sockets{0};
inline int createMode=0;
inline int xTaskCreate(void(*fn)(void*),const char*,unsigned stack,void* arg,int,void*){assert(stack==6144);if(createMode)return 0;if(task.joinable())task.join();++tasks;task=std::thread([=]{fn(arg);--tasks;});return 1;}
inline void vTaskDelete(void*){}
struct String:std::string{
 using std::string::string;String()=default;String(const std::string&s):std::string(s){}String(unsigned n):std::string(std::to_string(n)){}
 void toLowerCase(){for(char&c:*this)c=char(tolower((unsigned char)c));}
 bool endsWith(const char*s)const{return size()>=strlen(s)&&compare(size()-strlen(s),strlen(s),s)==0;}
 void remove(size_t i){erase(i);}
};
class IPAddress{
 uint8_t a[4]{};
 public:
 IPAddress()=default;IPAddress(unsigned x,unsigned y,unsigned z,unsigned w){a[0]=x;a[1]=y;a[2]=z;a[3]=w;}
 bool fromString(const char*s){unsigned n[4];char t;if(sscanf(s,"%u.%u.%u.%u%c",&n[0],&n[1],&n[2],&n[3],&t)!=4)return false;for(int i=0;i<4;++i){if(n[i]>255)return false;a[i]=n[i];}return true;}
 uint8_t operator[](int i)const{return a[i];}
 bool operator==(const IPAddress&o)const{return !memcmp(a,o.a,4);}
 String toString()const{char s[16];snprintf(s,sizeof(s),"%u.%u.%u.%u",a[0],a[1],a[2],a[3]);return s;}
};
constexpr int WL_CONNECTED=3;
inline struct Wifi{
 int state=WL_CONNECTED;int status(){return state;}
 IPAddress localIP(){return {192,168,5,10};}IPAddress subnetMask(){return {255,255,255,0};}
}WiFi;
inline int mdnsFound=1,mdnsCalls=0,hostCalls=0;
inline bool wrongHost=false,mdnsOk=true,resolveHost=true;
inline IPAddress serviceIP{192,168,5,20};
inline struct Mdns{
 bool begin(const char*){return mdnsOk;}
 int queryService(const char*s,const char*p){assert(!strcmp(s,"vlc-http")&&!strcmp(p,"tcp"));++mdnsCalls;return mdnsFound;}
 String hostname(int){return wrongHost?"other-mac":"vlc-test.local";}
 IPAddress IP(int){return serviceIP;}
 uint16_t port(int){return 8090;}
 IPAddress queryHost(String h,unsigned ms){assert(h=="vlc-test"&&ms==1000);++hostCalls;return resolveHost?IPAddress(192,168,5,21):IPAddress();}
}MDNS;
inline int mode=0,connects=0,sends=0;
inline std::vector<IPAddress>connected;
inline std::vector<std::string>requests;
inline struct Esp{size_t free=200000;size_t getFreeHeap(){return free;}}ESP;
namespace base64{inline String encode(String s){assert(s==":synthetic-fixture-only");return "fixture-base64";}}
class WiFiClient{
 std::string data;size_t pos=0;bool open=false;
 public:
 WiFiClient(){++sockets;}~WiFiClient(){--sockets;}
 int connect(IPAddress ip,uint16_t port,int timeout){
  assert(port==8080||port==8090);assert(timeout==800);++connects;::connected.push_back(ip);
  if(mode==1)return 0;
  if(mode==7&&ip[3]==20)return 0;
  open=true;
  std::string body=mode==4?"{}":R"({"state":"playing","time":10,"length":100,"volume":128})";
  data=mode==3?"HTTP/1.1 401 Unauthorized\r\n\r\n":"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: "+std::to_string(body.size())+"\r\n\r\n"+body;
  if(mode==2)data.clear();
  return 1;
 }
 int fd(){return 1;}
 int available(){return std::min(size_t(7),data.size()-pos);}
 int read(uint8_t*p,int n){n=std::min(n,available());memcpy(p,data.data()+pos,n);pos+=n;return n;}
 bool connected(){return open&&(pos<data.size()||mode==2);}
 void stop(){open=false;}
};
inline int fake_send(int fd,const void*p,size_t n,int){
 assert(fd==1);std::string request((const char*)p,n);requests.push_back(request);++sends;
 assert(request.find("Authorization: Basic fixture-base64\r\n")!=std::string::npos);
 assert(request.find("synthetic-fixture-only")==std::string::npos);
 assert(request.find("HTTP/1.0\r\n")!=std::string::npos);
 return n;
}
#define send fake_send
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0
#endif
'''
TEST=r'''
#include "stub.h"
#include "SOURCE"
using namespace vlc_remote;
Config config(){Config c;strcpy(c.host,"vlc-test.local");strcpy(c.fallback,"192.168.5.22");strcpy(c.password,"synthetic-fixture-only");return c;}
void finish(){auto t=millis();while(busy()&&millis()-t<5000)vTaskDelay(1);assert(!busy());if(task.joinable())task.join();assert(tasks==0&&sockets==0);}
void reset(){finish();mode=0;connects=sends=mdnsCalls=hostCalls=0;requests.clear();connected.clear();mdnsFound=1;wrongHost=false;resolveHost=true;serviceIP={192,168,5,20};}
int main(){
 assert(!configured(defaults()));
 assert(!start(defaults(),Command::Status,true));assert(snapshot().error==Error::NotConfigured);
 reset();auto c=config();
 assert(start(c,Command::Status,true));assert(!start(c,Command::Toggle));finish();
 assert(snapshot().connected&&snapshot().seconds==10&&snapshot().volume==128&&!strcmp(snapshot().route,"Bonjour"));
 assert(connects==1&&mdnsCalls==1&&hostCalls==0&&connected[0]==serviceIP);
 for(int command=1;command<=int(Command::Back);++command){
  auto oldConnects=connects;assert(start(c,Command(command)));finish();assert(snapshot().connected&&connects==oldConnects+1);
  assert(requests.back().find(std::string("GET ")+path(Command(command))+" HTTP/1.0")!=std::string::npos);
 }
 // Wrong mDNS host must not receive credentials. .local is the second route.
 reset();wrongHost=true;assert(start(c,Command::Status,true));finish();assert(snapshot().connected&&connects==1&&hostCalls==1&&connected[0][3]==21&&!strcmp(snapshot().route,"Hostname"));
 // Missing service and missing hostname use the private IP last.
 reset();mdnsFound=0;resolveHost=false;assert(start(c,Command::Status,true));finish();assert(snapshot().connected&&connects==1&&connected[0][3]==22&&!strcmp(snapshot().route,"LAN fallback"));
 reset();mode=7;assert(start(c,Command::Status,true));finish();assert(snapshot().connected&&connects==2&&connected[0][3]==20&&connected[1][3]==21);
 // Public/foreign subnet discovered endpoints never receive auth.
 reset();serviceIP={8,8,8,8};assert(start(c,Command::Status,true));finish();assert(snapshot().connected&&connected[0][3]==21&&connects==1);
 // 401 is terminal, not a broadcast password probe or an automatic retry.
 reset();mode=3;assert(start(c,Command::Status,true));finish();assert(!snapshot().connected&&snapshot().error==Error::Auth&&snapshot().http==401&&connects==1&&hostCalls==0);
 assert(!start(c,Command::Toggle));assert(connects==1);
 reset();assert(start(c,Command::Status,true));finish();mode=3;int oldConnects=connects;assert(start(c,Command::Next));finish();assert(snapshot().error==Error::Auth&&connects==oldConnects+1);
 // A timed-out non-idempotent command is not replayed or sent to a fallback.
 reset();assert(start(c,Command::Status,true));finish();mode=2;oldConnects=connects;
 assert(start(c,Command::Toggle));finish();assert(snapshot().error==Error::Timeout&&!snapshot().connected&&connects==oldConnects+1);
 assert(!start(c,Command::Toggle));assert(connects==oldConnects+1);
 // Cancellation is quick during socket reads; UI never forcibly frees worker.
 reset();assert(start(c,Command::Status,true));finish();mode=2;assert(start(c,Command::Status));vTaskDelay(20);auto t=millis();cancel();finish();assert(millis()-t<500&&snapshot().error==Error::Cancelled);
 reset();mode=4;assert(start(c,Command::Status,true));finish();assert(snapshot().error==Error::Invalid&&!snapshot().connected);
 reset();createMode=1;assert(!start(c,Command::Status,true));assert(!busy()&&snapshot().error==Error::Memory);createMode=0;
 reset();WiFi.state=0;assert(!start(c,Command::Status,true)&&snapshot().error==Error::NoWifi);WiFi.state=WL_CONNECTED;
 reset();ESP.free=100;assert(!start(c,Command::Status,true)&&snapshot().error==Error::Memory);ESP.free=200000;
 reset();assert(!start(c,Command::Next,true)&&snapshot().error==Error::Invalid);
 puts("PASS actual VLC worker: Bonjour -> .local -> private IP, bound host/auth, every control, 401, timeout/no command replay, cancellation, exclusive ownership and resource cleanup (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='vlc-worker-') as tmp:
 p=Path(tmp);stub=p/'stubs';(stub/'lwip').mkdir(parents=True)
 (stub/'stub.h').write_text(STUB)
 for name in ('Arduino.h','WiFi.h','WiFiClient.h','ESPmDNS.h','base64.h','lwip/sockets.h'):(stub/name).write_text('#include "stub.h"\n')
 (p/'test.cpp').write_text(TEST.replace('SOURCE',str(SRC/'vlc_remote.cpp')))
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-pthread','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(stub),'-I'+str(JSON),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=30)
