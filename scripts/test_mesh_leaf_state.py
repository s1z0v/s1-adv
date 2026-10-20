#!/usr/bin/env python3
"""Exercise bounded radio data using the actual Mesh application model."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
CODE=r'''
#include "mesh_leaf_state.h"
#include <cassert>
#include <random>
#include <string>
using namespace s1_mesh;
int main() {
  static_assert(sizeof(State)<4096,"bounded mode-only state");
  State s;
  assert(!s.hear(0,0,-40) && !s.hear(UINT32_MAX,0,-40));
  for(uint32_t i=1;i<=16;++i)assert(s.hear(i,i,-90));
  assert(s.nodeCount==16);
  s.hear(1,100,-45);
  s.hear(17,101,-100);
  bool one=false,two=false,seventeen=false;
  for(const auto& n:s.nodes){one|=n.id==1;two|=n.id==2;seventeen|=n.id==17;}
  assert(one && !two && seventeen && s.nodeCount==16);
  State wrap;
  for(uint32_t i=1;i<=16;++i)wrap.hear(i,UINT32_MAX-32+i,-100);
  wrap.hear(17,5,-100);
  for(const auto& n:wrap.nodes)assert(n.id!=1);
  for(uint32_t i=0;i<1000;++i)s.message(10,i,false,reinterpret_cast<const uint8_t*>("hi"),2);
  assert(s.messageCount==8 && s.messages.front().id==992 && s.messages.back().id==999);
  s.message(10,999,false,reinterpret_cast<const uint8_t*>("duplicate"),9);
  assert(s.messageCount==8 && std::string(s.messages.back().text)=="hi");
  s.message(11,999,false,reinterpret_cast<const uint8_t*>("another sender"),14);
  assert(s.messages.back().from==11);
  assert(s.append("hello ") && s.append(u8"Привет"));
  s.erase();assert(std::string(s.input)==u8"hello Приве");
  while(s.input[0])s.erase();
  std::string exact(kTextBytes,'x');assert(s.append(exact.c_str()));
  assert(!s.append("y") && std::string(s.input)==exact);
  s.erase();assert(strlen(s.input)==kTextBytes-1);
  char clean[32];const uint8_t controls[]={0,'x',27,'\n',127,'y'};
  assert(copyText(clean,sizeof(clean),controls,sizeof(controls))==6);
  assert(std::string(clean)==" x   y");
  const std::string text=u8"aЖ😀z";
  for(size_t capacity=1;capacity<12;++capacity) {
    char b[12];memset(b,0x55,sizeof(b));
    size_t n=copyText(b,capacity,reinterpret_cast<const uint8_t*>(text.data()),text.size());
    assert(n<capacity && b[n]==0);
    for(size_t j=capacity;j<sizeof(b);++j)assert(b[j]==0x55);
    assert(n==0 || (uint8_t(b[n-1])&0xc0)!=0xc0);
  }
  std::mt19937 rng(1729);
  for(unsigned trial=0;trial<20000;++trial) {
    std::string in(rng()%300,' ');for(char& c:in)c=char(rng());
    char out[kTextBytes+2];memset(out,0x55,sizeof(out));
    size_t n=copyText(out,kTextBytes+1,reinterpret_cast<const uint8_t*>(in.data()),in.size());
    assert(n<=kTextBytes && out[n]==0 && out[kTextBytes+1]==0x55);
    for(size_t j=0;j<n;++j)assert(uint8_t(out[j])>=32 && uint8_t(out[j])!=127);
    s.message(42,trial,false,reinterpret_cast<const uint8_t*>(in.data()),in.size());
    assert(s.messageCount<=kMessages && strlen(s.messages.back().text)<=kTextBytes);
  }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-mesh-data-') as directory:
    cpp=Path(directory)/'model.cpp';exe=Path(directory)/'model';cpp.write_text(CODE)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-fno-omit-frame-pointer',
                    '-I'+str(ROOT/'bots/CardputerADV/src'),str(cpp),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
print('PASS Mesh actual model: bounded/LRU nodes, timer wrap, deduplicated history, UTF-8 composer and 20000 malformed packet payloads (ASan/UBSan)')
