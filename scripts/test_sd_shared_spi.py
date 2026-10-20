#!/usr/bin/env python3
"""Exercise the actual SD mount helper with a selected Cap/RC522 SPI slave."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root/'bots/CardputerADV/src/main_parts/032_main.cpp.inc').read_text()
start = source.index('bool mountSdCardOnSharedSpi() {')
end = source.index('\nvoid initStorage()', start)
helper = source[start:end]
assert source.count('gSdReady = mountSdCardOnSharedSpi();') == 2
assert source.count('gSdSpi.begin(') == source.count('SD.begin(') == 1
assert source.index('gSdReady = mountSdCardOnSharedSpi();', end) < source.index('bool remountSdStorage(')
assert source.index('gSdReady = mountSdCardOnSharedSpi();', source.index('bool remountSdStorage(')) > end

fixture = r'''
#include <cassert>
#include <array>
#include <cstdint>
#include <iostream>
constexpr int HIGH=1, OUTPUT=1, CARD_NONE=0;
constexpr uint8_t kRfidCsPin=5, kSdCsPin=12, kSdSckPin=40, kSdMisoPin=39, kSdMosiPin=14;
constexpr uint32_t kSdFrequencyHz=4000000;
std::array<int,49> level{},mode{};
bool cap=false,beginOk=true;int card=1,begins=0,typeReads=0,ends=0,spiBegins=0,writes=0;
void digitalWrite(int pin,int value){assert(pin==5||pin==12);assert(value==HIGH);level[pin]=value;++writes;}
void pinMode(int pin,int value){assert(pin==5||pin==12);assert(value==OUTPUT);assert(level[pin]==HIGH);mode[pin]=value;}
struct Spi {
 void begin(int sck,int miso,int mosi,int cs){assert(sck==40&&miso==39&&mosi==14&&cs==12);++spiBegins;}
}gSdSpi;
struct Sd {
 bool begin(int cs,Spi& spi,uint32_t hz){assert(cs==12&&&spi==&gSdSpi&&hz==4000000);++begins;
  return beginOk&&(!cap||level[5]==HIGH)&&level[12]==HIGH;}
 int cardType(){++typeReads;return card;}
 void end(){++ends;}
}SD;
bool gSdReady=false, gMeshBusOwned=false;
'''
main = r'''
void reset(bool attached,int ext,int sd,bool ok,int type) {
 level.fill(7);mode.fill(7);level[kRfidCsPin]=ext;level[12]=sd;cap=attached;beginOk=ok;card=type;
 begins=typeReads=ends=spiBegins=writes=0;
}
int main(int argc,char**) {
 if(argc>1){ // Recorded failure condition: Cap selected, SD initially deselected.
  reset(true,0,1,true,1);
  if(!mountSdCardOnSharedSpi())return 42;
  return 0;
 }
 int cases=0;
 for(bool attached:{false,true})for(int ext:{0,1})for(int sd:{0,1})
  for(bool ok:{false,true})for(int type:{0,1}) {
   reset(attached,ext,sd,ok,type);
   bool mounted=mountSdCardOnSharedSpi();
   assert(mounted==(ok&&type!=CARD_NONE));
   assert(spiBegins==1&&begins==1&&typeReads==int(ok)&&ends==int(ok&&type==CARD_NONE));
   assert(level[5]==HIGH&&level[12]==HIGH&&mode[5]==OUTPUT&&mode[12]==OUTPUT&&writes==2);
   for(int pin:{3,4,6,8,9,13,15})assert(level[pin]==7&&mode[pin]==7);
   ++cases;
  }
 assert(cases==32);
 std::cout<<"PASS 32 Cap/card/bus-state combinations; both CS idle, latch preload, exact SPI pins/clock and CARD_NONE cleanup\n";
}
'''
# Literal old SD sequence from 0.2.195/source371c3a2, wrapped only to return its
# result. This has no expansion-CS initialization and reproduces the collision.
legacy = r'''
bool mountSdCardOnSharedSpi() {
  gSdSpi.begin(kSdSckPin, kSdMisoPin, kSdMosiPin, kSdCsPin);
  gSdReady = SD.begin(kSdCsPin, gSdSpi, kSdFrequencyHz);
  if (gSdReady && SD.cardType() == CARD_NONE) {
    SD.end();
    gSdReady = false;
  }
  return gSdReady;
}
'''
with tempfile.TemporaryDirectory(prefix='s1-sd-shared-spi-') as directory:
    directory = Path(directory)
    for name,body,args,expected in [
        ('production',helper,[],0),
        ('legacy0195',legacy,['cap-selected'],42),
        ('missing-expansion-deselect',helper.replace('  digitalWrite(kRfidCsPin, HIGH);\n  pinMode(kRfidCsPin, OUTPUT);\n',''),['cap-selected'],42),
    ]:
        cpp=directory/(name+'.cpp');binary=directory/name
        cpp.write_text(fixture+body+main)
        subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',str(cpp),'-o',str(binary)],check=True)
        result=subprocess.run([str(binary),*args],check=False)
        assert result.returncode==expected,(name,result.returncode,expected)
print('PASS legacy failure reproduced and missing-deselect mutant rejected; boot/remount use the same actual helper')
