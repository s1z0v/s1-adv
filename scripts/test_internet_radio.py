#!/usr/bin/env python3
"""Sanitized production radio catalog/controller/renderer and resource boundaries."""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1];src=root/'bots/CardputerADV/src';parts=src/'main_parts'
app=(parts/'070_main.cpp.inc').read_text()
for f,s in [('004_main.cpp.inc','{"Internet Radio", UiMode::Radio}'),('024_main.cpp.inc','if (deferInternetRadioMode(mode)) return;'),('033_main.cpp.inc','if (radioBusy())'),('042_main.cpp.inc','if (radioBusy())'),('017_main.cpp.inc','if (radioBusy())'),('022_main.cpp.inc','if (radioBusy())'),('010_main.cpp.inc','gInboxHttpBusy || radioBusy()'),('063_main.cpp.inc','if (radioBusy()) return false;'),('061_main.cpp.inc','serviceInternetRadio();'),('048_main.cpp.inc','handleInternetRadioKey(key, keys)')]:
 assert s in (parts/f).read_text(),(f,s)
loop=(parts/'061_main.cpp.inc').read_text().split('void loop() {',1)[1]
assert loop.index('if (radioBusy())')<loop.index('serviceVoiceReplySpeech')
assert 'main_parts/070_main.cpp.inc' in (src/'main.cpp').read_text()
code=r'''
#include "radio_catalog.h"
#include "internet_radio_transport.h"
#include "clock_display.h"
#include <cassert>
#include <cstdint>
#include <cctype>
#include <cmath>
#include <ctime>
#include <string>
#include <vector>
#include <deque>
#include <type_traits>
#include <algorithm>
using std::min;using std::max;
struct String:std::string {using std::string::string;String(const std::string&s):std::string(s){}
 template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>String(T n):std::string(std::to_string(n)){}
 bool isEmpty()const{return empty();}
};
namespace fonts{const int Font0=0,Font7=7;}
struct Box{int x,y,w,h;};
struct Canvas{
 const int*font=&fonts::Font0;int x=0,y=0;std::vector<Box>texts;
 void bounds(int a,int b,int w,int h){assert(a>=0&&b>=0&&w>0&&h>0&&a+w<=240&&b+h<=135);}
 void fillScreen(uint16_t){texts.clear();}
 void fillRect(int a,int b,int w,int h,uint16_t){bounds(a,b,w,h);}
 void fillRoundRect(int a,int b,int w,int h,int,uint16_t c){fillRect(a,b,w,h,c);}
 void drawRoundRect(int a,int b,int w,int h,int r,uint16_t c){fillRoundRect(a,b,w,h,r,c);}
 void drawFastHLine(int a,int b,int w,uint16_t c){fillRect(a,b,w,1,c);}
 void drawCircle(int a,int b,int r,uint16_t c){fillRect(a-r,b-r,2*r+1,2*r+1,c);}
 void fillTriangle(int a,int b,int c,int d,int e,int f,uint16_t color){fillRect(min({a,c,e}),min({b,d,f}),max({a,c,e})-min({a,c,e})+1,max({b,d,f})-min({b,d,f})+1,color);}
 void setFont(const int*f){font=f;}void setTextColor(uint16_t,uint16_t){}
 void setCursor(int a,int b){x=a;y=b;}
 int textWidth(const String&s){return font==&fonts::Font7?int(s.size())*20:int(s.size())*6;}
 void print(const String&s){if(s.empty())return;Box box{x,y,textWidth(s),font==&fonts::Font7?48:8};bounds(box.x,box.y,box.w,box.h);
 for(const auto&t:texts)assert(x+box.w<=t.x||t.x+t.w<=x||y+box.h<=t.y||t.y+t.h<=y);texts.push_back(box);}
}gCanvas;
uint16_t rgb565_local(int r,int g,int b){return ((r&248)<<8)|((g&252)<<3)|(b>>3);}
String fitCurrentFontToWidth(String s,int w){while(!s.empty()&&gCanvas.textWidth(s)>w)s.pop_back();return s;}
void drawAssistantPulseArc(int,int,int,int,float,float,uint16_t){}
void renderLauncherOverlay(){}void renderDebugOverlay(){}
struct Keyboard_Class{struct KeysState{bool ctrl=false,alt=false,opt=false,enter=false;};};
enum class UiMode{Home,Radio,Voice,Mesh};UiMode gUiMode=UiMode::Radio;
struct{bool clockTwelveHour=false;}gDeviceSettings;
uint8_t gSpeakerVolume=128;uint32_t gLastRenderMs=0,tick=1000;
uint32_t millis(){return tick;}
struct{int changes=0;void invalidate(){++changes;}}gUiFramePolicy;
bool gWifiReady=true,gBootBackgroundActive=false,gCanvasSpriteActive=true,gRecording=false,gSubmitting=false,gThinking=false;
bool gPlaybackActive=false,gTransferUiActive=false,gOtaApplyInProgress=false,gInboxHttpBusy=false,gVoiceDialBusy=false;
bool gVoiceReplySpeechBusy=false,gRealtimeActive=false,gRealtimeDialBusy=false,gRealtimeExclusiveMode=false,gPendingRealtimeStart=false;
bool gMeshBusOwned=false,gG0VoicePending=false,gVoiceCapturePreparing=false;
void*gTextTurnTaskHandle=nullptr;void*gCompletedTextTurn=nullptr;std::deque<String>gPendingTextTurns;
String gActiveTextTurn,gQueuedVoiceReplySpeech;
struct{struct{bool occupied=false;bool isPlaying(){return occupied;}}Speaker;}M5Cardputer;
void initSpeaker(){assert(!internet_radio::busy());}
void setStatus(const String&,int){}
void adjustSpeakerVolume(int n){gSpeakerVolume=std::clamp(int(gSpeakerVolume)+n,0,255);}
void setUiMode(UiMode);
namespace internet_radio{
 bool running=false,cancelling=false,fail=false;int starts=0,stops=0;String url;State phase=State::Idle;
 bool start(const char*u){assert(!running);++starts;url=u;if(fail){phase=State::Error;return false;}running=true;phase=State::Connecting;return true;}
 void stop(){++stops;if(running){cancelling=true;phase=State::Stopping;}}
 bool busy(){return running;}State state(){return phase;}
 const char*status(){return phase==State::Error?"Radio timed out":phase==State::Stopping?"Stopping":"Playing";}
 void finish(State s=State::Idle){running=false;cancelling=false;phase=s;}
}
'''+app+r'''
void setUiMode(UiMode m){if(deferInternetRadioMode(m))return;gUiMode=m;}
void key(char c){Keyboard_Class::KeysState k;handleInternetRadioKey(c,k);}
int main(){
 using namespace radio_catalog;
 for(auto language:{Language::All,Language::International,Language::Russian}){
  Selection s;s.language=language;if(!s.count(s.genre))s.moveGenre(1);
  for(int n=0;n<1000;++n){assert(s.genre<kGenresCount&&s.count(s.genre)&&s.station());assert(s.matches(*s.station(),s.genre));
   s.moveStation(n%2?1:-1);assert(s.station());s.moveGenre(n%2?1:-1);assert(s.station());}
 }
 for(const auto&s:kStations){assert(s.genre<kGenresCount&&std::string(s.url).find("http://")==0&&std::string(s.name).size()<=19);}
 // Browsing never starts playback. Explicit Play starts exactly once.
 beginInternetRadio();key('s');key('d');assert(internet_radio::starts==0);
 key('\n');assert(gRadioStartPending&&!radioBusy());serviceInternetRadio();assert(radioBusy()&&internet_radio::starts==1);
 serviceInternetRadio();assert(internet_radio::starts==1);
 // Retune must wait for asynchronous socket/PCM release, then starts newest
 // choice once. Rapid repeated selection never creates simultaneous workers.
 key('s');key('d');key('d');assert(gRadioStartPending&&radioBusy()&&internet_radio::cancelling);
 serviceInternetRadio();assert(internet_radio::starts==1);
 internet_radio::finish();serviceInternetRadio();assert(internet_radio::starts==2&&internet_radio::url==gRadioSelection.station()->url);
 // Pause stays paused and language browse remains silent.
 key(' ');assert(!gRadioWantPlaying&&radioBusy());internet_radio::finish();serviceInternetRadio();int n=internet_radio::starts;
 key('l');serviceInternetRadio();assert(internet_radio::starts==n);
 for(int i=0;i<40;++i)key('+');assert(gSpeakerVolume==255);for(int i=0;i<40;++i)key('-');assert(gSpeakerVolume==0);
 // Every audio/network owner blocks a new radio worker, without touching it.
 for(bool*p:{&gBootBackgroundActive,&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gTransferUiActive,&gOtaApplyInProgress,&gInboxHttpBusy,&gVoiceDialBusy,&gVoiceReplySpeechBusy,&gRealtimeActive,&gRealtimeDialBusy,&gRealtimeExclusiveMode,&gPendingRealtimeStart,&gMeshBusOwned,&gG0VoicePending,&gVoiceCapturePreparing}){
  *p=true;key('\n');serviceInternetRadio();assert(!radioBusy()&&!gRadioWantPlaying);*p=false;
 }
 gWifiReady=false;key('\n');serviceInternetRadio();assert(!radioBusy());gWifiReady=true;
 // Errors stop, no hidden auto-retry; Enter can explicitly retry.
 internet_radio::fail=true;key('\n');serviceInternetRadio();assert(!gRadioWantPlaying&&!radioBusy());internet_radio::fail=false;
 key('\n');serviceInternetRadio();assert(radioBusy());internet_radio::finish(internet_radio::State::Error);serviceInternetRadio();assert(!gRadioWantPlaying);
 n=internet_radio::starts;for(int i=0;i<50;++i)serviceInternetRadio();assert(internet_radio::starts==n);
 // Navigation waits for worker release and only then applies the mode.
 key('\n');serviceInternetRadio();setUiMode(UiMode::Voice);assert(gUiMode==UiMode::Radio&&gRadioModePending&&radioBusy());
 serviceInternetRadio();assert(gUiMode==UiMode::Radio);internet_radio::finish();serviceInternetRadio();assert(gUiMode==UiMode::Voice&&!gRadioModePending);
 gUiMode=UiMode::Radio;
 // All reachable genre/station/language selections and state labels fit.
 for(int lang=0;lang<3;++lang){gRadioSelection.language=static_cast<Language>(lang);
  for(unsigned group=0;group<kGenresCount;++group){gRadioSelection.genre=group;
   for(unsigned index=0;index<gRadioSelection.count(group);++index){gRadioSelection.index=index;
    for(auto state:{internet_radio::State::Idle,internet_radio::State::Playing,internet_radio::State::Error,internet_radio::State::Stopping}){
     internet_radio::phase=state;gRadioNotice="Radio memory unavailable";renderInternetRadioUi();
    }
   }
  }
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-radio-ui-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-g','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I'+str(src),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=40)
print('PASS production radio catalog, language/genre/station wrap, play/pause/volume, async retune/exit ownership, no auto retry, resource guards and bounded non-overlapping clock-style UI')
