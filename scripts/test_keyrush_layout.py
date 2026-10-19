#!/usr/bin/env python3
"""Execute the actual KeyRush renderer with conservative text bounds."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'bots/CardputerADV/src/main_parts/057_main.cpp.inc').read_text()
start = source.index('void renderKeyRushUi() {')
end = source.index('\nvoid renderIrRemoteButton(', start)
words_source = (root / 'bots/CardputerADV/src/main_parts/047_main.cpp.inc').read_text()
words = re.search(r'kKeyRushWords\[\] = \{(.*?)\};', words_source, re.S).group(1)
footer_source = (root / 'bots/CardputerADV/src/main_parts/053_main.cpp.inc').read_text()
footer_start = footer_source.index('void drawTinyFooter(')
footer_end = footer_source.index('\nvoid renderFocusUi()', footer_start)
code = r'''
#include <cassert>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cctype>
#include <string>
#include <type_traits>
#include <vector>
using std::min; using std::max;
struct String:std::string {
 using std::string::string;
 String(const std::string&s):std::string(s){}
 String(char c):std::string(1,c){}
 template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>
 String(T n):std::string(std::to_string(n)){}
};
namespace fonts {int Font0=0,Font2=2,Font4=4;}
constexpr uint16_t TFT_WHITE=0xffff;
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);}
struct Rect{int x,y,w,h;};
struct Canvas {
 const int*font=&fonts::Font0;int x=0,y=0;
 std::vector<Rect> text;
 int fontHeight(){return font==&fonts::Font0?8:font==&fonts::Font2?16:26;}
 int textWidth(const String&s){return int(s.size())*(font==&fonts::Font0?6:font==&fonts::Font2?10:25);}
 void setFont(const int*f){font=f;}
 void setTextColor(uint16_t,uint16_t){}
 void setCursor(int xx,int yy){x=xx;y=yy;}
 void print(const String&s){
  Rect r{x,y,textWidth(s),fontHeight()};
  assert(r.x>=6&&r.y>=5&&r.x+r.w<=234&&r.y+r.h<=129);
  for(auto p:text)assert(r.x+r.w<=p.x||p.x+p.w<=r.x||r.y+r.h<=p.y||p.y+p.h<=r.y);
  text.push_back(r);
 }
 void fillScreen(uint16_t){}
 void fillRect(int xx,int yy,int w,int h,uint16_t){for(auto p:text)assert(xx+w<=p.x||p.x+p.w<=xx||yy+h<=p.y||p.y+p.h<=yy);}
 template<class...T>void fillRoundRect(T...){}
 template<class...T>void drawRoundRect(T...){}
 template<class...T>void drawFastHLine(T...){}
}gCanvas;
struct {
 bool running=false,finished=false,feedbackCorrect=true;
 uint32_t endsAtMs=30000,feedbackUntilMs=0,bestScore=0,score=0,words=0,streak=0;
 uint8_t typedCount=0;
}gKeyRush;
uint32_t millis(){return 1000;}
void keyRushLoadBestOnce(){}
const char*target="claw";
const char*keyRushTargetWord(){return target;}
int keyRushAccuracy(){return 100;}int keyRushWpm(){return 999;}
String fitCurrentFontToWidth(const String&s,int width){return s.substr(0,width/(gCanvas.font==&fonts::Font0?6:gCanvas.font==&fonts::Font2?10:25));}
void renderLauncherOverlay(){}void renderDebugOverlay(){}
''' + footer_source[footer_start:footer_end] + source[start:end] + '\nconst char*words[]={' + words + r'''};
int main(){
 for(int state=0;state<3;++state)for(uint32_t value:{0U,999U,65535U,4294967295U})for(const char*word:words){
  gKeyRush.running=state==1;gKeyRush.finished=state==2;
  gKeyRush.score=gKeyRush.bestScore=value;gKeyRush.words=gKeyRush.streak=min(value,65535U);
  target=word;gCanvas=Canvas{};renderKeyRushUi();
  assert(!gCanvas.text.empty());
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-keyrush-layout-') as directory:
    p = Path(directory)
    (p / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    str(p / 'test.cpp'), '-o', str(p / 'test')], check=True)
    subprocess.run([str(p / 'test')], check=True)
print('PASS actual KeyRush renderer: 3 states, every target word and score extremes; bounded non-overlapping text')
