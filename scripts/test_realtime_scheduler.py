#!/usr/bin/env python3
"""Test actual exclusive-loop code against a conditional idle-scheduling model.

This is not FreeRTOS emulation or proof of the physical Wi-Fi failure. On the
pinned Arduino 2.0.14 / IDF 4.4.6 build, delay(1) blocks for one tick. The model
checks the idle opportunity when CPU0 is busy and no higher-priority CPU1 task
is ready. An unpinned deleted worker can also be reclaimed by CPU0's idle;
that counterexample is tested explicitly. Only the worker's 12288 stack bytes
are counted, not a guessed TCB size. No network/device/provider is contacted.

References reviewed for these assumptions:
https://github.com/espressif/esp-idf/blob/v4.4.6/components/freertos/tasks.c#L3835
Arduino cores/esp32/main.cpp and esp32-hal-misc.c; S3 sdkconfig tick rate 1000.
"""
import argparse
from pathlib import Path
import os
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'bots/CardputerADV/src/main_parts/061_main.cpp.inc'


def extract_function(text, signature):
    start = text.index(signature)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def extract_exclusive_prefix(text):
    # Compile the actual loop prefix, including USB and the exclusive return.
    # The ordinary application path is outside this test, not mirrored here.
    start = text.index('void loop()')
    end = text.index('  updateG0VoiceTrigger();', start)
    prefix = text[start:end]
    if prefix.count('{') - prefix.count('}') != 1:
        raise SystemExit('Exclusive loop prefix changed; review the extraction boundary.')
    return prefix + '}\n'


CPP = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
constexpr size_t workerStackBytes=12288, initialFreeBytes=65536;
struct PendingWorker {int affinity=-1;bool stillRunning=false;};
struct Fixture {
 uint32_t now=0,rtCost=0;
 size_t freeBytes=initialFreeBytes;
 bool core0Idle=false,core1HigherReady=false,wifi=true;
 unsigned usb=0,rt=0,typing=0,blink=0,keys=0,m5=0,health=0,nes=0,dial=0,focus=0;
 unsigned delayCalls=0,yieldCalls=0,idle0=0,idle1=0,reaped=0,logs=0;
 std::vector<PendingWorker> pending;
 std::vector<uint32_t> renders;
 std::vector<std::string> calls;
};
Fixture f;
bool gWifiReady=false,gRealtimeExclusiveMode=true;
bool gRealtimeConnected=true,gRealtimeAwaiting=false,gRealtimePlaybackActive=false;
uint32_t gLastRenderMs=0,gLoopMaxMs=0,gLastLoopSlowMs=0;
void addDeletedWorker(int affinity=-1,bool stillRunning=false){
 assert(f.freeBytes>=workerStackBytes);f.freeBytes-=workerStackBytes;
 f.pending.push_back({affinity,stillRunning});
}
void idle(int core){
 if(core==0)++f.idle0;else ++f.idle1;
 for(auto it=f.pending.begin();it!=f.pending.end();){
  if(!it->stillRunning && (it->affinity==-1 || it->affinity==core)){
   f.freeBytes+=workerStackBytes;++f.reaped;it=f.pending.erase(it);
  }else ++it;
 }
}
void yield(){++f.yieldCalls;} // loop priority1 remains ready; idle priority0 cannot preempt it.
void delay(uint32_t ms){
 ++f.delayCalls;f.calls.push_back("delay");
 if(ms==0){yield();return;}
 assert(ms==1);++f.now;
 if(!f.core1HigherReady)idle(1);
}
uint32_t millis(){return f.now;}
constexpr int WL_CONNECTED=3;
struct Wifi {int status(){f.calls.push_back("wifi");return f.wifi?WL_CONNECTED:0;}} WiFi;
struct Cardputer {void update(){++f.m5;f.calls.push_back("m5");}} M5Cardputer;
void sampleUiHealth(){++f.health;f.calls.push_back("health");if(f.core0Idle)idle(0);}
void refreshKeyboardState(){++f.keys;f.calls.push_back("keys");}
void handleHostSerialInput(){++f.usb;f.calls.push_back("usb");}
void serviceNesTransfer(){++f.nes;f.calls.push_back("nes");}
void serviceRealtimeDialCompletion(){++f.dial;f.calls.push_back("dial");}
void updateFocusTimer(){++f.focus;f.calls.push_back("focus");}
void pollTyping(){++f.typing;f.calls.push_back("typing");}
void serviceRealtimeVoice(){++f.rt;f.calls.push_back("rt");f.now+=f.rtCost;}
void updateBlink(){++f.blink;f.calls.push_back("blink");}
void render(){f.renders.push_back(f.now);f.calls.push_back("render");}
template<class... T> void logf(const char*,T...){++f.logs;}
void reset(){
 f=Fixture{};gWifiReady=false;gRealtimeExclusiveMode=true;
 gRealtimeConnected=true;gRealtimeAwaiting=gRealtimePlaybackActive=false;
 gLastRenderMs=gLoopMaxMs=gLastLoopSlowMs=0;
}
void assertServices(unsigned count){
 assert(f.usb==count && f.rt==count && f.typing==count && f.blink==count);
 assert(f.keys==count && f.m5==count && f.health==count);
 assert(f.nes==count && f.dial==count && f.focus==count);
}
'''

POSITIVE = r'''
void idleOpportunity(){
 reset();addDeletedWorker();loop();assertServices(1);
 assert(f.delayCalls==1 && f.idle1==1 && f.reaped==1 && f.pending.empty());
 assert(f.freeBytes==initialFreeBytes && f.now==1 && gWifiReady);
 const std::vector<std::string> expected={"health","m5","keys","usb","nes","dial","focus","wifi","typing","rt","blink","delay"};
 assert(f.calls==expected);
 for(unsigned i=0;i<64;++i){addDeletedWorker();loop();assert(f.freeBytes==initialFreeBytes);}
 assertServices(65);assert(f.reaped==65 && f.delayCalls==65);
 std::puts("PASS actual exclusive loop preserves USB/RT services and offers idle1 a tick; conditional model reclaims 12288-byte worker stack");
}
void limitsAndCounterexamples(){
 // An unpinned worker is eligible on either idle, even without a loop delay.
 reset();addDeletedWorker();idle(0);
 assert(f.freeBytes==initialFreeBytes && f.reaped==1 && f.delayCalls==0);
 // Yield/delay(0) keep priority1 runnable and cannot themselves run idle1.
 reset();addDeletedWorker();yield();delay(0);
 assert(f.freeBytes==initialFreeBytes-workerStackBytes && f.pending.size()==1);
 // A higher-priority CPU1 task can consume the entire block interval.
 reset();f.core1HigherReady=true;addDeletedWorker();loop();
 assert(f.delayCalls==1 && f.reaped==0);
 f.core1HigherReady=false;loop();assert(f.reaped==1);
 // CPU1 idle cannot reap a worker pinned to CPU0.
 reset();addDeletedWorker(0);loop();assert(f.reaped==0);
 f.core0Idle=true;loop();assert(f.reaped==1);
 // A self-deleting task must have switched out before either idle frees it.
 reset();addDeletedWorker(-1,true);loop();assert(f.reaped==0);
 f.pending.front().stillRunning=false;loop();assert(f.reaped==1);
 std::puts("PASS scheduler counterexamples: idle0 can reclaim unpinned task; yield/zero delay, busy CPU1, affinity and still-running limits are explicit");
}
void renderAndTiming(){
 reset();
 for(unsigned i=0;i<=300;++i){f.now=i;loop();}
 assertServices(301);assert(f.delayCalls==301);
 assert(f.renders.size()==300/kBusyRenderIntervalMs);
 for(size_t i=1;i<f.renders.size();++i)assert(f.renders[i]-f.renders[i-1]>=kBusyRenderIntervalMs);
 reset();f.wifi=false;loop();assertServices(1);assert(!gWifiReady && f.delayCalls==1);
 reset();f.now=3000;f.rtCost=90;loop();assert(gLoopMaxMs==90 && f.logs==1 && f.delayCalls==1);
 reset();f.now=UINT32_MAX-15U;gLastRenderMs=f.now-60U;gLastLoopSlowMs=f.now-3000U;
 f.rtCost=90;loop();assert(gLoopMaxMs==90 && f.logs==1 && f.delayCalls==1);
 std::puts("PASS actual render cadence, disconnected Wi-Fi servicing, slow-loop accounting and clock wrap");
}
int main(){idleOpportunity();limitsAndCounterexamples();renderAndTiming();}
'''

NEGATIVE = r'''
int main(){
 reset();addDeletedWorker();
 for(unsigned i=0;i<200;++i){loop();++f.now;}
 assertServices(200);assert(f.delayCalls==0 && f.idle1==0 && f.reaped==0);
 assert(f.pending.size()==1 && f.freeBytes==initialFreeBytes-workerStackBytes);
 assert(f.renders.size()==199/kBusyRenderIntervalMs);
 // This is conditional, not proof of a leak on every dual-core device.
 idle(0);assert(f.pending.empty() && f.freeBytes==initialFreeBytes);
 std::puts("NEGATIVE CONTROL actual old exclusive loop: idle1 gets no block opportunity; 12288 bytes retained only in CPU0-busy model, released by idle0 control");
}
'''


def run_case(text, tests):
    main_source = (ROOT / 'bots/CardputerADV/src/main_parts/001_main.cpp.inc').read_text()
    interval = re.search(r'constexpr uint32_t kBusyRenderIntervalMs\s*=\s*\d+;', main_source)
    if not interval:
        raise SystemExit('Render interval declaration changed; review test extraction.')
    code = CPP + interval.group() + '\n' + extract_function(text, 'void serviceRealtimeExclusiveLoop(')
    code += '\n' + extract_exclusive_prefix(text) + tests
    with tempfile.TemporaryDirectory(prefix='s1-rt-scheduler-') as directory:
        cpp = Path(directory) / 'test.cpp'
        binary = Path(directory) / 'test'
        cpp.write_text(code)
        subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        str(cpp), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-ref', help='Optional available Git ref for the old actual exclusive loop')
    args = parser.parse_args()
    if args.baseline_ref:
        old = subprocess.run(['git', 'show', f'{args.baseline_ref}:{SOURCE}'], cwd=ROOT,
                             check=True, capture_output=True, text=True).stdout
        run_case(old, NEGATIVE)
    run_case((ROOT / SOURCE).read_text(), POSITIVE)
    print('Scope: actual C++ service ordering + conditional scheduling model; not physical Wi-Fi/TX acceptance.')


if __name__ == '__main__':
    main()
