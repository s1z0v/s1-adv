#!/usr/bin/env python3
"""Exercise the actual compact Home battery renderer without ESP32 hardware."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'bots/CardputerADV/src/main_parts/058_main.cpp.inc').read_text()
start = source.index('void drawHomeBatteryStatus(')
brace = source.index('{', start)
depth, end = 1, brace + 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
renderer = source[start:end]
code = r'''
#include <algorithm>
#include <cassert>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
using std::min;
namespace fonts { const int Font0=0, Font2=2; }
constexpr uint16_t rgb565_local(int r,int g,int b) {
 return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);
}
struct Canvas {
 struct Line {int x,y,w;uint16_t color;};
 std::vector<Line> lines;
 std::string label;
 const int* font=nullptr;
 int outlines=0,terminals=0,cursors=0,textSizes=0;
 uint16_t textColor=0;
 void drawRoundRect(int x,int y,int w,int h,int r,uint16_t) {
  assert(x==154 && y==125 && w==34 && h==6 && r==1); ++outlines;
 }
 void fillRect(int x,int y,int w,int h,uint16_t) {
  assert(x==188 && y==127 && w==2 && h==2); ++terminals;
 }
 void drawFastHLine(int x,int y,int w,uint16_t c) {lines.push_back({x,y,w,c});}
 void setFont(const int* f) {font=f;}
 void setTextSize(int s) {assert(s==1);++textSizes;}
 void setTextColor(uint16_t c,uint16_t bg) {
  assert(bg==rgb565_local(2,7,10)); textColor=c;
 }
 void setCursor(int x,int y) {assert(x==193 && y==124);++cursors;}
 void print(const char* s) {label=s;}
} gCanvas;
'''
code += renderer
code += r'''
int main() {
 const uint16_t cyan=rgb565_local(47,227,255), amber=rgb565_local(255,136,64);
 const uint16_t red=rgb565_local(255,63,85),dim=rgb565_local(23,48,59);
 for(int raw: {-1,INT_MIN,0,1,15,16,20,21,30,31,40,41,60,61,80,81,99,100,101,INT_MAX}) {
  gCanvas=Canvas{}; drawHomeBatteryStatus(raw);
  const bool known=raw>=0;
  const int level=known ? min(raw,100) : 0;
  const int lit=known ? (level*5+99)/100 : 0;
  const uint16_t accent=known && level<=15 ? red : known && level<=30 ? amber : cyan;
  assert(gCanvas.outlines==1 && gCanvas.terminals==1);
  assert(gCanvas.cursors==1 && gCanvas.textSizes==1);
  assert(gCanvas.font==&fonts::Font2);
  assert(gCanvas.label==(known ? std::to_string(level)+"%" : "--%"));
  assert(gCanvas.textColor==(known ? accent : rgb565_local(130,145,155)));
  assert(gCanvas.lines.size()==20);
  for(int i=0;i<5;++i) for(int row=0;row<4;++row) {
   const auto& line=gCanvas.lines[i*4+row];
   assert(line.w==4 && line.y==126+row);
   assert(line.x==156+i*6+(3-row)*2/3);
   assert(line.x>=155 && line.x+line.w-1<=186);
   assert(line.y>=126 && line.y<=129);
   assert(line.color==(i<lit ? accent : dim));
   if(i<4) {
    const auto& next=gCanvas.lines[(i+1)*4+row];
    assert(next.x-(line.x+line.w)==2); // visible gap between broad strokes
   }
  }
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-home-battery-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual Home battery renderer: five broad strokes, compact bounds, gaps, thresholds, labels, font restoration')
