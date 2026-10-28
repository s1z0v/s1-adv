#!/usr/bin/env python3
"""Execute actual VLC UI, NVS/defaults migration, controls and ownership gates."""
from pathlib import Path
import os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src'
JSON=ROOT/'bots/CardputerADV/.pio/libdeps/cardputer_adv/ArduinoJson/src'
APP=(SRC/'main_parts/071_main.cpp.inc').read_text()
STUB=r'''
#include "vlc_remote.h"
#include <cassert>
#include <string>
#include <algorithm>
#include <vector>
#include <deque>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cctype>
#include <initializer_list>
using std::min;using std::max;
struct String:std::string{using std::string::string;String()=default;String(const std::string&s):std::string(s){}String(int n):std::string(std::to_string(n)){}bool isEmpty()const{return empty();}};
namespace fonts{int Font0=0,Font2=2;}
struct Canvas{const int*font=&fonts::Font0;int x=0,y=0;int drawn=0;
 void bounds(int a,int b,int w,int h){assert(a>=0&&b>=0&&w>0&&h>0&&a+w<=240&&b+h<=135);}
 void fillScreen(int){drawn=0;}
 void fillRect(int a,int b,int w,int h,int){bounds(a,b,w,h);}
 void fillRoundRect(int a,int b,int w,int h,int,int c){fillRect(a,b,w,h,c);}
 void drawRoundRect(int a,int b,int w,int h,int r,int c){fillRoundRect(a,b,w,h,r,c);}
 void setFont(const int*f){font=f;}void setTextColor(int,int){}
 void setCursor(int a,int b){x=a;y=b;}int textWidth(const String&s){return s.size()*(font==&fonts::Font2?8:6);}
 void print(const String&s){if(s.empty())return;bounds(x,y,textWidth(s),font==&fonts::Font2?16:8);++drawn;}
}gCanvas;
int rgb565_local(int,int,int){return 0;}
String fitCurrentFontToWidth(String s,int w){while(!s.empty()&&gCanvas.textWidth(s)>w)s.pop_back();return s;}
void renderLauncherOverlay(){}void renderDebugOverlay(){}
struct Keyboard_Class{struct KeysState{bool ctrl=false,alt=false,opt=false,enter=false;};};
enum class UiMode{Home,VlcRemote,Radio,Voice};UiMode gUiMode=UiMode::VlcRemote;
uint32_t tick=1000,gLastRenderMs=0;uint32_t millis(){return tick;}
struct{void invalidate(){}}gUiFramePolicy;
bool radio=false;bool radioBusy(){return radio;}
bool gWifiReady=true,gCanvasSpriteActive=true,gBootBackgroundActive=false,gRecording=false,gSubmitting=false,gThinking=false;
bool gPlaybackActive=false,gTransferUiActive=false,gOtaApplyInProgress=false,gInboxHttpBusy=false,gVoiceDialBusy=false,gVoiceReplySpeechBusy=false;
bool gRealtimeActive=false,gRealtimeDialBusy=false,gRealtimeExclusiveMode=false,gPendingRealtimeStart=false,gMeshBusOwned=false;
bool gG0VoicePending=false,gVoiceCapturePreparing=false,gLauncherVisible=false;
void*gTextTurnTaskHandle=nullptr;void*gCompletedTextTurn=nullptr;
std::deque<String>gPendingTextTurns;String gQueuedVoiceReplySpeech,gActiveTextTurn;
struct Prefs{
 bool exists=false,marker=false,valid=false;int reads=0,writes=0;
 bool begin(const char*ns,bool readonly){assert(!strcmp(ns,"vlc_remote")&&readonly);++reads;return exists;}
 bool getBool(const char*k,bool fallback){assert(!strcmp(k,"configured"));return marker?true:fallback;}
 String getString(const char*k,const char*){if(!valid)return "";if(!strcmp(k,"host"))return "saved.local";if(!strcmp(k,"password"))return "saved-fixture";return "192.168.5.3";}
 unsigned getUShort(const char*,unsigned){return 8099;}void end(){}
}gPrefs;
namespace vlc_remote{
 bool running=false;int starts=0,cancels=0;Command last=Command::Status;bool lastDiscover=false;Snapshot state;
 Config defaults(){Config c;strcpy(c.host,"vlc-test.local");strcpy(c.fallback,"192.168.5.20");strcpy(c.password,"fixture-only");return c;}
 bool start(const Config&c,Command command,bool discover){assert(configured(c)&&!running);running=true;++starts;last=command;lastDiscover=discover;return true;}
 void cancel(){++cancels;}bool busy(){return running;}Snapshot snapshot(){return state;}
 void complete(bool connected=true){running=false;state.connected=connected;++state.revision;}
}
void setUiMode(UiMode mode);
'''
TEST=r'''
void setUiMode(UiMode mode){if(!deferVlcRemoteMode(mode))gUiMode=mode;}
int main(){
 using namespace vlc_remote;Keyboard_Class::KeysState keys;
 // Old/unconfigured NVS never masks provisioned private defaults.
 for(int scenario=0;scenario<4;++scenario){gVlcLoaded=false;gPrefs.exists=scenario>0;gPrefs.marker=scenario>1;gPrefs.valid=scenario>2;loadVlcSettings();assert(!strcmp(gVlcConfig.host,scenario==3?"saved.local":"vlc-test.local"));assert(gPrefs.writes==0);}
 gVlcLoaded=false;gPrefs={};beginVlcRemote();assert(starts==0&&gVlcConnectPending);
 gInboxHttpBusy=true;serviceVlcRemote();assert(starts==0);gInboxHttpBusy=false;
 serviceVlcRemote();assert(starts==1&&last==Command::Status&&lastDiscover);
 // No autoplay, no key backlog while a request owns the socket.
 state.connected=true;assert(handleVlcRemoteKey('n',keys));assert(starts==1);
 complete();serviceVlcRemote();assert(starts==1);
 struct Pair{char key;Command command;};
 for(auto p:{Pair{' ',Command::Toggle},Pair{'x',Command::Stop},Pair{'n',Command::Next},Pair{'p',Command::Previous},Pair{'w',Command::VolumeUp},Pair{'s',Command::VolumeDown},Pair{'a',Command::Back},Pair{'d',Command::Forward},Pair{'+',Command::VolumeUp},Pair{'-',Command::VolumeDown}}){assert(handleVlcRemoteKey(p.key,keys));assert(last==p.command&&!lastDiscover);complete();}
 assert(handleVlcRemoteKey('r',keys)&&last==Command::Status&&lastDiscover);complete();
 int before=starts;tick+=3100;serviceVlcRemote();assert(starts==before+1&&last==Command::Status&&!lastDiscover);complete(false);
 // Errors don't auto-reconnect or replay; only R explicitly retries discovery.
 before=starts;tick+=60000;serviceVlcRemote();assert(starts==before);handleVlcRemoteKey('n',keys);assert(starts==before);
 for(bool* p:{&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gTransferUiActive,&gOtaApplyInProgress,&gInboxHttpBusy,&gVoiceDialBusy,&gVoiceReplySpeechBusy,&gRealtimeActive,&gRealtimeDialBusy,&gRealtimeExclusiveMode,&gPendingRealtimeStart,&gMeshBusOwned,&gG0VoicePending,&gVoiceCapturePreparing,&gBootBackgroundActive}){
  *p=true;handleVlcRemoteKey('r',keys);assert(starts==before);*p=false;
 }
 radio=true;handleVlcRemoteKey('r',keys);assert(starts==before);radio=false;
 // Keep ownership until cancellation finishes, then enter the requested app.
 handleVlcRemoteKey('r',keys);assert(running);setUiMode(UiMode::Home);assert(gUiMode==UiMode::VlcRemote&&gVlcModePending&&cancels>0);
 serviceVlcRemote();assert(gUiMode==UiMode::VlcRemote);complete();serviceVlcRemote();assert(gUiMode==UiMode::Home);
 before=starts;tick+=60000;serviceVlcRemote();assert(starts==before);
 // Every rendered state and long/unicode title remains within 240x135.
 for(int volume:{0,128,256,512,1024})for(int length:{0,1,150,2147483647})for(bool online:{false,true}){
  state.volume=volume;state.length=length;state.seconds=length;state.connected=online;
  memset(state.title,'Z',sizeof(state.title)-1);state.title[sizeof(state.title)-1]=0;
  strcpy(state.route,"LAN fallback");strcpy(state.playback,"playing");gVlcNotice=String(100,'x');
  renderVlcRemoteUi();assert(gCanvas.drawn>=8);
 }
 puts("PASS actual VLC UI: old NVS/default migration, all controls, read-only polling/no autoplay/replay, network gates, deferred exit and 240x135 bounds (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='vlc-ui-') as tmp:
 p=Path(tmp);(p/'test.cpp').write_text(STUB+APP+TEST)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-DVLC_REMOTE_HOST_TEST','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),'-I'+str(JSON),str(p/'test.cpp'),str(SRC/'vlc_remote.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=30)
