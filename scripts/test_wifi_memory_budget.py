#!/usr/bin/env python3
"""Build the actual Wi-Fi budget header/wrapper with offline SDK fixtures.

The real driver is a recording stub and logging is an allocation-free sink.
The test denies allocations added by this wrapper; the real ESP-IDF driver
intentionally allocates packet pools and is not being simulated here.
Target linker --wrap routing and physical heap/TLS behavior need separate
firmware/device checks. No SDK, network or device is modified.
"""
import argparse
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

FAKE_WIFI = r'''
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <new>
using esp_err_t=int;
struct wifi_osi_funcs_t {uint32_t marker;};
struct wpa_crypto_funcs_t {uint64_t opaque[7];};
struct wifi_init_config_t {
 void (*event_handler)(void*);
 wifi_osi_funcs_t* osi_funcs;
 wpa_crypto_funcs_t wpa_crypto_funcs;
 int static_rx_buf_num,dynamic_rx_buf_num,tx_buf_type,static_tx_buf_num,dynamic_tx_buf_num;
 int cache_tx_buf_num,csi_enable,ampdu_rx_enable,ampdu_tx_enable,amsdu_tx_enable;
 int nvs_enable,nano_enable,rx_ba_win,wifi_task_core_id,beacon_max_len,mgmt_sbuf_num;
 uint64_t feature_caps;
 bool sta_disconnected_pm;
 int espnow_max_encrypt_num,magic;
 // An opaque test extension also must survive a value-copy budget wrapper.
 unsigned char foreign[29];
};
extern "C" void* budget_forbidden_malloc(std::size_t);
extern "C" void* budget_forbidden_calloc(std::size_t,std::size_t);
extern "C" void* budget_forbidden_realloc(void*,std::size_t);
// SDK declarations are already parsed. Direct C allocations added to the
// actual production translation unit must not silently pass the heap test.
#define malloc budget_forbidden_malloc
#define calloc budget_forbidden_calloc
#define realloc budget_forbidden_realloc
'''

FAKE_LOG = r'''
#pragma once
void budget_test_log(const char*,const char*,...);
#define ESP_LOGI(...) budget_test_log(__VA_ARGS__)
'''

CPP = r'''
#include <esp_wifi.h>
#undef malloc
#undef calloc
#undef realloc
#include "wifi_memory_budget.h"
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <initializer_list>

bool forbidNew=false;
unsigned newCalls=0;
void* operator new(std::size_t n){
 ++newCalls;assert(!forbidNew && "Wi-Fi budget wrapper unexpectedly allocated heap");
 if(void* p=std::malloc(n?n:1))return p;
 throw std::bad_alloc();
}
void* operator new[](std::size_t n){return ::operator new(n);}
void operator delete(void* p)noexcept{std::free(p);}
void operator delete[](void* p)noexcept{std::free(p);}
void operator delete(void* p,std::size_t)noexcept{std::free(p);}
void operator delete[](void* p,std::size_t)noexcept{std::free(p);}
extern "C" void* budget_forbidden_malloc(std::size_t){std::abort();}
extern "C" void* budget_forbidden_calloc(std::size_t,std::size_t){std::abort();}
extern "C" void* budget_forbidden_realloc(void*,std::size_t){std::abort();}

struct Driver {
 unsigned calls=0,logs=0;
 bool sawNull=false,sawCopy=false;
 const wifi_init_config_t* caller=nullptr;
 wifi_init_config_t captured{};
 esp_err_t returnCode=0;
 int logArgs[5]{};
} driver;
extern "C" esp_err_t __wrap_esp_wifi_init(const wifi_init_config_t*);
extern "C" esp_err_t __real_esp_wifi_init(const wifi_init_config_t* config){
 ++driver.calls;
 driver.sawNull=config==nullptr;
 if(config){driver.sawCopy=config!=driver.caller;driver.captured=*config;}
 return driver.returnCode;
}
void budget_test_log(const char* tag,const char* format,...){
 assert(std::strcmp(tag,"wifi-budget")==0 && format);
 ++driver.logs;va_list args;va_start(args,format);
 for(auto& value:driver.logArgs)value=va_arg(args,int);
 va_end(args);
}
void eventHandler(void*){}
wifi_osi_funcs_t osi{0x12345678U};
wifi_init_config_t original(){
 wifi_init_config_t cfg{};
 cfg.event_handler=eventHandler;cfg.osi_funcs=&osi;
 for(unsigned i=0;i<7;++i)cfg.wpa_crypto_funcs.opaque[i]=0xFAE0D0C0B0A09080ULL+i;
 cfg.static_rx_buf_num=4;cfg.dynamic_rx_buf_num=32;
 cfg.tx_buf_type=1;cfg.static_tx_buf_num=17;cfg.dynamic_tx_buf_num=32;
 cfg.cache_tx_buf_num=4;cfg.csi_enable=1;cfg.ampdu_rx_enable=1;
 cfg.ampdu_tx_enable=1;cfg.amsdu_tx_enable=1;cfg.nvs_enable=1;cfg.nano_enable=1;
 cfg.rx_ba_win=16;cfg.wifi_task_core_id=1;cfg.beacon_max_len=900;cfg.mgmt_sbuf_num=12;
 cfg.feature_caps=0xF0E1D2C3B4A59687ULL;cfg.sta_disconnected_pm=true;
 cfg.espnow_max_encrypt_num=7;cfg.magic=0x1F2F3F4F;
 for(unsigned i=0;i<sizeof(cfg.foreign);++i)cfg.foreign[i]=static_cast<unsigned char>(i*7+3);
 return cfg;
}
void equalFields(const wifi_init_config_t& a,const wifi_init_config_t& b){
 // Compare values and opaque payload bits, not unspecified struct padding.
 assert(a.event_handler==b.event_handler && a.osi_funcs==b.osi_funcs);
 assert(std::memcmp(&a.wpa_crypto_funcs,&b.wpa_crypto_funcs,sizeof(a.wpa_crypto_funcs))==0);
 assert(a.static_rx_buf_num==b.static_rx_buf_num && a.dynamic_rx_buf_num==b.dynamic_rx_buf_num);
 assert(a.tx_buf_type==b.tx_buf_type && a.static_tx_buf_num==b.static_tx_buf_num);
 assert(a.dynamic_tx_buf_num==b.dynamic_tx_buf_num && a.cache_tx_buf_num==b.cache_tx_buf_num);
 assert(a.csi_enable==b.csi_enable && a.ampdu_rx_enable==b.ampdu_rx_enable);
 assert(a.ampdu_tx_enable==b.ampdu_tx_enable && a.amsdu_tx_enable==b.amsdu_tx_enable);
 assert(a.nvs_enable==b.nvs_enable && a.nano_enable==b.nano_enable && a.rx_ba_win==b.rx_ba_win);
 assert(a.wifi_task_core_id==b.wifi_task_core_id && a.beacon_max_len==b.beacon_max_len);
 assert(a.mgmt_sbuf_num==b.mgmt_sbuf_num && a.feature_caps==b.feature_caps);
 assert(a.sta_disconnected_pm==b.sta_disconnected_pm && a.espnow_max_encrypt_num==b.espnow_max_encrypt_num);
 assert(a.magic==b.magic && std::memcmp(a.foreign,b.foreign,sizeof(a.foreign))==0);
}
wifi_init_config_t exercise(const wifi_init_config_t& input,int tx,int rx,int ba,esp_err_t code=0){
 const auto before=input;
 auto expected=input;expected.dynamic_tx_buf_num=tx;expected.dynamic_rx_buf_num=rx;expected.rx_ba_win=ba;
 driver=Driver{};driver.caller=&input;driver.returnCode=code;
 const unsigned allocations=newCalls;
 forbidNew=true;const auto actual=__wrap_esp_wifi_init(&input);forbidNew=false;
 assert(actual==code && driver.calls==1 && driver.sawCopy && !driver.sawNull && driver.logs==1);
 assert(newCalls==allocations);
 equalFields(input,before);equalFields(driver.captured,expected);
 assert(driver.logArgs[0]==rx && driver.logArgs[1]==tx && driver.logArgs[2]==input.static_rx_buf_num);
 assert(driver.logArgs[3]==ba && driver.logArgs[4]==code);
 return driver.captured;
}
void normalAndLimited(){
 static_assert(wifi_memory_budget::kPacketBuffers==16,"Review budget contract if changed");
 auto cfg=original();auto limited=exercise(cfg,16,16,16);
 exercise(limited,16,16,16); // Applying the wrapper again is idempotent.
 cfg=original();cfg.dynamic_tx_buf_num=3;cfg.dynamic_rx_buf_num=6;cfg.rx_ba_win=4;
 exercise(cfg,3,6,4);
 cfg=original();cfg.dynamic_tx_buf_num=8;cfg.dynamic_rx_buf_num=8;cfg.rx_ba_win=8;
 exercise(cfg,8,8,8);
 cfg=original();cfg.dynamic_tx_buf_num=16;cfg.dynamic_rx_buf_num=16;cfg.rx_ba_win=16;
 exercise(cfg,16,16,16);
 cfg=original();cfg.static_rx_buf_num=2;cfg.dynamic_tx_buf_num=1;cfg.dynamic_rx_buf_num=2;cfg.rx_ba_win=2;
 exercise(cfg,1,2,2);
 cfg=original();cfg.tx_buf_type=0;cfg.static_tx_buf_num=6;
 exercise(cfg,32,16,16); // Dynamic TX field is ignored in static mode, preserved.
 cfg=original();cfg.ampdu_rx_enable=0;cfg.rx_ba_win=24;
 exercise(cfg,16,16,24);
 std::puts("PASS actual wrapper defaults 16/16/16, valid smaller/exact budgets, static-TX preservation and disabled AMPDU");
}
void receiveBounds(){
 auto cfg=original();cfg.dynamic_rx_buf_num=0;exercise(cfg,16,16,16);
 cfg=original();cfg.rx_ba_win=32;exercise(cfg,16,16,16);
 cfg=original();cfg.static_rx_buf_num=12;exercise(cfg,16,16,16);
 cfg=original();cfg.static_rx_buf_num=12;cfg.dynamic_rx_buf_num=0;exercise(cfg,16,16,16);
 cfg=original();cfg.static_rx_buf_num=25;cfg.dynamic_rx_buf_num=128;cfg.rx_ba_win=32;
 const auto limited=exercise(cfg,16,25,25);assert(limited.dynamic_rx_buf_num>=limited.static_rx_buf_num);
 cfg=original();cfg.static_rx_buf_num=12;cfg.dynamic_rx_buf_num=12;cfg.rx_ba_win=8;
 exercise(cfg,16,12,8);
 std::puts("PASS unlimited/high RX is capped without dropping below static RX; smaller valid windows survive");
}
void passthroughAndErrors(){
 for(const esp_err_t code:{0,0x101,-7}){
  driver=Driver{};driver.returnCode=code;const unsigned allocations=newCalls;
  forbidNew=true;const auto result=__wrap_esp_wifi_init(nullptr);forbidNew=false;
  assert(result==code && driver.calls==1 && driver.sawNull && !driver.sawCopy && driver.logs==0);
  assert(newCalls==allocations);
  exercise(original(),16,16,16,code);
 }
 std::puts("PASS nullptr reaches real driver once and driver errors propagate unchanged");
}
int main(){
 normalAndLimited();receiveBounds();passthroughAndErrors();
 std::puts("PASS caller unchanged, real init receives a distinct copied config, all foreign/crypto/feature/magic fields preserved, no wrapper allocations with fixture dependencies");
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', action='store_true')
    args = parser.parse_args()
    source_dir = ROOT / 'bots/CardputerADV/src'
    wrapper = source_dir / 'wifi_memory_budget.cpp'
    if not wrapper.is_file() or not (source_dir / 'wifi_memory_budget.h').is_file():
        raise SystemExit('Production Wi-Fi budget sources are missing.')
    flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror']
    if args.sanitize:
        flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
    with tempfile.TemporaryDirectory(prefix='s1-wifi-budget-') as directory:
        temporary = Path(directory)
        (temporary / 'esp_wifi.h').write_text(FAKE_WIFI)
        (temporary / 'esp_log.h').write_text(FAKE_LOG)
        test = temporary / 'test.cpp'
        test.write_text(CPP)
        binary = temporary / 'test'
        subprocess.run([os.environ.get('CXX', 'c++'), *flags, '-I', str(temporary), '-I', str(source_dir),
                        str(test), str(wrapper), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
    print('Scope: actual header/wrapper with offline SDK/log fixtures; target --wrap linkage and physical heap/TLS behavior require separate checks.')


if __name__ == '__main__':
    main()
