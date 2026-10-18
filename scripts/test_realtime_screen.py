#!/usr/bin/env python3
"""Run the actual Realtime overlay for every mic/transport phase."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'bots/CardputerADV/src/main_parts/064_main.cpp.inc').read_text()
def function(signature):
 a=source.index(signature);b=source.index('{',a);depth=1;end=b+1
 while depth:depth+=(source[end]=='{')-(source[end]=='}');end+=1
 return source[a:end]
code=r'''
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
struct String:std::string {using std::string::string;using std::string::operator=;
 String(const std::string& s):std::string(s){}bool isEmpty()const{return empty();}};
String gRealtimeUiError;
bool gRealtimeRecording=false,gRealtimeActive=false,gRealtimeConnected=false;
bool gPendingRealtimeStart=false,gRealtimeRestartAfterPlayback=false;
bool gRealtimePlaybackActive=false,gPlaybackActive=false,gRealtimeAwaiting=false;
namespace fonts {int Font0,Font2;}
uint32_t millis(){return 100;}
uint16_t rgb565_local(uint8_t r,uint8_t g,uint8_t b){return ((r>>3)<<11)|((g>>2)<<5)|(b>>3);}
struct {bool requested=false;uint8_t level=0;uint8_t visibleLevel(bool on,uint32_t){requested=on;return on?level:0;}} gMicInputMeter;
std::vector<std::string> labels;std::vector<int> widths;int base=0,bars=0,cursorX=0,cursorY=0;
void renderUncannyEyesUi(){++base;}
struct {
 void setFont(int*){}void setTextSize(int){}int textWidth(const char* s){return strlen(s)*6;}
 void fillRoundRect(int x,int y,int w,int h,int,uint16_t){assert(x>=0&&y>=0&&x+w<=240&&y+h<=135);widths.push_back(w);}
 void fillCircle(int x,int y,int r,uint16_t){assert(x-r>=0&&y-r>=0&&x+r<240&&y+r<135);}
 void fillRect(int x,int y,int w,int h,uint16_t){assert(w<240&&x+w<=240&&y+h<=135);++bars;}
 void setTextColor(uint16_t,uint16_t){}void setCursor(int x,int y){cursorX=x;cursorY=y;}
 void print(const std::string& s){assert(cursorX+int(s.size())*6<=240&&cursorY+8<=135);labels.push_back(s);}
} gCanvas;
String fitCurrentFontToWidth(const String& s,int w){return s.substr(0,w/6);}
'''
code+='\n'+function('const char* realtimeStageLabel()')
code+='\n'+function('void renderRealtimeEyesUi()')
code+=r'''
void check(const char* stage,bool mic){
 labels.clear();widths.clear();base=bars=0;renderRealtimeEyesUi();assert(base==1&&gMicInputMeter.requested==mic);
 assert(labels[0]==stage&&labels[1]==(mic?"MIC ON":"MIC OFF"));
 for(int w:widths)assert(w<240); // No full-width header/footer can return.
 if(!mic)assert(bars==0);
}
int main(){
 check("OFF",false);gPendingRealtimeStart=true;check("PREPARE",false);gPendingRealtimeStart=false;
 gRealtimeActive=true;check("PREPARE",false);gRealtimeConnected=true;check("READY",false);
 gRealtimeRecording=true;check("LISTEN",true);assert(bars==0);
 gMicInputMeter.level=255;check("LISTEN",true);assert(bars==3);
 gRealtimeRecording=false;gRealtimeAwaiting=true;check("THINK",false);gRealtimeAwaiting=false;
 gPlaybackActive=true;check("SPEAK",false);gPlaybackActive=false;
 gRealtimeRestartAfterPlayback=true;check("PREPARE",false);
 gRealtimeUiError="Connection lost. Ctrl+R retry";check("ERROR",false);assert(labels.size()==3);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-rt-screen-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS full-eye overlay, all Realtime phases, true mic state, quiet meter and bounded badges')
