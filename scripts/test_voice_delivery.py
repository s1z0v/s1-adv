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
bool gRealtimeRecording=false,gRealtimeRestartAfterPlayback=false;
uint32_t gRealtimeNextListenMs=0;
constexpr uint32_t kRealtimeListenRestartDelayMs=120;
constexpr int MALLOC_CAP_8BIT=0;
struct {unsigned getFreeHeap(){return 100000;}} ESP;
unsigned heap_caps_get_largest_free_block(int){return 32000;}
int started=0,failed=0,playing=0;
void startRealtimeRecording(){++started;gRealtimeRecording=true;gRealtimeAudioComplete=false;gRealtimeResponseComplete=false;}
enum class FaceMode {Idle,Speaking,Error};
void setFaceMode(FaceMode){}
void setStatus(const char*,int=0){}
void setVoiceDiag(const char*){}
void appendRuntimeLog(const char*,const char*,bool){}
void logf(const char*,...){}
void failRealtimeSession(const char*){++failed;gRealtimeActive=false;}

size_t readRealtimePlaybackRing(uint8_t*,size_t n){gRealtimePlaybackBufferedBytes-=n;return n;}
void updatePlaybackAnalyzerFromSamples(const int16_t*,size_t,uint32_t){}
struct SpeakerStub {size_t isPlaying(int){return playing;} bool playRaw(const int16_t*,size_t,uint32_t,bool,int,int,bool){playing=1;return true;}};
struct {SpeakerStub Speaker;} M5Cardputer;
'''
code+='\n'+function('041_main.cpp.inc','void scheduleRealtimeListenAfterPlayback()')
code+='\n'+function('041_main.cpp.inc','void serviceRealtimeListenRestart(')
code+='\n'+function('041_main.cpp.inc','void serviceRealtimePlayback()')
code+=f'\n#include "{root}/bots/CardputerADV/src/clock_display.h"\n'
code+=r'''
int main(){
 // The real function used to return at its prebuffer gate, leaving busy set.
 serviceRealtimePlayback();
 assert(!gRealtimePlaybackActive&&!gPlaybackActive&&!gRealtimePlaybackFeeding&&gRealtimeRestartAfterPlayback==1&&failed==0);
 // A speaker that still owns DMA data must finish before we restart the mic.
 playing=1;gRealtimePlaybackActive=true;gPlaybackActive=true;gRealtimeRestartAfterPlayback=0;
 serviceRealtimePlayback();assert(gRealtimePlaybackActive&&gRealtimeRestartAfterPlayback==0);
 playing=0;serviceRealtimePlayback();assert(!gRealtimePlaybackActive&&gRealtimeRestartAfterPlayback==1);
 // A short final block must play, then drain, without waiting for a prebuffer.
 gRealtimePlaybackBufferedBytes=2;gRealtimePlaybackActive=true;gPlaybackActive=true;gRealtimeRestartAfterPlayback=0;
 serviceRealtimePlayback();assert(playing==1&&gRealtimePlaybackBufferedBytes==0&&gRealtimeRestartAfterPlayback==0);
 playing=0;serviceRealtimePlayback();assert(!gRealtimePlaybackActive&&gRealtimeRestartAfterPlayback==1);
 // Missing response.done stays pending; it must never arm hands-free early.
 gRealtimeResponseComplete=false;gRealtimePlaybackActive=true;gPlaybackActive=true;gRealtimeRestartAfterPlayback=0;
 serviceRealtimePlayback();assert(!gPlaybackActive&&gRealtimeRestartAfterPlayback==0);
 // Repeated drain service must not move the restart deadline on every loop.
 for(int turn=0;turn<3;++turn){
  gRealtimeRecording=false;gRealtimeRestartAfterPlayback=false;
  gRealtimeAudioComplete=true;gRealtimeResponseComplete=true;gRealtimeHandsFreeActive=true;
  gPlaybackActive=false;gRealtimePlaybackActive=false;nowMs+=1000;
  serviceRealtimePlayback();uint32_t deadline=gRealtimeNextListenMs;int before=started;
  for(int tick=0;tick<120;++tick){serviceRealtimePlayback();serviceRealtimeListenRestart(nowMs++);assert(started==before);assert(gRealtimeNextListenMs==deadline);}
  serviceRealtimePlayback();serviceRealtimeListenRestart(nowMs);assert(started==before+1&&gRealtimeRecording);
 }
 // Manual commit cannot silently re-enable hands-free capture.
 gRealtimeRecording=false;gRealtimeRestartAfterPlayback=false;gRealtimeHandsFreeActive=false;
 gRealtimeAudioComplete=true;gRealtimeResponseComplete=true;serviceRealtimePlayback();
 serviceRealtimeListenRestart(nowMs+1000);assert(!gRealtimeRecording&&!gRealtimeRestartAfterPlayback);
 // Restart deadlines remain valid across the 32-bit millisecond wrap.
 gRealtimeHandsFreeActive=true;nowMs=0xfffffff0U;scheduleRealtimeListenAfterPlayback();
 int before=started;serviceRealtimeListenRestart(0xffffffffU);assert(started==before);
 serviceRealtimeListenRestart(gRealtimeNextListenMs);assert(started==before+1);
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
assert 'gAssistantPendingVisible = false' in pending and 'showVoiceNotice(transcript, true)' in pending
assert 'setFaceMode(FaceMode::Idle)' in pending and '"Request accepted", 1500' in pending
assert 'receiptSeq>gInboxLastSeq' in pending
assert 'setUiMode(UiMode::ChatFull)' not in pending
print('PASS actual drained/rebuffered playback and 12/24h boundaries; connected TCP_NODELAY; visible voice receipt and delayed reply')

staging=(parts/"034_main.cpp.inc").read_text()
assert "uint8_t stage[" not in staging and staging.count("HttpStageLease stage")==2

notice=r'''
#include <cassert>
#include <string>
#include <cstdint>
struct String:std::string {using std::string::string;String(const std::string& s):std::string(s){};};
enum class UiMode {Home,Clock,ChatFull,ChatFace,Other}; UiMode gUiMode=UiMode::Home;
struct Keyboard_Class {struct KeysState {bool enter=false,ctrl=false;};};
bool gVoiceNoticeVisible=false,gInboxUnread=true;
enum class VoiceRequestPhase {None,Recording,Sending,Processing,Accepted,Reply,Error};
VoiceRequestPhase gVoiceRequestPhase=VoiceRequestPhase::None;
String gVoiceRequestTranscript,gVoiceNoticeText;unsigned gVoiceRequestProgress=0;
bool gVoiceNoticePending=false,gLauncherVisible=false,gChatCommandsVisible=false;
bool gRecording=false,gSubmitting=false,gThinking=false,gAssistantPendingVisible=false,gPlaybackActive=false;
bool gVoiceReplyPending=true;unsigned gVoiceNoticeShownMs=0;
enum class AssistantPulseState{Realtime,Recording,Thinking,Playback,Ready};
bool gRealtimeActive=false,gRealtimeRecording=false,gRealtimeAwaiting=false;
enum class FaceMode {Idle};void setFaceMode(FaceMode){}
unsigned millis(){return 100;}void markUserActivity(){}
bool gScreensaverActive=false,gScreensaverDimmed=false,gScreenOffActive=false,gCanvasSpriteActive=true;
unsigned gLastRenderMs=0;void render(){}bool handleScreensaverWake(){return false;}
void removeLastUtf8Char(String& s){s.pop_back();}String cleanReplyForDevice(const String& s){return s;}
void cancelRecordingDiscard(){gRecording=false;}
void stopPlaybackStream(){}void setStatus(const char*,int){}
String gQueuedVoiceReplySpeech="voice";uint32_t gVoiceReplySpeechGeneration=4;
bool isAssistantUi(){return gUiMode!=UiMode::Other;}
void setUiMode(UiMode mode){gUiMode=mode;}void logf(const char*,...){}
'''
notice+='\n'+function('065_main.cpp.inc','void dismissVoiceNotice()')
notice+='\n'+function('065_main.cpp.inc','void beginVoiceRequestUi()')
notice+='\n'+function('065_main.cpp.inc','void showVoiceNotice(')
notice+='\n'+function('065_main.cpp.inc','void showVoiceRequestError(')
notice+='\n'+function('065_main.cpp.inc','bool handleVoiceRequestEscape()')
notice+='\n'+function('065_main.cpp.inc','bool handleVoiceNoticeKey(')
notice+='\n'+function('065_main.cpp.inc','bool voiceRequestBusyUi()')
notice+='\n'+function('009_main.cpp.inc','AssistantPulseState assistantPulseState()')
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
 gUiMode=UiMode::Clock;showVoiceNotice("Clock answer",false);
 assert(gVoiceNoticeVisible&&handleVoiceNoticeKey('\n',keys)&&gUiMode==UiMode::ChatFull);
 gUiMode=UiMode::Home;
 // The owned request survives capture, submission and receipt. Esc cannot
 // discard a transport still in flight, and accepting a receipt never cancels
 // the server task when the UI is dismissed.
 beginVoiceRequestUi();assert(gVoiceNoticeVisible&&gVoiceRequestPhase==VoiceRequestPhase::Recording&&voiceRequestBusyUi());
 gRecording=true;keys.enter=false;keys.ctrl=true;assert(!handleVoiceNoticeKey('v',keys));
 keys.ctrl=false;assert(handleVoiceNoticeKey('x',keys));
 gRecording=false;gVoiceRequestPhase=VoiceRequestPhase::Sending;
 // SD finalization already owns the window, before network busy flags are set.
 keys.enter=true;assert(handleVoiceRequestEscape()&&gVoiceNoticeVisible);
 assert(handleVoiceNoticeKey('\n',keys)&&gVoiceNoticeVisible&&gUiMode==UiMode::Home);
 gSubmitting=true;gThinking=true;
 assert(handleVoiceRequestEscape()&&gVoiceNoticeVisible&&gVoiceRequestPhase==VoiceRequestPhase::Sending);
 keys.enter=true;assert(handleVoiceNoticeKey('\n',keys)&&gVoiceNoticeVisible);
 gSubmitting=false;gThinking=false;showVoiceNotice("Russian input is retained",true);
 assert(!voiceRequestBusyUi());
 gAssistantPendingVisible=true;assert(assistantPulseState()==AssistantPulseState::Ready);
 assert(gVoiceRequestPhase==VoiceRequestPhase::Accepted&&gVoiceRequestTranscript=="Russian input is retained");
 assert(handleVoiceRequestEscape()&&!gVoiceNoticeVisible&&gUiMode==UiMode::Home&&gVoiceReplyPending);
 showVoiceNotice("Actual answer",false);assert(gVoiceRequestPhase==VoiceRequestPhase::Reply);
 assert(handleVoiceNoticeKey('\n',keys)&&!gVoiceNoticeVisible&&gUiMode==UiMode::ChatFull&&gVoiceReplyPending);
 showVoiceRequestError("Connection interrupted");assert(gVoiceRequestPhase==VoiceRequestPhase::Error);
 assert(!gVoiceNoticeVisible); // Already in chat: errors and replies stay inline.
 gUiMode=UiMode::Home;showVoiceRequestError("Connection interrupted");
 assert(handleVoiceRequestEscape()&&!gVoiceNoticeVisible&&gUiMode==UiMode::Home);
 for(auto mode:{UiMode::ChatFull,UiMode::ChatFace}){
  gUiMode=mode;beginVoiceRequestUi();gRecording=true;assert(voiceRequestBusyUi());
  gRecording=false;gVoiceRequestPhase=VoiceRequestPhase::Sending;
  assert(voiceRequestBusyUi()&&assistantPulseState()==AssistantPulseState::Thinking);
  gVoiceRequestPhase=VoiceRequestPhase::Processing;assert(voiceRequestBusyUi());
  showVoiceNotice("Request",true);assert(!voiceRequestBusyUi()&&!gVoiceNoticeVisible&&gUiMode==mode);
  assert(assistantPulseState()==AssistantPulseState::Ready&&gVoiceReplyPending);
  showVoiceNotice("Answer",false);assert(!gVoiceNoticeVisible&&gUiMode==mode);
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-notice-') as d:
 p=Path(d);(p/'test.cpp').write_text(notice)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
worker=function('065_main.cpp.inc','VoiceSpeechResult* performVoiceReplySpeech(')
for forbidden in ['setUiMode(', 'setStatus(', 'render(', 'gCanvas', 'logf(', 'vTaskDelete(']: assert forbidden not in worker
escape=function('047_main.cpp.inc','bool handleGlobalEscape()')
assert escape.index('handleVoiceRequestEscape()') < escape.index('setUiMode(UiMode::Home)')
state=function('009_main.cpp.inc','AssistantPulseState assistantPulseState()')
assert 'gVoiceReplyPending' not in state
print('PASS voice transitions, busy dismissal guard, accepted receipt, Enter chat, Esc Home; pending server task survives UI dismissal')

record=r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <algorithm>
using std::max;
uint32_t gRecordStartMs=1,gActiveRecordBytes=0;bool gCanvasSpriteActive=true;
uint32_t millis(){return 1;}void logf(const char*,...){}
bool gRecording=false,gRecordingToFile=true,gRecordFileWriteFailed=false;int storageFailures=0;void handleRecordingStorageFailure(){++storageFailures;}std::deque<uint8_t> gRecordInflightChunks={0,1};
int flushed=0,queued=0;uint8_t gRecordNextChunkIndex=0;constexpr int kRecordChunkBufferCount=3;
struct {struct {int isRecording(){return 0;}} Mic;} M5Cardputer;
void flushCompletedRecordChunksToFile(size_t n){flushed+=n;while(n--&&!gRecordInflightChunks.empty())gRecordInflightChunks.pop_front();}
bool queueRecordChunk(uint8_t){++queued;return true;}
'''
record+='\n'+function('032_main.cpp.inc','void serviceRecordingToFile(')
record+='\n'+function('033_main.cpp.inc','void writeWavHeader(')
record+=r'''
uint32_t le(const uint8_t* p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
int main(){
 serviceRecordingToFile(false);assert(flushed==2&&queued==0&&gRecordInflightChunks.empty());
 gRecordInflightChunks={0,1};serviceRecordingToFile(true);assert(flushed==2&&queued==0);
 gRecording=true;serviceRecordingToFile(true);assert(flushed==4&&queued==2&&gRecordInflightChunks.size()==2);
 gRecordFileWriteFailed=true;serviceRecordingToFile(true);assert(storageFailures==1&&queued==2);
 uint8_t h[44];writeWavHeader(h,32000,16000);
 assert(!memcmp(h,"RIFF",4)&&!memcmp(h+8,"WAVE",4)&&le(h+4)==32036&&le(h+40)==32000);
 assert(le(h+24)==16000&&le(h+28)==32000&&h[22]==1&&h[34]==16);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-record-') as d:
 p=Path(d);(p/'test.cpp').write_text(record)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
source=(parts/'038_main.cpp.inc').read_text()
assert 'rememberVoiceNoteFromPcmFile' not in source and 'registerDownloadedVoiceNote(pcmUploadPath' in source
assert 'fsRemove' not in (parts/'039_main.cpp.inc').read_text().split('if (!transportOk')[0]
assert 'constexpr uint32_t kMicSampleRate = 16000' in (parts/'001_main.cpp.inc').read_text()
assert 'CompressedVoiceUpload' not in voice and 'encodeVoiceUpload' not in voice
for name in ['VoiceDialResult* performVoicePreconnect(']:
 worker=function('065_main.cpp.inc',name)
 for forbidden in ['setUiMode(', 'setStatus(', 'render(', 'gCanvas', 'logf(', 'vTaskDelete(']: assert forbidden not in worker
print('PASS actual stopped-mic tail drain and WAV header; one saved file; direct PCM16 upload; connection-worker ownership')

canvas=r'''
#include <cassert>
#include <cstdint>
bool gCanvasSpriteActive=false;uint32_t gLastRenderMs=5;bool allocation=false;int configured=0;
namespace fonts {int Font2;}
struct {void setColorDepth(int){};void* createSprite(int,int){return allocation?(void*)1:nullptr;}
 void setTextWrap(bool){};void setFont(int*){};void setTextSize(int){};} gCanvas;
struct {int getFreeHeap(){return 10000;}} ESP;
constexpr int MALLOC_CAP_8BIT=0;int heap_caps_get_largest_free_block(int){return 4000;}
void configureEmojiRendering(){++configured;}void logf(const char*,...){}
'''
canvas+='\n'+function('006_main.cpp.inc','void restoreUiCanvasAfterNetwork()')
canvas+=r'''
int main(){restoreUiCanvasAfterNetwork();assert(!gCanvasSpriteActive&&configured==0);
 allocation=true;restoreUiCanvasAfterNetwork();assert(gCanvasSpriteActive&&configured==1&&gLastRenderMs==0);
 restoreUiCanvasAfterNetwork();assert(configured==1);}
'''
with tempfile.TemporaryDirectory(prefix='s1-canvas-') as d:
 p=Path(d);(p/'test.cpp').write_text(canvas)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS real canvas recovery rejects failed allocation and recovers before rendering')


storage=r"""
#include <cassert>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <string>
#include <vector>
#include <deque>
#include <algorithm>
using std::min;using String=std::string;
constexpr size_t kRecordWriteBytes=512;constexpr uint32_t kMicSampleRate=16000;
struct File {
 std::vector<uint8_t> bytes;size_t pos=0,calls=0,failCall=999;bool open=true;
 explicit operator bool()const{return open;}
 size_t write(const uint8_t* p,size_t n){assert(n<=512);size_t m=(calls++==failCall)?min(n,size_t(468)):n;
 if(pos+m>bytes.size())bytes.resize(pos+m);memcpy(bytes.data()+pos,p,m);pos+=m;return m;}
 size_t size(){return bytes.size();}void flush(){}bool seek(size_t p){pos=p;return true;}void close(){open=false;}
};
bool gRecording=true,gRecordingToFile=true;File gActiveRecordFile;String gActiveRecordPath="/voice/original.wav";
std::deque<uint8_t> gRecordInflightChunks={0,1};size_t gActiveRecordBytes=468,gActiveRecordCommittedBytes=468,gActiveRecordExpectedBytes=2048,gRecordedSamples=234;
int micStops=0,connectionCancels=0,wifiRestores=0,speakerStarts=0,notices=0;String lastError;
enum class FaceMode{Error};enum class LineKind{Error};
void stopMic(bool restart){assert(!restart);++micStops;}void cancelVoicePreconnect(){++connectionCancels;}
void endVoiceWifiPerformance(){++wifiRestores;}void initSpeaker(){++speakerStarts;}
void setVoiceDiag(const char*){}void setFaceMode(FaceMode){}void setStatus(const char*,int){}
void pushLine(const char*,const String& s,LineKind){lastError=s;}
void showVoiceRequestError(const String&){++notices;}void logf(const char*,...){}
"""
storage+='\n'+function('033_main.cpp.inc','void writeWavHeader(')
storage+='\n'+function('032_main.cpp.inc','size_t writeRecordedBytes(')
storage+='\n'+function('032_main.cpp.inc','void handleRecordingStorageFailure(')
storage+=r"""
int main(){
 uint8_t b[2048];for(size_t i=0;i<sizeof(b);++i)b[i]=uint8_t(i*17+3);
 File good;assert(writeRecordedBytes(good,b,sizeof(b))==sizeof(b));assert(good.calls==4&&good.bytes.size()==2048);
 assert(!memcmp(b,good.bytes.data(),2048));
 File failed;failed.failCall=0;assert(writeRecordedBytes(failed,b,sizeof(b))==468);assert(failed.calls==1&&failed.bytes.size()==468);
 gActiveRecordFile.bytes.resize(44+468);memcpy(gActiveRecordFile.bytes.data()+44,b,468);
 handleRecordingStorageFailure();
 assert(!gRecording&&!gRecordingToFile&&!gActiveRecordFile.open&&gRecordInflightChunks.empty());
 assert(micStops==1&&connectionCancels==1&&wifiRestores==1&&speakerStarts==1&&notices==1);
 assert(gActiveRecordFile.bytes.size()==44+468&&!memcmp(gActiveRecordFile.bytes.data()+44,b,468));
 assert(gActiveRecordPath.empty()&&gActiveRecordBytes==0&&gRecordedSamples==0&&!lastError.empty());
}
"""
with tempfile.TemporaryDirectory(prefix='s1-sd-failure-') as d:
 p=Path(d);(p/'test.cpp').write_text(storage)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
assert source.index('gActiveRecordFile.flush()') < source.index('const size_t fileBytes = gActiveRecordFile.size()')
print('PASS actual bounded SD writes, short-write stop/cleanup, retained PCM, and flush before WAV sizing')
