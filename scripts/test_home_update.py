#!/usr/bin/env python3
"""Exercise Home update input, candidate and UI boundaries using actual functions."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'


def function(file, signature):
    source = (parts / file).read_text()
    start = source.index(signature)
    brace = source.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


code = r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include "release_delivery.h"
#include "firmware_job_display.h"
struct String:std::string {
 using std::string::string;
 String(const std::string& s):std::string(s){}
 String(int n):std::string(std::to_string(n)){}
 bool isEmpty() const{return empty();}
};
enum class UiMode {Home,Clock,ChatFull,Face,Ota};
UiMode gUiMode=UiMode::Home;
struct Keyboard_Class {struct KeysState {bool ctrl=false,alt=false,fn=false;};};
struct {bool parsed=false;String url,sha256,version;uint32_t size=0;} gOtaManifest;
const char* kAppVersion="0.2.161-dev";
bool gLauncherVisible=false,gChatCommandsVisible=false,gVoiceNoticeVisible=false;
bool gBlockingInputPumpActive=false,gRecording=false,gSubmitting=false,gThinking=false;
bool gPlaybackActive=false,gRealtimeActive=false,gRealtimeDialBusy=false,gOtaApplyInProgress=false;
bool gPendingOtaCheckAction=false,gPendingOtaApplyAction=false,gInboxHttpBusy=false;
bool gVoiceDialBusy=false,gVoiceReplySpeechBusy=false,gTextTurnTaskHandle=false;
uint32_t gPendingOtaActionAfterMs=0,now=1000;
uint32_t millis(){return now;}
String status;
void setStatus(String s,int){status=s;}
void logf(const char*,...){}
void appendRuntimeLog(String,String,bool){}
int fetched=0,applied=0,painted=0;
bool checkResult=true;
bool applyAfter=false;
bool startBackgroundManifestCheck(bool apply,bool){++fetched;gInboxHttpBusy=true;applyAfter=apply;return true;}
void completeCheck(){gInboxHttpBusy=false;if(checkResult&&applyAfter){gPendingOtaApplyAction=true;gPendingOtaActionAfterMs=now;}}
firmware_job_display::State gFirmwareJobState=firmware_job_display::State::Idle;
auto& state=gFirmwareJobState;uint32_t gFirmwareJobLastSyncMs=1000;
bool gVoiceCapturePreparing=false,gG0VoicePending=false,gInboxUnread=false;
String gInputBuffer;uint32_t gLastInboxAutoPollMs=0,gInboxRetryAfterMs=0;
enum class FocusState{Stopped,Focus,ShortBreak,LongBreak,Reflect,Paused};
struct{FocusState state=FocusState::Stopped;unsigned remainingSec=0;}gFocus;
bool applyOtaFromManifest(){++applied;return true;}
void setUiMode(UiMode m){gUiMode=m;}
void render(){++painted;}
namespace fonts {const int Font0=0,Font2=2;}
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);}
struct Canvas {
 int x=0,y=0,w=0,h=0,cursorX=0,cursorY=0;
 const int* font=&fonts::Font2;
 std::vector<std::string> labels;
 uint16_t border=0;
 void fillRoundRect(int xx,int yy,int ww,int hh,int,uint16_t){x=xx;y=yy;w=ww;h=hh;}
 void drawRoundRect(int xx,int yy,int ww,int hh,int,uint16_t c){assert(xx==x&&yy==y&&ww==w&&hh==h);border=c;}
 void setTextSize(int n){assert(n==1);}
 void setFont(const int* f){font=f;}
 void setTextColor(uint16_t,uint16_t){}
 int textWidth(const char* t){return strlen(t)*(font==&fonts::Font0?6:8);}
 void setCursor(int xx,int yy){cursorX=xx;cursorY=yy;}
 void print(const char* s){
  const int height=font==&fonts::Font0?8:16;
  assert(cursorX>x && cursorX+textWidth(s)<x+w);
  assert(cursorY>y && cursorY+height<=y+h-1);
  labels.push_back(s);
 }
} gCanvas;
'''
code += function('015_main.cpp.inc', 'bool homeFirmwareUpdateAvailable()')
code += function('064_main.cpp.inc', 'bool handleHomeUpdateKey(')
code += function('024_main.cpp.inc', 'void servicePendingOtaAction()')
code += function('065_main.cpp.inc', 'const char* homeStatusLabel(')
code += function('058_main.cpp.inc', 'void drawHomeReadyStatus(')
code += function('064_main.cpp.inc', 'bool handleHomeLinkRetryKey(')
code += r'''
void candidate(){gOtaManifest.parsed=true;gOtaManifest.url="https://bridge.test/fw.bin";
 gOtaManifest.sha256=std::string(64,'a');gOtaManifest.size=2000000;gOtaManifest.version="0.2.162-dev";}
void resetQueue(){gPendingOtaCheckAction=gPendingOtaApplyAction=false;gUiMode=UiMode::Home;}
int main(){
 candidate();assert(homeFirmwareUpdateAvailable());
 for(const char* version:{"0.2.160-dev","0.2.161-dev","bad"}){
  gOtaManifest.version=version;assert(!homeFirmwareUpdateAvailable());}
 candidate();gOtaManifest.parsed=false;assert(!homeFirmwareUpdateAvailable());
 candidate();gOtaManifest.url="";assert(!homeFirmwareUpdateAvailable());
 candidate();gOtaManifest.sha256="short";assert(!homeFirmwareUpdateAvailable());
 candidate();gOtaManifest.size=0;assert(!homeFirmwareUpdateAvailable());
 candidate();gOtaManifest.size=3145729;assert(!homeFirmwareUpdateAvailable());
 candidate();Keyboard_Class::KeysState keys;
 assert(!handleHomeUpdateKey('u',keys));keys.ctrl=true;
 assert(!handleHomeUpdateKey('x',keys));
 for(auto mode:{UiMode::ChatFull,UiMode::Face,UiMode::Ota}){
  gUiMode=mode;assert(!handleHomeUpdateKey('u',keys));}
 resetQueue();
 for(bool* busy:{&gBlockingInputPumpActive,&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gRealtimeActive,&gOtaApplyInProgress}){
  *busy=true;assert(handleHomeUpdateKey('u',keys));assert(!gPendingOtaApplyAction);*busy=false;}
 for(bool* overlay:{&gLauncherVisible,&gChatCommandsVisible,&gVoiceNoticeVisible}){
  *overlay=true;assert(!handleHomeUpdateKey('u',keys));*overlay=false;}
 // Receipt-time network activity must not lose a single key press: queue now,
 // wait for the owner worker, paint OTA first, then refresh and apply once.
 gInboxHttpBusy=true;assert(handleHomeUpdateKey('u',keys));
 assert(gPendingOtaApplyAction&&gPendingOtaCheckAction&&fetched==0&&applied==0);
 now+=101;servicePendingOtaAction();assert(fetched==0&&applied==0);
 gInboxHttpBusy=false;servicePendingOtaAction();
 assert(fetched==1&&applied==0&&painted==1&&gUiMode==UiMode::Ota);
 completeCheck();servicePendingOtaAction();assert(applied==1);
 servicePendingOtaAction();assert(applied==1);
 resetQueue();checkResult=false;assert(handleHomeUpdateKey('u',keys));now+=101;
 servicePendingOtaAction();completeCheck();servicePendingOtaAction();assert(applied==1); // failed refresh never applies
 resetQueue();checkResult=true;gOtaManifest.version=kAppVersion;
 assert(handleHomeUpdateKey('u',keys));now+=101;servicePendingOtaAction();
 completeCheck();servicePendingOtaAction();
 assert(applied==1&&gUiMode==UiMode::Home); // no candidate only checks
 assert(!gPendingOtaApplyAction&&!gPendingOtaCheckAction);
 // A bridge or startup check stays on Home and does not install.
 gPendingOtaCheckAction=true;gPendingOtaActionAfterMs=0;candidate();
 servicePendingOtaAction();assert(gUiMode==UiMode::Home&&applied==1);
 for(bool update:{false,true})for(bool pressed:{false,true}){
  gCanvas=Canvas{};drawHomeReadyStatus(update,pressed);
  assert(gCanvas.x+gCanvas.w/2==185&&gCanvas.h==18);
  assert(gCanvas.y+gCanvas.h<124); // battery starts at 124
  assert(gCanvas.font==&fonts::Font2);
  assert(gCanvas.labels==(update?std::vector<std::string>{"NEW UPDATE"}:std::vector<std::string>{"READY"}));
  assert(gCanvas.border==(update?rgb565_local(255,136,64):rgb565_local(47,227,255)));
 }
 for(auto sample:{firmware_job_display::State::Building,firmware_job_display::State::Attention,firmware_job_display::State::Failed,firmware_job_display::State::Stalled}){
  state=sample;gCanvas=Canvas{};drawHomeReadyStatus(false,false);
  assert(gCanvas.h==18&&gCanvas.labels.size()==1);
 }
 // The actual timer badge supersedes firmware states, then restores them on pause.
 state=firmware_job_display::State::Building;gFocus.state=FocusState::Focus;
 for(unsigned seconds:{0U,1U,59U,60U,1477U,3599U,3600U}) {
  gFocus.remainingSec=seconds;gCanvas=Canvas{};drawHomeReadyStatus(true,false);
  char t[12];snprintf(t,sizeof(t),"%02u:%02u",seconds/60,seconds%60);
  assert(gCanvas.labels==std::vector<std::string>{t});
  assert(gCanvas.border==rgb565_local(255,136,64)&&gCanvas.w==62);
 }
 for(auto phase:{FocusState::ShortBreak,FocusState::LongBreak,FocusState::Reflect}) {
  gFocus.state=phase;gCanvas=Canvas{};drawHomeReadyStatus(true,false);
  assert(gCanvas.labels==std::vector<std::string>{"BREAK"});
  assert(gCanvas.border==rgb565_local(88,240,141));
 }
 for(auto phase:{FocusState::Paused,FocusState::Stopped}) {
  gFocus.state=phase;gCanvas=Canvas{};drawHomeReadyStatus(false,false);
  assert((gCanvas.labels==std::vector<std::string>{"BUILDING"}));
 }
 gFocus.state=FocusState::Focus;
 gVoiceCapturePreparing=true;gCanvas=Canvas{};drawHomeReadyStatus(false,false);
 assert((gCanvas.labels==std::vector<std::string>{"MIC SETUP"}));
 gVoiceCapturePreparing=false;gG0VoicePending=true;gCanvas=Canvas{};drawHomeReadyStatus(false,false);
 assert((gCanvas.labels==std::vector<std::string>{"VOICE WAIT"}));
 gVoiceCapturePreparing=false;gG0VoicePending=false;gFocus.state=FocusState::Stopped;
 state=firmware_job_display::State::Idle;gInboxUnread=true;gCanvas=Canvas{};drawHomeReadyStatus(false,false);
 assert((gCanvas.labels==std::vector<std::string>{"NEW MESSAGE"})&&gCanvas.w==74);
 gInboxUnread=false;state=firmware_job_display::State::Building;now=gFirmwareJobLastSyncMs+90001;
 gCanvas=Canvas{};drawHomeReadyStatus(false,false);
 assert((gCanvas.labels==std::vector<std::string>{"CHECK LINK","F retry"}));
 keys.ctrl=false;resetQueue();assert(handleHomeLinkRetryKey('f',keys));
 assert(gPendingOtaCheckAction&&!gPendingOtaApplyAction);
 resetQueue();gInputBuffer="draft";assert(!handleHomeLinkRetryKey('f',keys));gInputBuffer.clear();
 state=firmware_job_display::State::Idle;assert(!handleHomeLinkRetryKey('f',keys));
 assert(std::string(firmware_job_display::label(firmware_job_display::State::Building,false,90001))=="CHECK LINK");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-home-update-') as directory:
    p = Path(directory)
    (p / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', '-I', str(root / 'bots/CardputerADV/src'),
                    str(p / 'test.cpp'), '-o', str(p / 'test')], check=True)
    subprocess.run([str(p / 'test')], check=True)
print('PASS Home update: candidate boundaries, single queued Ctrl+U, worker ownership, quiet checks, badge text and bounds')
