#!/usr/bin/env python3
"""Check the actual Cap radio setup, without transmitting or touching hardware."""
import os
from pathlib import Path
import subprocess
import tempfile
ROOT=Path(__file__).resolve().parents[1]
RADIO=r'''
#pragma once
#include <cassert>
#include <cstdint>
constexpr int RADIOLIB_ERR_UNKNOWN=-1,RADIOLIB_SX126X_SYNC_WORD_PRIVATE=0x12;
inline int step=0,failure=0;
inline int result(){return ++step==failure ? -19 : 0;}
struct SPIClass{};
struct Module {
 struct {int timeout=1000;}spiConfig;SPIClass* spi;
 Module(int cs,int irq,int rst,int busy,SPIClass& bus):spi(&bus){assert(cs==5&&irq==4&&rst==3&&busy==6);}
};
struct SX1262 {
 Module* module;explicit SX1262(Module*m):module(m){}
 int begin(float f,float bw,int sf,int cr,int sync,int power,int preamble,float tcxo) {
  assert(f==923.875f&&bw==250&&sf==11&&cr==5&&sync==0x12&&power==10&&preamble==16&&tcxo==1.8f);return result();
 }
 int setDio2AsRfSwitch(bool b){assert(b);return result();}
 int setCurrentLimit(float n){assert(n==140);return result();}
 int setCRC(int n){assert(n==2);return result();}
};
'''
LEAF=r'''
#pragma once
namespace libmeshtastic_leaf {
constexpr int REGION_TH=12,PRESET_LONG_FAST=0;
struct MeshConfig {struct{int region=-1,preset=-1,txPower=0;}radio;int hopLimit=0;};
struct libmeshtastic_leaf {
 void setOwner(const char* a,const char*b){assert(std::string(a)=="S1-ADV"&&std::string(b)=="S1");}
 bool begin(const MeshConfig&c,SX1262*){assert(step==4&&c.radio.region==12&&c.radio.preset==0&&c.radio.txPower==10&&c.hopLimit==3);return result()==0;}
};
}
'''
CODE=r'''
#include <string>
#include "mesh_cap_radio.h"
int main(){
 SPIClass spi;
 for(failure=0;failure<=5;++failure){
  step=0;s1_mesh::RadioSession session(spi);
  assert(session.module.spi==&spi&&session.module.spiConfig.timeout==250);
  assert(session.initResult.load()==s1_mesh::kInitPending);
  int e=session.initialize();
  if(!failure)assert(!e&&step==5);
  else assert(e==(failure==5?-1:-19)&&step==failure);
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-mesh-radio-') as directory:
    p=Path(directory);(p/'RadioLib.h').write_text(RADIO);(p/'libmeshtastic_leaf.h').write_text(LEAF)
    (p/'radio.cpp').write_text(CODE)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',
                    '-I'+str(p),'-I'+str(ROOT/'bots/CardputerADV/src'),str(p/'radio.cpp'),'-o',str(p/'radio')],check=True)
    subprocess.run([str(p/'radio')],check=True)
print('PASS actual Cap setup: SPI identity/pins, bounded BUSY timeout, TCXO, RF switch, CRC, TH/LongFast/10 dBm, and every initialization error propagated')
