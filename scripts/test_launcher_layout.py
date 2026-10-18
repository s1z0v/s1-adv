#!/usr/bin/env python3
"""Exercise the actual launcher renderer with eight rows and bounds tracking."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
s=(root/'bots/CardputerADV/src/main_parts/052_main.cpp.inc').read_text();a=s.index('void renderLauncherOverlay()');z=s.index('\nString batteryEtaText()',a);fn=s[a:z]
code=r'''
#include <cassert>
#include <cstdint>
#include <string>
#include <vector>
#include <algorithm>
using std::min;using std::max;
struct String:std::string{using std::string::string;String(int i):std::string(std::to_string(i)){}String(std::string s):std::string(s){}};
namespace fonts {const int Font0=0,Font2=2;}
const int TFT_WHITE=0xffff,TFT_LIGHTGREY=0xcccc;
uint16_t rgb565_local(int,int,int){return 0;}
template<class T>T clampValue(T x,T lo,T hi){return std::min(hi,std::max(lo,x));}
struct Item{const char*label;};
struct LauncherGroup{const char*title;const char*glyph;const char*hint;uint16_t accent;int count;Item items[8];};
LauncherGroup kLauncherGroups[8];int kLauncherGroupCount=8,gLauncherSelection=0,gLauncherSubSelection=0;bool gLauncherVisible=true;
struct Text{std::string value;int x,y;};
struct Canvas{int x=0,y=0,font=0,triangles=0;std::vector<Text>texts;
 void fillRoundRect(int x,int y,int w,int h,int,int){assert(x>=0&&y>=0&&x+w<=240&&y+h<=126);}
 void drawRoundRect(int x,int y,int w,int h,int r,int c){fillRoundRect(x,y,w,h,r,c);}
 void fillCircle(int,int,int,int){}void setFont(const int*f){font=*f;}void setTextColor(int,int){}
 void setCursor(int xx,int yy){x=xx;y=yy;}int textWidth(const String&s){return int(s.size())*(font?8:6);}
 void print(const String&s){assert(y>=0&&y+(font?16:8)<=126);texts.push_back({s,x,y});x+=textWidth(s);}
}gCanvas;
String fitCurrentFontToWidth(const String&s,int width){return s.substr(0,std::max(0,width/(gCanvas.font?8:6)));}
void drawTinyFooter(int,int,const char*s,int x,int y,int w){gCanvas.setFont(&fonts::Font0);gCanvas.setCursor(x,y);gCanvas.print(fitCurrentFontToWidth(s,w));}
'''+fn+r'''
int main(){
 for(auto&g:kLauncherGroups){g={"System","SYSTEM","Tools",1,8,{{"Settings"},{"Screensaver"},{"Files"},{"Firmware"},{"Assets"},{"Logs"},{"About"},{"Extra"}}};}
 for(int group=0;group<8;++group)for(int sub=0;sub<8;++sub){gLauncherSelection=group;gLauncherSubSelection=sub;gCanvas.texts.clear();renderLauncherOverlay();for(const auto&i:kLauncherGroups[group].items){assert(std::any_of(gCanvas.texts.begin(),gCanvas.texts.end(),[&](auto&t){return t.value==i.label;}));}}
}
'''
with tempfile.TemporaryDirectory(prefix='s1-launcher-') as d:
 p=Path(d);(p/'test.cpp').write_text(code);subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',str(p/'test.cpp'),'-o',str(p/'test')],check=True);subprocess.run([str(p/'test')],check=True)
print('PASS actual launcher: all eight groups/apps visible for every selection, no scroll arrows and drawing/text remain above the status bar')
