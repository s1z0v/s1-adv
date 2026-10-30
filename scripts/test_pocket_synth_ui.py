#!/usr/bin/env python3
"""Execute the production instrument renderer, full key snapshots and PCM owner."""
from pathlib import Path
import os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src';PARTS=SRC/'main_parts'
STUB=r'''
#include "pocket_synth.h"
#include <cassert>
#include <cstdint>
#include <string>
#include <vector>
#include <deque>
#include <algorithm>
#include <cctype>
#include <cstring>
#include <cstdio>
using std::min;using std::max;
namespace Keyboard_Class {struct KeysState{bool ctrl=false,alt=false,opt=false,fn=false,tab=false,space=false,enter=false,del=false;std::vector<char>word;std::vector<uint8_t>hid_keys;};}
Keyboard_Class::KeysState gKeyboardState;
namespace fonts{int Font0=0;}
int rgb565_local(int r,int g,int b){return ((r&248)<<8)|((g&252)<<3)|(b>>3);}
struct Canvas{int x=0,y=0,primitives=0;std::vector<std::string>text;
 void bounds(int a,int b,int w,int h){assert(a>=0&&b>=0&&w>0&&h>0&&a+w<=240&&b+h<=135);++primitives;}
 void fillScreen(int){text.clear();primitives=0;}void fillRect(int a,int b,int w,int h,int){bounds(a,b,w,h);}
 void fillRoundRect(int a,int b,int w,int h,int,int){bounds(a,b,w,h);}
 void setFont(const int*){}void setTextColor(int,int){}void setCursor(int a,int b){x=a;y=b;}
 void print(const char*s){if(!*s)return;bounds(x,y,int(strlen(s))*6,8);text.emplace_back(s);}
}gCanvas;
struct SpeakerStub{
 struct Item{const int16_t*p;std::vector<int16_t>snapshot;};std::deque<Item>queue;
 int calls=0,stops=0;bool foreign=false,reject=false;
 int isPlaying(int c=255){return c==255?(foreign||!queue.empty()):int(queue.size());}
 bool playRaw(const int16_t*p,size_t n,int rate,bool stereo,int repeat,int channel,bool stop){
  assert(n==256&&rate==22050&&!stereo&&repeat==1&&channel==6&&!stop&&queue.size()<2);
  if(reject)return false;for(auto&i:queue){assert(i.p!=p);assert(std::equal(i.snapshot.begin(),i.snapshot.end(),i.p));}
  queue.push_back({p,std::vector<int16_t>(p,p+n)});++calls;return true;
 }
 void consume(){if(!queue.empty()){auto&i=queue.front();assert(std::equal(i.snapshot.begin(),i.snapshot.end(),i.p));queue.pop_front();}}
 void stop(int c){assert(c==6);++stops;} // intentionally asynchronous; pointer remains in use
} ;struct{SpeakerStub Speaker;}M5Cardputer;
uint32_t now=1000,gLastRenderMs=0;uint32_t millis(){return now;}
struct{int invalid=0;void invalidate(){++invalid;}}gUiFramePolicy;
enum class UiMode{Home,PocketSynth};UiMode gUiMode=UiMode::PocketSynth;
bool gLauncherVisible=false,gChatCommandsVisible=false,gCanvasSpriteActive=true,gScreensaverActive=false,gScreenOffActive=false,gBootBackgroundActive=false;
bool gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false,gVoiceNoticeVisible=false,gTransferUiActive=false,gOtaApplyInProgress=false,gPendingRestart=false;
bool gInboxHttpBusy=false,gVoiceDialBusy=false,gVoiceReplySpeechBusy=false,gRealtimeActive=false,gRealtimeDialBusy=false,gRealtimeExclusiveMode=false,gPendingRealtimeStart=false;
bool gMeshBusOwned=false,gG0VoicePending=false,gVoiceCapturePreparing=false,gPendingOtaCheckAction=false,gPendingOtaApplyAction=false,gAlarmRinging=false,radio=false,vlc=false;
void*gTextTurnTaskHandle=nullptr,*gCompletedTextTurn=nullptr;
struct Text:std::string{using std::string::operator=;bool isEmpty()const{return empty();}}gQueuedVoiceReplySpeech,gActiveTextTurn;
std::vector<int>gPendingTextTurns;
uint32_t gLastUserActivityMs=0,gLastUserInputMs=0;
constexpr uint8_t kHidKeyEscape=0xB1;
bool radioBusy(){return radio;}bool vlcBusy(){return vlc;}
bool hasHidKey(const Keyboard_Class::KeysState&k,uint8_t code){return std::find(k.hid_keys.begin(),k.hid_keys.end(),code)!=k.hid_keys.end();}
void setStatus(const char*,int){}
'''
TEST=r'''
void tick(int n=1){for(int i=0;i<n;++i){M5Cardputer.Speaker.consume();now+=11;servicePocketSynth();}}
void clearKeys(){gKeyboardState={};}
void restart(){stopPocketSynth();gPocketSynth=pocket_synth::Synth{};clearKeys();M5Cardputer.Speaker.queue.clear();gUiMode=UiMode::PocketSynth;servicePocketSynth();servicePocketSynth();}
void key(char c){gKeyboardState.word={c};tick();clearKeys();tick();}
bool printed(const std::string&s){return std::find(gCanvas.text.begin(),gCanvas.text.end(),s)!=gCanvas.text.end();}
int main(){
 beginPocketSynth();assert(handlePocketSynthKey('z',gKeyboardState));assert(!synthAudioBusy());
 restart();assert(!gSynthRequireRelease);assert(!M5Cardputer.Speaker.calls);gPocketSynth.patch=pocket_synth::Patch::Organ;
 gKeyboardState.word={'z','c','b'};tick();assert(gPocketSynth.heldMask==((1u<<0)|(1u<<4)|(1u<<7))&&gPocketSynth.activeCount()==3&&gSynthOwned);
 auto age=gPocketSynth.voices[0].age;tick(100);assert(gPocketSynth.voices[0].age>age&&gLastUserActivityMs==now);
 // Removing one chord key only releases that voice; no first-character hack.
 gKeyboardState.word={'z','b'};tick(50);assert(gPocketSynth.activeCount()==2);clearKeys();tick(80);assert(!gPocketSynth.active()&&!gSynthOwned&&M5Cardputer.Speaker.queue.empty());
 restart();
 // Sustain toggles once per key edge, not repeatedly while held.
 gKeyboardState.space=true;tick(8);assert(gPocketSynth.sustain);clearKeys();tick();key('z');assert(gPocketSynth.active());gKeyboardState.space=true;tick();assert(!gPocketSynth.sustain);clearKeys();tick(100);assert(!gSynthOwned);
 // Panic never rewrites an asynchronously stopped pointer; wait for drain.
 gKeyboardState.word={'q'};tick();auto calls=M5Cardputer.Speaker.calls;gKeyboardState.del=true;servicePocketSynth();assert(!gPocketSynth.active()&&gSynthDraining);
 servicePocketSynth();assert(M5Cardputer.Speaker.calls==calls);clearKeys();tick(5);assert(!gSynthDraining&&!gSynthOwned);tick();
 int octave=gPocketSynth.octave;key('=');assert(gPocketSynth.octave==octave+1);key('-');assert(gPocketSynth.octave==octave);key(']');assert(gPocketSynth.patch==pocket_synth::Patch::Bell);key('[');assert(gPocketSynth.patch==pocket_synth::Patch::Piano);
 key(',');assert(gPocketSynth.gain==55);key('.');assert(gPocketSynth.gain==65);
 gKeyboardState.enter=true;tick(3);assert(gPocketSynth.lesson==pocket_synth::Lesson::Major);clearKeys();tick();key('z');assert(gPocketSynth.lessonStep==1);key('x');assert(gPocketSynth.lessonStep==2);restart();
 // Every competing owner/overlay must silence, wait for all keys up, and
 // must not autoplay/replay a key after its guard is removed.
 for(bool*p:{&gLauncherVisible,&gChatCommandsVisible,&gScreensaverActive,&gScreenOffActive,&gBootBackgroundActive,&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gVoiceNoticeVisible,&gTransferUiActive,&gOtaApplyInProgress,&gPendingRestart,&gInboxHttpBusy,&gVoiceDialBusy,&gVoiceReplySpeechBusy,&gRealtimeActive,&gRealtimeDialBusy,&gRealtimeExclusiveMode,&gPendingRealtimeStart,&gMeshBusOwned,&gG0VoicePending,&gVoiceCapturePreparing,&gPendingOtaCheckAction,&gPendingOtaApplyAction,&gAlarmRinging,&radio,&vlc}){
  restart();gKeyboardState.word={'z'};tick();assert(gSynthOwned);*p=true;servicePocketSynth();assert(!gPocketSynth.active()&&!gSynthOwned);*p=false;tick(5);assert(!gSynthOwned&&gSynthRequireRelease);clearKeys();tick();gKeyboardState.word={'z'};tick();assert(gSynthOwned);
 }
 for(bool*p:{&gKeyboardState.ctrl,&gKeyboardState.alt,&gKeyboardState.opt,&gKeyboardState.fn,&gKeyboardState.tab}){
  restart();gKeyboardState.word={'z'};tick();*p=true;servicePocketSynth();assert(!gSynthOwned&&!gPocketSynth.active());*p=false;
 }
 restart();M5Cardputer.Speaker.foreign=true;gKeyboardState.word={'z'};tick();assert(!gSynthOwned);M5Cardputer.Speaker.foreign=false;tick();assert(!gSynthOwned);clearKeys();tick();key('z');assert(gSynthOwned);
 restart();M5Cardputer.Speaker.reject=true;gKeyboardState.word={'z'};tick();assert(!gSynthOwned&&!gPocketSynth.active());M5Cardputer.Speaker.reject=false;restart();
 for(auto*p:{&gTextTurnTaskHandle,&gCompletedTextTurn}){*p=reinterpret_cast<void*>(1);assert(!synthForegroundAllowed());*p=nullptr;}
 gPendingTextTurns.push_back(1);assert(!synthForegroundAllowed());gPendingTextTurns.clear();gQueuedVoiceReplySpeech="voice";assert(!synthForegroundAllowed());gQueuedVoiceReplySpeech="";gActiveTextTurn="text";assert(!synthForegroundAllowed());gActiveTextTurn="";
 // Renderer: 4 sounds x 4 lessons x 4 octaves x every possible highlighted key.
 for(int patch=0;patch<4;++patch)for(int lesson=0;lesson<4;++lesson)for(int oct=2;oct<=5;++oct)for(int key=0;key<25;++key){
  gPocketSynth.patch=pocket_synth::Patch(patch);gPocketSynth.lesson=pocket_synth::Lesson(lesson);gPocketSynth.octave=oct;gPocketSynth.heldMask=1u<<key;gPocketSynth.lastMidi=gPocketSynth.midiFor(key);gPocketSynth.gain=100;renderPocketSynthUi();assert(printed("POCKET SYNTH")&&gCanvas.primitives>40);
 }
 puts("PASS actual Pocket Synth UI/audio: all chord/release keys, sustain/panic/control edges, three-buffer pointer lifetime incl asynchronous stop, guarded voice/OTA/network/menu, no stale autoplay, all 240x135 layouts (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='synth-ui-') as tmp:
 p=Path(tmp);(p/'test.cpp').write_text(STUB+(PARTS/'073_main.cpp.inc').read_text()+TEST)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=50)
loop=(PARTS/'061_main.cpp.inc').read_text();mode=(PARTS/'024_main.cpp.inc').read_text();capture=(PARTS/'033_main.cpp.inc').read_text()
assert loop.index('servicePocketSynth();')<loop.index('traceUiService("serviceInboxNetworkCompletion"')
assert 'if (synthForegroundAllowed())' in loop and 'case UiMode::PocketSynth:' in loop
assert 'mode != UiMode::PocketSynth) stopPocketSynth();' in mode
assert capture.index('stopPocketSynth();')<capture.index('const uint32_t captureRequestedMs')
assert 'Pocket Synth' in (PARTS/'004_main.cpp.inc').read_text()
