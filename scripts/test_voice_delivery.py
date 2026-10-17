#!/usr/bin/env python3
"""Compile the real playback transition and display formatter against host drivers."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1];parts=root/'bots/CardputerADV/src/main_parts'
def function(file, signature):
 s=(parts/file).read_text();a=s.index(signature);b=s.index('{',a);n=1;i=b+1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include <cassert>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <algorithm>
using std::min;
uint32_t nowMs=100;
uint32_t millis(){return nowMs;}
constexpr size_t kRealtimePlaybackChunkBytes=2048,kRealtimePlaybackPrebufferBytes=4096,kPlaybackBufferCount=2;
constexpr uint32_t kRealtimeStreamStallTimeoutMs=4000,kRealtimeSpeakerStallTimeoutMs=2500,kRealtimeTerminalEventGraceMs=4000,kRealtimeModelSampleRate=24000;
bool gRealtimeActive=true,gRealtimeConnected=true,gRealtimeHandsFreeActive=true;
bool gRealtimeGotAudio=false,gRealtimeAudioComplete=true,gRealtimeResponseComplete=true;
bool gRealtimePlaybackActive=true,gRealtimePlaybackFeeding=false,gRealtimePlaybackEverStarted=true,gPlaybackActive=true;
bool gRealtimeAwaiting=false,gPlaybackStreaming=false;
size_t gRealtimePlaybackBufferedBytes=0,gRealtimePlaybackRead=0,gRealtimePlaybackDroppedBytes=0,gRealtimePlaybackNextBuffer=0;
uint32_t gRealtimeLastAudioDeltaMs=0,gRealtimePlaybackProgressMs=0,gRealtimeAudioDoneMs=0;
uint32_t gRealtimePlaybackStartMs=0,gRealtimeLatencyOriginMs=0,gRealtimeFirstAudioDeltaMs=0,gRealtimeReplyBytes=0;
constexpr size_t kRealtimePlaybackRingBytes=16384;
uint8_t gPlaybackStreamBuffers[2][2048];
int scheduled=0,failed=0,playing=0;
enum class FaceMode {Idle,Speaking,Error};
void setFaceMode(FaceMode){}
void setStatus(const char*,int=0){}
void setVoiceDiag(const char*){}
void appendRuntimeLog(const char*,const char*,bool){}
void logf(const char*,...){}
void failRealtimeSession(const char*){++failed;gRealtimeActive=false;}
void scheduleRealtimeListenAfterPlayback(){if(gRealtimeResponseComplete&&!gRealtimePlaybackActive)++scheduled;}
size_t readRealtimePlaybackRing(uint8_t*,size_t n){gRealtimePlaybackBufferedBytes-=n;return n;}
void updatePlaybackAnalyzerFromSamples(const int16_t*,size_t,uint32_t){}
struct SpeakerStub {size_t isPlaying(int){return playing;} bool playRaw(const int16_t*,size_t,uint32_t,bool,int,int,bool){playing=1;return true;}};
struct {SpeakerStub Speaker;} M5Cardputer;
'''
code+='\n'+function('041_main.cpp.inc','void serviceRealtimePlayback()')
code+=f'\n#include "{root}/bots/CardputerADV/src/clock_display.h"\n'
code+=r'''
int main(){
 // The real function used to return at its prebuffer gate, leaving busy set.
 serviceRealtimePlayback();
 assert(!gRealtimePlaybackActive&&!gPlaybackActive&&!gRealtimePlaybackFeeding&&scheduled==1&&failed==0);
 // A speaker that still owns DMA data must finish before we restart the mic.
 playing=1;gRealtimePlaybackActive=true;gPlaybackActive=true;scheduled=0;
 serviceRealtimePlayback();assert(gRealtimePlaybackActive&&scheduled==0);
 playing=0;serviceRealtimePlayback();assert(!gRealtimePlaybackActive&&scheduled==1);
 // A short final block must play, then drain, without waiting for a prebuffer.
 gRealtimePlaybackBufferedBytes=2;gRealtimePlaybackActive=true;gPlaybackActive=true;scheduled=0;
 serviceRealtimePlayback();assert(playing==1&&gRealtimePlaybackBufferedBytes==0&&scheduled==0);
 playing=0;serviceRealtimePlayback();assert(!gRealtimePlaybackActive&&scheduled==1);
 // Missing response.done stays pending; it must never arm hands-free early.
 gRealtimeResponseComplete=false;gRealtimePlaybackActive=true;gPlaybackActive=true;scheduled=0;
 serviceRealtimePlayback();assert(!gPlaybackActive&&scheduled==0);
 char b[12];
 clock_display::format(b,sizeof(b),0,5,true,true);assert(!strcmp(b,"12:05 AM"));
 clock_display::format(b,sizeof(b),12,0,true,true);assert(!strcmp(b,"12:00 PM"));
 clock_display::format(b,sizeof(b),16,7,true,true);assert(!strcmp(b,"4:07 PM"));
 clock_display::format(b,sizeof(b),23,59,true,true);assert(!strcmp(b,"11:59 PM"));
 clock_display::format(b,sizeof(b),0,5,false,true);assert(!strcmp(b,"00:05"));
 clock_display::format(b,sizeof(b),16,7,false);assert(!strcmp(b,"16:07"));
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
voice=(parts/'035_main.cpp.inc').read_text()
assert voice.index('client->connect')<voice.index('client->setNoDelay(true)')<voice.index('writeClientAllStaged')
assert 'X-Voice-Wait-Ms: 1000' in voice and 'upload complete bytes=%u ms=%u' in voice
assert 'Transcribing / AI Agent' in voice
settings=(parts/'026_main.cpp.inc').read_text()
assert 'getBool("clk_12h", true)' in settings and 'putBool("clk_12h", gDeviceSettings.clockTwelveHour)' in settings
inbox=(parts/'020_main.cpp.inc').read_text()
assert inbox.index('if (kind == "text" && text.isEmpty())')<inbox.index('gInboxLastSeq = seq')
assert 'voiceReplyWasPending && !gVoiceReplyPending' in inbox
pending=(parts/'039_main.cpp.inc').read_text().split('if (resp["pending"] | false)')[1].split('gVoiceReplyPending = false')[0]
assert 'gAssistantPendingVisible = true' in pending and 'showVoiceNotice(transcript, true)' in pending
assert 'setUiMode(UiMode::ChatFull)' not in pending
print('PASS actual drained/rebuffered playback and 12/24h boundaries; connected TCP_NODELAY; visible voice receipt and delayed reply')

staging=(parts/"034_main.cpp.inc").read_text()
assert "uint8_t stage[" not in staging and staging.count("std::unique_ptr<uint8_t[]> stage")==2

notice=r'''
#include <cassert>
#include <string>
#include <cstdint>
struct String:std::string {using std::string::string;String(const std::string& s):std::string(s){};};
enum class UiMode {Home,ChatFull,Other}; UiMode gUiMode=UiMode::Home;
struct Keyboard_Class {struct KeysState {bool enter=false;};};
bool gVoiceNoticeVisible=false,gInboxUnread=true;
String gQueuedVoiceReplySpeech="voice";uint32_t gVoiceReplySpeechGeneration=4;
bool isAssistantUi(){return gUiMode!=UiMode::Other;}
void setUiMode(UiMode mode){gUiMode=mode;}void logf(const char*,...){}
'''
notice+='\n'+function('065_main.cpp.inc','void dismissVoiceNotice()')
notice+='\n'+function('065_main.cpp.inc','bool handleVoiceNoticeKey(')
notice+=r'''
int main(){
 Keyboard_Class::KeysState keys;
 assert(!handleVoiceNoticeKey('x',keys));
 gVoiceNoticeVisible=true;assert(handleVoiceNoticeKey('x',keys));
 assert(gVoiceNoticeVisible&&gUiMode==UiMode::Home);
 keys.enter=true;assert(handleVoiceNoticeKey('\n',keys));
 assert(!gVoiceNoticeVisible&&gUiMode==UiMode::ChatFull&&!gInboxUnread);
 assert(gQueuedVoiceReplySpeech=="voice"&&gVoiceReplySpeechGeneration==4);
 gUiMode=UiMode::Home;gVoiceNoticeVisible=true;dismissVoiceNotice();
 assert(!gVoiceNoticeVisible&&gQueuedVoiceReplySpeech.empty()&&gVoiceReplySpeechGeneration==5);
 assert(gUiMode==UiMode::Home);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-notice-') as d:
 p=Path(d);(p/'test.cpp').write_text(notice)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
worker=function('065_main.cpp.inc','VoiceSpeechResult* performVoiceReplySpeech(')
for forbidden in ['setUiMode(', 'setStatus(', 'render(', 'gCanvas', 'logf(', 'vTaskDelete(']: assert forbidden not in worker
escape=function('047_main.cpp.inc','bool handleGlobalEscape()')
assert escape.index('gVoiceNoticeVisible') < escape.index('setUiMode(UiMode::Home)')
print('PASS actual notice Enter/open and dismiss/cancel; background speech has no UI mutations')
