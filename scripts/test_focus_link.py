#!/usr/bin/env python3
"""Run actual focus transitions, shortcut and lamp ownership without hardware."""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
parts=root/'bots/CardputerADV/src/main_parts'
def extract(file,signature):
 s=(parts/file).read_text();a=s.index(signature);i=s.index('{',a)+1;n=1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include <cassert>
#include <cstdint>
#include <string>
#include <algorithm>
#include "focus_lamp_link.h"
#include "ui_frame_policy.h"
#include "smartlamp_gl2_protocol.h"
using std::max; using std::min;
uint32_t tick=1000;uint32_t millis(){return tick;}
std::string String(const char* s){return s;}
void setStatus(const std::string&,int){}
struct {template<class... T> void printf(T...){} }Serial;
void logf(const char*,...){} void focusTone(int,int){}
enum class FocusState {Stopped,Focus,ShortBreak,LongBreak,Reflect,Paused};
enum class UiMode {Home,Clock,Face,Focus,ChatFull};
UiMode gUiMode=UiMode::Home;
void setUiMode(UiMode mode){gUiMode=mode;}
namespace Keyboard_Class {struct KeysState {bool ctrl=false,alt=false,fn=false;};}
bool gLauncherVisible=false,gRecording=false,gSubmitting=false,gRealtimeActive=false,gRealtimeExclusiveMode=false;
struct {uint32_t focusSec=60,shortBreakSec=60,longBreakSec=60;uint16_t cyclesPerRound=4;bool autoStart=false;}gFocusSettings;
struct {FocusState state=FocusState::Stopped,stateBeforePause=FocusState::Focus;uint32_t remainingSec=60,sessionTotalSec=60,lastTickMs=0,nextMetronomeMs=0;uint16_t cycle=1,completedToday=0;uint32_t focusedTodaySec=0;}gFocus;
focus_lamp::Link gFocusLampLink;
bool gFocusCompletionTonePending=false;
FocusState gPendingFocusCue=FocusState::Stopped;uint32_t gPendingFocusCueAtMs=0;
const char* focusStateName(FocusState s){return s==FocusState::Focus?"FOCUS":"OTHER";}
uint32_t focusDurationForState(FocusState s){return s==FocusState::Focus?gFocusSettings.focusSec:s==FocusState::LongBreak?gFocusSettings.longBreakSec:gFocusSettings.shortBreakSec;}
bool focusStateRuns(FocusState s){return s==FocusState::Focus||s==FocusState::ShortBreak||s==FocusState::LongBreak||s==FocusState::Reflect;}
'''
for sig in ['void focusEnterState(', 'void focusStartOrResume()', 'void focusReset()', 'void focusAdvance()', 'void updateFocusTimer()']:
 code+=extract('028_main.cpp.inc',sig)+'\n'
code+=extract('048_main.cpp.inc','bool handleFocusShortcut(')
code+=r'''
int main(){
 int n=-1;assert(cardputer_smartlamp::parsePresencePacket("GL_ONL1",n)&&n==1);
 assert(cardputer_smartlamp::parsePresencePacket("GL_ONL5",n)&&n==5);
 assert(cardputer_smartlamp::parsePresencePacket("GL_ONL10",n)&&n==10);
 assert(cardputer_smartlamp::parsePresencePacket("GL_ONL39",n)&&n==39);
 for(auto s:{"GL_ONL","GL_ONL-1","GL_ONL40","GL_ONLx","GL_ONL1junk","GL,1,password"})assert(!cardputer_smartlamp::parsePresencePacket(s,n));
 ui_frame::Policy p;assert(p.needsFullFrame(true,1,false));p.presented(1);
 assert(!p.needsFullFrame(false,1,false)); // No periodic clear while TLS owns memory.
 assert(p.needsFullFrame(false,2,false)); // Tab/menu paints immediately.
 assert(p.needsFullFrame(false,1,true));  // Input does not wait for TLS.
 assert(p.needsFullFrame(true,1,false));  // Normal buffered animation remains live.
 Keyboard_Class::KeysState key;key.ctrl=true;
 assert(!handleFocusShortcut('f',key)); // Preserve Ctrl+F/Face.
 assert(handleFocusShortcut('t',key)&&gFocus.state==FocusState::Focus&&gUiMode==UiMode::Focus);
 gFocus.remainingSec=37;assert(handleFocusShortcut('t',key)&&gFocus.remainingSec==37);
 focusReset();gRecording=true;assert(handleFocusShortcut('t',key)&&gFocus.state==FocusState::Stopped);gRecording=false;
 focusStartOrResume();gUiMode=UiMode::Home;tick+=61000;updateFocusTimer();
 assert(gFocus.state==FocusState::ShortBreak&&gFocus.remainingSec==60&&gPendingFocusCue==FocusState::ShortBreak);
 assert(gFocus.completedToday==1&&gFocus.focusedTodaySec==60);
 tick+=61000;updateFocusTimer();assert(gFocus.state==FocusState::Stopped&&gPendingFocusCue==FocusState::Stopped&&gFocusCompletionTonePending);
 focusStartOrResume();tick+=1000;updateFocusTimer();focusStartOrResume();const auto paused=gFocus.remainingSec;
 tick+=100000;updateFocusTimer();assert(gFocus.remainingSec==paused);focusStartOrResume();tick+=1000;updateFocusTimer();assert(gFocus.remainingSec==paused-1);
 using focus_lamp::Phase;focus_lamp::Link lamp;lamp.observe(5,1000);
 lamp.setPhase(Phase::Focus,true,1,5,true,1000);assert(lamp.original==5&&lamp.target==1);
 for(int i=0;i<2;++i){tick+=600;assert(lamp.command(tick,true,false)==1);}
 for(int current=5;current>1;--current){tick+=600;assert(lamp.command(tick,true,false)==4);assert(lamp.command(tick,true,false)==-1);lamp.observe(current-1,tick+100);}
 lamp.setPhase(Phase::Break,true,1,5,true,tick);assert(lamp.target==5);
 for(int i=0;i<2;++i){tick+=600;assert(lamp.command(tick,true,false)==1);}
 for(int current=1;current<5;++current){tick+=600;assert(lamp.command(tick,true,false)==5);lamp.observe(current+1,tick+100);}
 lamp.setPhase(Phase::Idle,true,1,5,true,tick);lamp.observe(5,tick);assert(!lamp.active);
 lamp.setPhase(Phase::Focus,true,1,5,true,tick);assert(lamp.active);assert(lamp.command(tick+600,false,false)==-1&&lamp.suspended);
 lamp.setPhase(Phase::Focus,true,1,5,true,tick+1000);assert(!lamp.active);lamp.allow();lamp.setPhase(Phase::Focus,true,1,5,true,tick+1200);assert(lamp.active);
 lamp.observe(8,tick+1300);assert(!lamp.active&&lamp.suspended); // Manual override is never undone.
 focus_lamp::Link offline;offline.observe(5,tick);offline.setPhase(Phase::Focus,true,1,5,false,tick);assert(offline.suspended);
 offline.setPhase(Phase::Focus,true,1,5,true,tick+1000);assert(!offline.active); // No reconnect surprise.
 focus_lamp::Link timeout;timeout.observe(5,tick);timeout.setPhase(Phase::Focus,true,1,5,true,tick);
 assert(timeout.command(tick+600,true,false)==1);assert(timeout.command(tick+1200,true,false)==1);
 assert(timeout.command(tick+1800,true,false)==4);
 assert(timeout.command(tick+4400,true,false)==-1&&!timeout.active&&timeout.suspended);
 // Model stock GL2: preset steps are ignored while powered off. Drop the
 // first ON datagram, including when the desired preset is already selected.
 for(bool alreadySelected:{false,true}) {
  focus_lamp::Link off;int preset=alreadySelected?1:5;bool powered=false;int onPackets=0;
  off.observe(preset,1000);off.setPhase(Phase::Focus,true,1,5,true,1000);
  for(uint32_t t=1000;t<=10000;t+=100){
   const int cmd=off.command(t,true,false);
   if(cmd==1){if(++onPackets>1)powered=true;}
   else if(powered&&cmd==4)--preset;else if(powered&&cmd==5)++preset;
   off.observe(preset,t);
  }
  assert(powered&&preset==1&&onPackets==2);
  powered=false; // Manual switch-off within a phase is not fought.
  for(uint32_t t=10100;t<=12000;t+=100)assert(off.command(t,true,false)==-1);
  off.setPhase(Phase::Break,true,1,5,true,12000);
  for(uint32_t t=12000;t<=20000;t+=100){
   const int cmd=off.command(t,true,false);
   if(cmd==1)powered=true;else if(powered&&cmd==4)--preset;else if(powered&&cmd==5)++preset;
   off.observe(preset,t);
  }
  assert(powered&&preset==5);
 }
 focus_lamp::Link stopped;stopped.observe(1,1000);stopped.setPhase(Phase::Focus,true,1,5,true,1000);
 stopped.setPhase(Phase::Idle,true,1,5,true,1100);assert(stopped.command(2000,true,false)==-1);
 focus_lamp::Link resumed;resumed.observe(1,1000);resumed.setPhase(Phase::Break,true,1,5,true,1000);
 assert(resumed.active&&resumed.command(2000,true,false)==1);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-focus-link-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror','-I',str(root/'bots/CardputerADV/src'),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS actual focus/shortcut: minute cycle on Home, pause, no duplicate reset; strict lamp IDs, two presets, restore, loss/override/no resend; DMA-loan frame policy')
