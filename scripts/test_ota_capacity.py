#!/usr/bin/env python3
"""Firmware screen redraws must not re-verify the entire running image."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
s = (root / 'bots/CardputerADV/src/main_parts/056_main.cpp.inc').read_text()
a = s.index('struct FirmwareCapacityInfo {')
struct = s[a:s.index('\n};', a) + 3]
a = s.index('FirmwareCapacityInfo firmwareCapacityInfo()')
i, depth = s.index('{', a) + 1, 1
while depth:
    depth += (s[i] == '{') - (s[i] == '}')
    i += 1
function = s[a:i]
code = r'''
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdlib>
using std::min;
struct esp_partition_t {uint32_t size=3145728;} slot;
bool fallback=false;unsigned imageReads=0;uint32_t imageSize=2008000;
const esp_partition_t* esp_ota_get_running_partition(){return fallback?nullptr:&slot;}
struct {uint32_t getSketchSize(){++imageReads;return imageSize;}
 uint32_t getFreeSketchSpace(){return 1000000;}} ESP;
''' + struct + function + r'''
int main(int argc,char**argv){
 int scenario=argc>1?atoi(argv[1]):0;
 if(scenario==1)fallback=true;
 if(scenario==2){slot.size=65536;imageSize=32000;}
 const auto first=firmwareCapacityInfo();
 for(int frame=0;frame<200;++frame){
  auto info=firmwareCapacityInfo();assert(imageReads==1);
  assert(info.usedBytes==first.usedBytes&&info.freeBytes==first.freeBytes);
  assert(info.usedPct<=100&&info.usableBytes<=info.slotBytes);
  assert(info.freeBytes==info.usableBytes-info.usedBytes);
 }
 if(scenario==1)assert(first.slotBytes==imageSize+1000000);
 if(scenario==2)assert(first.reserveBytes==0);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-ota-capacity-') as directory:
    p = Path(directory)
    (p / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', str(p / 'test.cpp'), '-o', str(p / 'test')], check=True)
    for scenario in range(3):
        subprocess.run([str(p / 'test'), str(scenario)], check=True)
print('PASS actual firmware capacity: one image verification across 200 frames, partition fallback and reserve bounds')
