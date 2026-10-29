#!/usr/bin/env python3
"""Production renderer, idle entry/wake, dim/off rules and preview controls."""
from pathlib import Path
import os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1];PARTS=ROOT/'bots/CardputerADV/src/main_parts';SRC=PARTS.parent
APP=(PARTS/'072_main.cpp.inc').read_text()
def fn(file,signature):
 s=(PARTS/file).read_text();a=s.index(signature);i=s.index('{',a)+1;depth=1
 while depth:depth+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
scene=(PARTS/'024_main.cpp.inc').read_text();a=scene.index('  bool enteringScreensaverUi =');z=scene.index('  gLauncherVisible = false;',a);scene=scene[a:z]
STUB=r'''
#include "chess_mind.h"
#include "clock_display.h"
#include <cassert>
#include <cstdint>
#include <string>
#include <vector>
#include <algorithm>
#include <ctime>
#include <cctype>
#include <cstdio>
using std::min;using std::max;
struct String:std::string{using std::string::string;String()=default;String(const std::string&s):std::string(s){}};
namespace fonts{int Font0=0,Font2=2;}
int rgb565_local(int r,int g,int b){return ((r&248)<<8)|((g&252)<<3)|(b>>3);}
struct Canvas{
 const int*font=&fonts::Font0;int x=0,y=0,prints=0;std::vector<String>texts;
 void bounds(int a,int b,int w,int h){assert(a>=0&&b>=0&&w>0&&h>0&&a+w<=240&&b+h<=135);}
 void fillScreen(int){texts.clear();prints=0;}
 void fillRect(int a,int b,int w,int h,int){bounds(a,b,w,h);}
 void drawRect(int a,int b,int w,int h,int c){fillRect(a,b,w,h,c);}
 void fillRoundRect(int a,int b,int w,int h,int,int c){fillRect(a,b,w,h,c);}
 void fillCircle(int a,int b,int r,int c){fillRect(a-r,b-r,2*r+1,2*r+1,c);}
 void setFont(const int*f){font=f;}void setTextColor(int,int){}
 void setCursor(int a,int b){x=a;y=b;}int textWidth(const String&s){return s.size()*(font==&fonts::Font2?8:6);}
 void print(const String&s){if(s.empty())return;bounds(x,y,textWidth(s),font==&fonts::Font2?16:8);texts.push_back(s);++prints;}
 void print(char c){print(String(1,c));}
}gCanvas;
String fitCurrentFontToWidth(String s,int w){while(!s.empty()&&gCanvas.textWidth(s)>w)s.pop_back();return s;}
void renderLauncherOverlay(){}void renderDebugOverlay(){}
struct Keyboard_Class{struct KeysState{bool ctrl=false,alt=false,opt=false,enter=false;};};
enum class UiMode{Home,Clock,Face,CMatrix,ChessMind,Ota,ChatFull};UiMode gUiMode=UiMode::Home,gScreensaverPreviousMode=UiMode::Home;
uint32_t tick=1000,gLastRenderMs=0;uint32_t millis(){return tick;}uint32_t esp_random(){return 42;}
struct{void invalidate(){}}gUiFramePolicy;
bool gScreensaverActive=false,gScreensaverDimmed=false,gScreenOffActive=false;
bool gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false,gVoiceNoticeVisible=false,gVoiceReplySpeechBusy=false,gTransferUiActive=false,gOtaApplyInProgress=false,gPendingRestart=false;
bool gLauncherVisible=false,gCMatrixInitialized=true;uint32_t gScreensaverStartedMs=0,gLastUserActivityMs=1000,gLastUserInputMs=1000;
struct{
 uint8_t displayBrightnessPct=70,screensaverDimBrightnessPct=10,screensaverStyle=0;
 uint8_t screensaverTimeoutMin=1,screensaverDimAfterMin=1,screenOffAfterMin=5;
 bool screensaverEnabled=true,screenAutoOffEnabled=true,screensaverClockOnWake=false,clockTwelveHour=false;
}gDeviceSettings;
struct{struct{int brightness=-1;void setBrightness(int n){assert(n>=0&&n<=255);brightness=n;}}Display;}M5Cardputer;
template<class T>T clampValue(T n,T lo,T hi){return std::min(hi,std::max(lo,n));}
uint8_t percentToByte(uint8_t p){return (unsigned(p)*255+50)/100;}
void setStatus(const String&,int){}int eyesReset=0;void resetUncannyEyesRenderer(){++eyesReset;}
void setUiMode(UiMode mode);void applyDisplayBrightness();
time_t shownTime=0;time_t fakeTime(time_t*){return shownTime;}
'''
FUNCS='\n'.join(fn('009_main.cpp.inc',sig) for sig in ['void applyDisplayBrightness()','bool screensaverMayRun()','void markUserActivity()','bool handleScreensaverWake()','void enterScreensaver()','void serviceIdleScreensaver()'])
MODE='void setUiMode(UiMode mode){bool changed=mode!=gUiMode;gUiMode=mode;'+scene+'if(changed&&mode==UiMode::ChessMind)beginChessMind();}\n'
TEST=r'''
bool printed(const std::string&s){return std::any_of(gCanvas.texts.begin(),gCanvas.texts.end(),[&](const auto&t){return t==s;});}
void reset(){gUiMode=UiMode::ChatFull;gScreensaverActive=gScreensaverDimmed=gScreenOffActive=false;gDeviceSettings.screensaverClockOnWake=false;gDeviceSettings.screenAutoOffEnabled=true;gDeviceSettings.screensaverEnabled=true;gLastUserActivityMs=gLastUserInputMs=tick=1000;gCMatrixInitialized=true;}
int main(){
 Keyboard_Class::KeysState keys;
 for(int style=0;style<3;++style){reset();gDeviceSettings.screensaverStyle=style;enterScreensaver();
  assert(gScreensaverActive&&gScreensaverPreviousMode==UiMode::ChatFull);
  assert(gUiMode==(style==0?UiMode::CMatrix:style==1?UiMode::Face:UiMode::ChessMind));
  if(style==2){assert(gChessMind.started);assert(M5Cardputer.Display.brightness==percentToByte(70));}
  tick+=60000;serviceIdleScreensaver();assert(gScreensaverActive&&gScreensaverDimmed&&M5Cardputer.Display.brightness==percentToByte(10));
  tick+=240000;serviceIdleScreensaver();assert(gScreenOffActive&&M5Cardputer.Display.brightness==0);
  assert(handleScreensaverWake()&&!gScreensaverActive&&!gScreenOffActive&&!gScreensaverDimmed&&gUiMode==UiMode::ChatFull);
  assert(M5Cardputer.Display.brightness==percentToByte(70)&&gLastUserActivityMs==tick&&gLastUserInputMs==tick);
  assert(!handleScreensaverWake());
 }
 reset();gDeviceSettings.screensaverStyle=2;gDeviceSettings.screensaverClockOnWake=true;enterScreensaver();assert(handleScreensaverWake()&&gUiMode==UiMode::Clock);
 reset();gDeviceSettings.screensaverStyle=2;tick+=60000;serviceIdleScreensaver();assert(gUiMode==UiMode::ChessMind&&gScreensaverActive);
 // Activity/OTA/voice ownership still excludes idle entry.
 for(bool*p:{&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gVoiceNoticeVisible,&gVoiceReplySpeechBusy,&gTransferUiActive,&gOtaApplyInProgress,&gPendingRestart}){
  reset();*p=true;tick+=60000;serviceIdleScreensaver();assert(!gScreensaverActive);*p=false;
 }
 reset();gUiMode=UiMode::Ota;tick+=60000;serviceIdleScreensaver();assert(!gScreensaverActive);
 // Moving from the saver to another app must restore the brightness state.
 reset();gDeviceSettings.screensaverStyle=2;enterScreensaver();gScreensaverDimmed=true;setUiMode(UiMode::Home);assert(!gScreensaverActive&&!gScreensaverDimmed);
 // Preview input is optional; the actual saver keeps first-key wake semantics.
 reset();setUiMode(UiMode::ChessMind);auto serial=gChessMind.serial;
 handleChessMindKey(' ',keys);assert(gChessMind.revealed);handleChessMindKey(' ',keys);assert(!gChessMind.revealed&&gChessMind.serial==serial+1);
 keys.enter=true;handleChessMindKey('\r',keys);assert(gChessMind.serial==serial+2);keys.enter=false;
 gScreensaverActive=true;serial=gChessMind.serial;handleChessMindKey(' ',keys);assert(gChessMind.serial==serial&&!gChessMind.revealed);
 // Render every kind, piece family, answer phase, saver/preview, clock mode,
 // missing time and AM/PM extremes. All primitives/text must fit 240x135.
 for(int i=0;i<500;++i)for(bool saver:{false,true})for(bool reveal:{false,true})for(bool twelve:{false,true}){
  gScreensaverActive=saver;gDeviceSettings.clockTwelveHour=twelve;
  shownTime=i%4==0?0:time_t(1704067200)+(i%4==1?0:i%4==2?12*3600:23*3600+59*60);
  gChessMind.begin(tick,100+i);gChessMind.revealed=reveal;gChessMind.phaseStarted=tick;
  renderChessMindUi();assert(printed("CHESS MIND")&&gCanvas.prints>10);
  auto answerText=std::string(gChessMind.question.answer);
  if(reveal)assert(printed(answerText));
  else assert(printed("Solve in your head"));
 }
 puts("PASS actual Chess Mind renderer/lifecycle: all quiz/answer/clock layouts within 240x135, three styles, prior app/Clock wake, dim/off, voice/OTA guards and preview controls (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='chess-mind-ui-') as tmp:
 p=Path(tmp);(p/'test.cpp').write_text(STUB+FUNCS+'\n#define time fakeTime\n'+APP+'\n#undef time\n'+MODE+TEST)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=40)
# Integration anchors are source-owned, not a mocked mode-only claim.
assert 'kScreensaverStyleCount = 3;' in (PARTS/'001_main.cpp.inc').read_text()
assert 'UiMode::ChessMind' in (PARTS/'061_main.cpp.inc').read_text()
assert 'UiMode::ChessMind' in (PARTS/'004_main.cpp.inc').read_text()
assert '"Chess Mind"' in (PARTS/'057_main.cpp.inc').read_text()
