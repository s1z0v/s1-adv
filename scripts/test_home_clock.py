#!/usr/bin/env python3
"""Verify the actual Home clock color expression without ESP32 hardware."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'bots/CardputerADV/src/main_parts/059_main.cpp.inc').read_text()
match = re.search(r'd\.setTextColor\([^;]+, clockPanel\);', source)
assert match, 'Home clock text color must be set before printing the time'
assert match.end() < source.index('d.print(hhmm);')
code = r'''
#include <cassert>
#include <cstdint>
enum class AssistantPulseState {Ready, Recording, Thinking, Playback, Realtime};
constexpr uint16_t TFT_YELLOW = 0xffe0;
struct Canvas {
 uint16_t foreground=0,background=0;
 void setTextColor(uint16_t fg,uint16_t bg) {foreground=fg;background=bg;}
};
int main() {
 for(auto state : {AssistantPulseState::Ready, AssistantPulseState::Recording,
                   AssistantPulseState::Thinking, AssistantPulseState::Playback,
                   AssistantPulseState::Realtime}) {
  for(uint16_t fg : {uint16_t(0xffff),uint16_t(0xf800),uint16_t(0x07e0)}) {
   Canvas d;
   const uint16_t clockPanel=0x0324;
'''
code = '#include <initializer_list>\n' + code + match.group() + r'''
   assert(d.foreground==(state==AssistantPulseState::Ready ? TFT_YELLOW : fg));
   assert(d.background==clockPanel);
  }
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-home-clock-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS Home clock: yellow idle digits; recording/thinking/playback/realtime colors and background preserved')
