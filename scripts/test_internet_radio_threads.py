#!/usr/bin/env python3
"""Actual worker/decoder with mocked hardware: cancellation and PCM lifetime.
No firmware build; generated fixtures and binaries live only in TemporaryDirectory.
"""
from pathlib import Path
import subprocess, tempfile, os
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'bots/CardputerADV/src/internet_radio_transport.cpp'
STUB = r'''
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
#include <arpa/inet.h>
inline auto epoch=std::chrono::steady_clock::now();
inline uint32_t millis(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-epoch).count();}
inline void vTaskDelay(unsigned n){std::this_thread::sleep_for(std::chrono::milliseconds(n));}
#define pdMS_TO_TICKS(n) (n)
#define pdPASS 1
using portMUX_TYPE=std::mutex;
#define portMUX_INITIALIZER_UNLOCKED {}
#define portENTER_CRITICAL(p) (p)->lock()
#define portEXIT_CRITICAL(p) (p)->unlock()
inline std::atomic<int> tasks{0}, sockets{0}, blocks{0}, mode{0}, plays{0};
inline std::vector<uint8_t> fixture;
inline std::thread task;
inline int xTaskCreate(void(*fn)(void*),const char*,unsigned,void* arg,int,void*){if(task.joinable())task.join();++tasks;task=std::thread([=]{fn(arg);--tasks;});return 1;}
inline void vTaskDelete(void*){}
#define MALLOC_CAP_8BIT 1
inline void* heap_caps_malloc(size_t n,int){++blocks;return malloc(n);}
inline size_t heap_caps_get_largest_free_block(int){return 1024*1024;}
inline struct {size_t getFreeHeap(){return 1024*1024;}} ESP;
inline void tracked_free(void* p){if(p)--blocks;::free(p);}
class IPAddress {
 uint8_t a[4]{};
 public:
 IPAddress()=default;IPAddress(unsigned a0,unsigned a1,unsigned a2,unsigned a3){a[0]=a0;a[1]=a1;a[2]=a2;a[3]=a3;}
 bool fromString(const char* s){unsigned x[4];char tail; if(sscanf(s,"%u.%u.%u.%u%c",&x[0],&x[1],&x[2],&x[3],&tail)!=4)return false;for(int i=0;i<4;++i){if(x[i]>255)return false;a[i]=x[i];}return true;}
 uint8_t operator[](int i)const{return a[i];}
};
class WiFiClient {
 std::vector<uint8_t> data;size_t pos=0;bool open=false;
 public:
 WiFiClient(){++sockets;}~WiFiClient(){--sockets;}
 void setTimeout(int){}
 int connect(IPAddress,unsigned,int){if(mode==1)vTaskDelay(100);open=true;std::string h="HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\n\r\n";data.assign(h.begin(),h.end());if(mode==2)data.insert(data.end(),fixture.begin(),fixture.end());return 1;}
 int fd(){return 1;}
 int available(){return int(data.size()-pos);}
 int read(uint8_t* dst,size_t n){n=std::min(n,data.size()-pos);memcpy(dst,data.data()+pos,n);pos+=n;return n;}
 bool connected(){return open;}
 void stop(){open=false;}
};
inline int fake_send(int,const void*,size_t n,int){return n;}
#define send fake_send
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0
#endif
// Two FIFO requests with asynchronous consumption; every inspection verifies
// neither queued PCM pointer has been overwritten. Only worker accesses it.
struct SpeakerMock {
 struct Frame {uint32_t until;const int16_t* ptr;size_t len;long long checksum;};
 std::vector<Frame> queue;
 size_t isPlaying(uint8_t ch){assert(ch==7);for(auto& f:queue){long long sum=0;for(size_t i=0;i<f.len;++i)sum+=f.ptr[i];assert(sum==f.checksum);}while(!queue.empty()&&int32_t(millis()-queue.front().until)>=0)queue.erase(queue.begin());return queue.size();}
 bool playRaw(const int16_t* p,size_t n,uint32_t rate,bool stereo,uint32_t repeat,int ch,bool stop){assert(isPlaying(ch)<2);assert(repeat==1&&!stop);long long sum=0;for(size_t i=0;i<n;++i)sum+=p[i];uint32_t until=(queue.empty()?millis():queue.back().until)+std::max(1u,unsigned(1000*n/rate/(stereo?2:1)));queue.push_back({until,p,n,sum});++plays;return true;}
};
inline struct {SpeakerMock Speaker;} M5Cardputer;
using err_t=int;
constexpr int ERR_OK=0,ERR_INPROGRESS=1;
struct ip_addr_t {uint32_t addr;};
#define IP_IS_V4(p) true
#define ip_2_ip4(p) (p)
#define ip4_addr_get_u32(p) ((p)->addr)
#define lwip_ntohl ntohl
inline int dns_gethostbyname(const char*,ip_addr_t* p,void(*)(const char*,const ip_addr_t*,void*),void*){p->addr=htonl(0x08080808);return ERR_OK;}
inline int tcpip_callback(void(*fn)(void*),void* p){fn(p);return ERR_OK;}
'''
CPP = r'''
#include "stub.h"
#include "SOURCE"
#include <fstream>
#include <iterator>
using namespace internet_radio;
void finish(){uint32_t t=millis();while(busy()&&millis()-t<2000)vTaskDelay(1);assert(!busy());if(task.joinable())task.join();assert(sockets==0&&tasks==0);}
int main(int argc,char** argv){
 std::ifstream f(argv[1],std::ios::binary);fixture.assign(std::istreambuf_iterator<char>(f),{});assert(!fixture.empty());
 for(int m=0;m<3;++m){mode=m;plays=0;assert(start("http://8.8.8.8/live"));assert(!start("http://8.8.8.8/second"));
 uint32_t t=millis();if(m==2){while(plays<4&&millis()-t<1000)vTaskDelay(1);assert(plays>=4);}else vTaskDelay(10);
 t=millis();stop();assert(millis()-t<30);finish();assert(state()==State::Idle&&error()==Error::None);}
 assert(start("http://127.0.0.1/live"));finish();assert(error()==Error::PublicHttpOnly);
 assert(!start("https://radio.test/live"));assert(error()==Error::InvalidUrl);
 puts("PASS actual worker: cancel stalled read, cancel connect, cancel playing; single-owner starts, FIFO PCM lifetime and resource cleanup (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='radio-worker-') as tmp:
    work=Path(tmp);stubs=work/'stubs';(stubs/'lwip').mkdir(parents=True)
    (stubs/'stub.h').write_text(STUB)
    for name in ['Arduino.h','WiFi.h','M5Cardputer.h','esp_heap_caps.h','lwip/dns.h','lwip/tcpip.h','lwip/sockets.h']:
        (stubs/name).write_text('#include "stub.h"\n')
    (work/'worker.cpp').write_text(CPP.replace('SOURCE',str(SOURCE)))
    exe=work/'worker'
    subprocess.run(['g++','-std=c++17','-O1','-g','-pthread','-fno-omit-frame-pointer','-fsanitize=address,undefined','-no-pie','-I'+str(stubs),str(work/'worker.cpp'),'-o',str(exe)],check=True)
    fixture=work/'audio.mp3'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=997:duration=1','-ac','2','-ar','44100','-codec:a','libmp3lame','-b:a','128k','-write_xing','0','-id3v2_version','0','-y',str(fixture)],check=True,timeout=20)
    subprocess.run([str(exe),str(fixture)],check=True,timeout=20,env=dict(os.environ,ASAN_OPTIONS='detect_leaks=1:halt_on_error=1',UBSAN_OPTIONS='halt_on_error=1'))
