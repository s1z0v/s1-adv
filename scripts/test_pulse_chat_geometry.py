#!/usr/bin/env python3
"""Keep owner-approved outline Pulse arcs and the centered chat chevron."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'


def function(filename, signature):
    source = (parts / filename).read_text()
    start = source.index(signature)
    end = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


code = r'''
#include <cassert>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>
using std::max;
constexpr float kPi=3.14159265358979323846f;
struct Arc {int x,y,outer,inner;float start,end;};
struct Circle {int x,y,r;};
struct Line {int x1,y1,x2,y2;};
struct Rect {int x,y,w,h;};
struct Canvas {
 std::vector<Arc> arcs;std::vector<Circle> circles;std::vector<Line> lines;Rect rect{};
 void drawArc(int x,int y,int outer,int inner,float start,float end,uint16_t){
  assert(start>=0&&start<360&&end>=0&&end<360);
  arcs.push_back({x,y,outer,inner,start,end});
 }
 void fillArc(int,int,int,int,float,float,uint16_t){assert(false && "Filled Pulse arcs are an owner-rejected regression");}
 void fillCircle(int x,int y,int r,uint16_t){circles.push_back({x,y,r});}
 void fillRoundRect(int x,int y,int w,int h,int,uint16_t){rect={x,y,w,h};}
 void drawLine(int x1,int y1,int x2,int y2,uint16_t){lines.push_back({x1,y1,x2,y2});}
}gCanvas;
''' + function('058_main.cpp.inc', 'void drawAssistantPulseArc(') + '\n' + function(
    '060_main.cpp.inc', 'void drawChatComposerPrompt(') + r'''
int main(){
 // Execute the actual helper across negative angles and wrap boundaries.
 // The accepted design uses outline bands, with the original round endpoints.
 for(int tick=-1080;tick<1080;++tick)for(auto radii:{std::pair<int,int>{45,36},{31,23},{22,16}}){
  gCanvas=Canvas{};float a=tick*kPi/180;
  drawAssistantPulseArc(58,68,radii.first,radii.second,a,a+0.72f,1);
  assert(gCanvas.arcs.size()==1&&gCanvas.circles.size()==2);
  auto arc=gCanvas.arcs[0];float mid=(arc.outer+arc.inner)*0.5f;
  for(int i=0;i<2;++i){
   auto c=gCanvas.circles[i];float phase=i?a+0.72f:a;
   assert(c.x==58+int(cosf(phase)*mid));
   assert(c.y==68+int(sinf(phase)*mid));
   assert(c.r==max(2,(arc.outer-arc.inner)/2));
  }
 }
 // One-, two- and three-line composers: symmetric chevron inside its pill.
 for(int h:{17,28,39}){
  gCanvas=Canvas{};int y=135-h-13;
  drawChatComposerPrompt(y,h,0,1);
  assert(gCanvas.lines.size()==2);
  auto a=gCanvas.lines[0],b=gCanvas.lines[1];auto box=gCanvas.rect;
  assert(a.x2==b.x1&&a.y2==b.y1&&a.x1==b.x2);
  assert(a.y2-a.y1==b.y2-b.y1&&a.y2==y+h/2);
  for(auto line:gCanvas.lines)for(auto p:{std::pair<int,int>{line.x1,line.y1},{line.x2,line.y2}})
   assert(p.first>box.x&&p.first<box.x+box.w-1&&p.second>box.y&&p.second<box.y+box.h-1);
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-pulse-chat-') as directory:
    p = Path(directory)
    (p / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    str(p / 'test.cpp'), '-o', str(p / 'test')], check=True)
    subprocess.run([str(p / 'test')], check=True)
print('PASS actual pulse/chat helpers: outline-only arcs with original caps, centered chevron at every composer height')
