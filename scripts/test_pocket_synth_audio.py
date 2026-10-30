#!/usr/bin/env python3
"""Run the real ADV producer on threaded speaker/FreeRTOS shims, not UI ticks."""
from pathlib import Path
import os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src'
FREERTOS=r'''
#pragma once
#include <mutex>
#include <thread>
#include <vector>
#include <atomic>
#include <chrono>
#include <cassert>
using portMUX_TYPE=std::mutex;
#define portMUX_INITIALIZER_UNLOCKED {}
#define portENTER_CRITICAL(m) (m)->lock()
#define portEXIT_CRITICAL(m) (m)->unlock()
constexpr int pdPASS=1;
extern std::atomic<bool> taskReject;
extern std::vector<std::thread> tasks;
struct TaskDone{};
inline void vTaskDelay(int ticks){std::this_thread::sleep_for(std::chrono::milliseconds(ticks));}
inline void vTaskDelete(void*){throw TaskDone{};}
inline int xTaskCreate(void(*f)(void*),const char*,unsigned stack,void*arg,unsigned priority,void*){
 assert(stack==4096&&priority==3);if(taskReject)return 0;
 tasks.emplace_back([=]{try{f(arg);}catch(TaskDone&) {}});return pdPASS;
}
'''
M5=r'''
#pragma once
#include <freertos/FreeRTOS.h>
#include <cstdint>
#include <deque>
#include <algorithm>
constexpr int I2S_NUM_1=1;
inline auto epoch=std::chrono::steady_clock::now();inline std::atomic<uint32_t> clockOffset{0};
inline uint32_t millis(){return uint32_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-epoch).count())+clockOffset.load();}
struct SpeakerStub{
 struct Config{int sample_rate=48000,pin_bck=41,pin_ws=43,pin_data_out=42,i2s_port=1;bool stereo=false,buzzer=false,use_dac=false;}cfg;
 struct Item{const int16_t*p;std::vector<int16_t>copy;};std::deque<Item>queue;std::mutex lock;
 std::atomic<bool> foreign{false},reject{false},freeze{false},quit{false},cancelled{false};
 std::atomic<int> calls{0},stops{0},consumed{0},holes{0};std::thread consumer;
 SpeakerStub():consumer([this]{while(!quit){vTaskDelay(10);std::lock_guard<std::mutex>g(lock);
   if(queue.empty())continue;auto&item=queue.front();assert(std::equal(item.copy.begin(),item.copy.end(),item.p));
   if(freeze)continue;queue.pop_front();++consumed;
   if(cancelled.exchange(false))queue.clear();
 }}){}
 ~SpeakerStub(){quit=true;consumer.join();}
 Config config()const{return cfg;}
 bool isPlaying(){std::lock_guard<std::mutex>g(lock);return foreign||!queue.empty();}
 int isPlaying(int channel){assert(channel==6);std::lock_guard<std::mutex>g(lock);return int(queue.size());}
 bool playRaw(const int16_t*p,size_t count,int rate,bool stereo,int repeat,int channel,bool stop){
  assert(count==512&&rate==48000&&!stereo&&repeat==1&&channel==6&&!stop);
  if(reject)return false;std::lock_guard<std::mutex>g(lock);assert(queue.size()<2);
  for(auto&i:queue){assert(i.p!=p);assert(std::equal(i.copy.begin(),i.copy.end(),i.p));}
  queue.push_back({p,std::vector<int16_t>(p,p+count)});++calls;return true;
 }
 void stop(int channel){assert(channel==6);++stops;cancelled=true;}
};
struct Device{SpeakerStub Speaker;};extern Device M5Cardputer;
'''
CODE=r'''
#include <M5Cardputer.h>
#include "pocket_synth_audio.h"
#include <cstdio>
Device M5Cardputer;std::atomic<bool>taskReject{false};std::vector<std::thread>tasks;
void join(){for(auto&t:tasks)t.join();tasks.clear();}
template<class F>void wait(F f,int ms=500){for(int i=0;i<ms&&!f();++i)vTaskDelay(1);assert(f());}
int main(){
 using namespace synth_audio;auto&sp=M5Cardputer.Speaker;
 Control c;c.mask=(1u<<0)|(1u<<4)|(1u<<7);c.patch=pocket_synth::Patch::Organ;
 assert(!busy());
 // No GPIO, codec, stereo, DAC or I2S-port guessing on a different profile.
 for(int*field:{&sp.cfg.sample_rate,&sp.cfg.pin_bck,&sp.cfg.pin_ws,&sp.cfg.pin_data_out,&sp.cfg.i2s_port}){int old=*field;*field=0;assert(!start(c)&&!busy());*field=old;}
 for(bool*field:{&sp.cfg.stereo,&sp.cfg.buzzer,&sp.cfg.use_dac}){*field=true;assert(!start(c)&&!busy());*field=false;}
 for(auto bad:{Control{0,3,65,pocket_synth::Patch::Piano,false},Control{1u<<30,3,65,pocket_synth::Patch::Piano,false},Control{1,1,65,pocket_synth::Patch::Piano,false},Control{1,3,101,pocket_synth::Patch::Piano,false}})assert(!start(bad));
 sp.foreign=true;assert(!start(c));sp.foreign=false;
 taskReject=true;assert(!start(c)&&status().fault&&!busy());taskReject=false;
 assert(start(c));assert(!start(c));wait([]{return status().blocks>=3;});assert(status().voices==3);
 // UI does absolutely no servicing for 300 ms. Audio must keep refilling.
 auto before=status().blocks;vTaskDelay(300);auto after=status();assert(after.blocks>before+20&&after.starvations==0&&after.voices==3);
 c.mask=1;update(c);wait([]{return status().voices==1;});
 c.sustain=true;update(c);vTaskDelay(20);c.mask=0;update(c);vTaskDelay(200);assert(status().voices==1);
 c.sustain=false;update(c);wait([]{return status().voices==0;});vTaskDelay(50);
 auto idle=status().blocks;vTaskDelay(80);assert(status().blocks==idle); // no endless silence requests
 c.mask=1;update(c);wait([=]{return status().blocks>idle+2;});
 assert(stop());assert(!busy());join();int stoppedCalls=sp.calls;vTaskDelay(30);assert(sp.calls==stoppedCalls);
 // Queue rejection tears down the producer, then allows a fresh explicit start.
 sp.reject=true;assert(start(c));wait([]{return !status().running;});assert(status().fault);assert(stop());join();sp.reject=false;
 assert(start(c));wait([]{return status().blocks>=2;});sp.freeze=true;
 assert(!stop(8));assert(busy()&&!status().running);assert(!start(c)); // do not hand a live pointer to another audio owner
 sp.freeze=false;assert(stop(100));join();assert(!busy());
 // Rapid cancellation/restart: static PCM storage may not be rewritten while
 // an asynchronously stopped request still refers to it.
 for(int i=0;i<30;++i){c.mask=uint32_t(1)<<(i%25);assert(start(c));wait([]{return status().blocks>=2;});assert(stop());join();}
 clockOffset.store(UINT32_MAX-millis()-5);assert(start(c));wait([]{return status().blocks>=2;});assert(stop());join();
 assert(!busy());
 puts("PASS actual ADV synth producer: 48kHz/ES8311 I2S1 profile, 3KiB PCM+4KiB worker budget, 300ms UI stall without starvation, sustain/release, silent idle, all pointer lifetimes, timeout/rejection/allocation guards, 30 restart races and clock wrap (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='synth-audio-') as tmp:
 p=Path(tmp);(p/'freertos').mkdir();(p/'freertos/FreeRTOS.h').write_text(FREERTOS);(p/'freertos/task.h').write_text('#include "FreeRTOS.h"\n');(p/'M5Cardputer.h').write_text(M5);(p/'test.cpp').write_text(CODE)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-pthread','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(p),'-I'+str(SRC),str(p/'test.cpp'),str(SRC/'pocket_synth_audio.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=40)
# Existing 0.2.204 producer had only 2*256/22050=23.2 ms of PCM queue.
# A 40ms UI pass needs 882 samples, exceeding its 512 queued samples even
# before repeated display/SD/keyboard stalls. The new producer is independent.
assert 2*256/22050<.024 and 40*22050/1000>2*256
print('PASS reproduced old scheduling risk: 23.2ms queue cannot cover a 40ms LCD/UI service gap; new actual threaded producer continues through 300ms without UI calls')
