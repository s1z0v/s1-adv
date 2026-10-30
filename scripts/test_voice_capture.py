#!/usr/bin/env python3
"""Exercise actual G0 startup: capture/UI precede asynchronous streaming."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'


def function(file, signature):
    source = (parts / file).read_text()
    start = source.index(signature)
    end = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


code = r'''
#include <cassert>
bool radioBusy(){return false;}
bool vlcBusy(){return false;} namespace vlc_remote{void cancel(){}}
void stopInternetRadio(){}
bool synthOwned=true;int synthStops=0;void stopPocketSynth(){synthOwned=false;++synthStops;}
template<class T>bool deferInternetRadioMode(T){return false;}
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
#include <memory>
struct String:std::string {
 using std::string::string;
 bool isEmpty()const{return empty();}
};
uint32_t now=100, micReadyAt=0;
bool micAvailable=true,queueAvailable=true;
bool gVoiceCapturePreparing=false,gMeshBusOwned=false;
String gMeshNotice;uint32_t gMeshNoticeUntilMs=0;
uint32_t millis(){return now;}
bool gRealtimeDialBusy=false,gVoiceReplySpeechBusy=false,gInboxHttpBusy=false;
bool gVoiceDialBusy=false;std::shared_ptr<int> gVoiceCaptureUpload;
void serviceVoicePreconnect(){}
bool gRealtimeExclusiveMode=false,gRealtimeActive=false,gWifiReady=true;
bool gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gRecordFileWriteFailed=false,gRecordingToFile=false,gStorageReady=true,gCanvasSpriteActive=true;
void* gTtsBuffer=nullptr;int16_t* gRecordBuffer=nullptr;size_t gRecordCapacitySamples=100;
size_t gRecordedSamples=0,gActiveRecordBytes=0,gActiveRecordCommittedBytes=0,gActiveRecordExpectedBytes=0;
uint32_t gRecordStartMs=0;uint8_t gVoiceLevel8=0,gRecordNextChunkIndex=0;
std::vector<uint8_t> gRecordInflightChunks;String gHubHost="example.test",gActiveRecordPath;
constexpr size_t kRecordWriteBytes=512;constexpr uint32_t kMicSampleRate=16000;
enum class FaceMode {Error,Listening};
enum class UiMode {Home,Clock,Ota};UiMode gUiMode=UiMode::Home;
struct File {
 bool open=true;explicit operator bool()const{return open;}
 void setBufferSize(size_t){}size_t write(const uint8_t*,size_t n){return n;}
 void close(){open=false;}
};File gActiveRecordFile;
namespace fs {struct FS {File open(const String&,const char*){now+=50;return {};}};}
fs::FS storage;
struct {void reset(){}} gMicInputMeter;
struct {struct {bool record(int16_t*,size_t,uint32_t){return queueAvailable;}} Mic;
 struct {bool pressed=false;bool isPressed(){return pressed;}bool wasPressed(){return pressed;}} BtnA;} M5Cardputer;
auto& M5=M5Cardputer;
int starts=0,stops=0,networkCalls=0,frames=0,queued=0,wakes=0,captureUis=0,startErrors=0;bool sleeping=false;
String status;std::vector<String> frameLabels;
void setStatus(const char*s,int=0){status=s;}void logf(const char*,...){}void setVoiceDiag(const char*){}
void setFaceMode(FaceMode){}void pushError(const char*){}void releaseTtsBuffer(){}
void dismissVoiceNotice(){}void cancelVoicePreconnect(){}
bool remountSdStorage(const char*){return true;}void showVoiceNotice(const char*,bool){}
void pulseButtonPress(){}bool ensureVoiceStorage(){now+=20;return true;}
fs::FS* activeVoiceFs(){return &storage;}
String makeVoiceNoteId(bool){return "test";}String voiceAudioPath(const String&){return "/voice/test.wav";}
String recordingAudioPath(const String&){return "/recordings/20261018/test.wav";}
void writeWavHeader(uint8_t*,uint32_t,uint32_t){}void fsRemove(fs::FS&,const String&){}
void handleRecordingStorageFailure(){assert(false);}void logHeapStats(const char*){}
bool ensureRecordBuffer(){return true;}void beginVoiceWifiPerformance(){}
void beginVoiceRequestUi(){++captureUis;assert(gRecording&&!gVoiceCapturePreparing);}
bool startMic(){assert(!synthOwned);assert(!gRecording&&gVoiceCapturePreparing);++starts;now+=150;micReadyAt=now;return micAvailable;}
void serviceRecordingToFile(){++queued;if(queueAvailable)gRecordInflightChunks.push_back(0);}
void render(){++frames;assert(gCanvasSpriteActive);frameLabels.push_back(status);
 if(gVoiceCapturePreparing)assert(!gRecording);
 if(status=="Recording")assert(gRecording&&!gVoiceCapturePreparing);
}
void stopMic(bool){}void releaseRecordBuffer(){}void endVoiceWifiPerformance(){}void initSpeaker(){}
void showVoiceRequestError(const char*){++startErrors;assert(!gVoiceCapturePreparing&&!gRecording);}
// The former "optimization" both froze the canvas and aged an unused socket.
void beginVoicePreconnect(){++networkCalls;gCanvasSpriteActive=false;now+=6000;}
void beginVoiceCaptureUpload(){assert(gRecording&&gRecordingToFile&&gActiveRecordFile&&!gVoiceCapturePreparing&&frameLabels.back()=="Recording");}
bool handleScreensaverWake(){++wakes;bool was=sleeping;sleeping=false;return was;}
struct {void printf(const char*,...){} } Serial;
void noteUiInput(const char*){}
bool gG0VoicePending=false,gInboxCancelRequested=false;uint32_t gG0VoiceRequestedMs=0;
bool gG0VoiceHeld=false,gCtrlSoloCandidate=false;uint32_t gLastCtrlTapMs=0;
bool stopRecordingAndSend(){++stops;gRecording=false;return true;}
void appendRuntimeLog(const char*,const char*,bool){}void applyOtaFromManifest(){assert(false);}
'''
code += function('033_main.cpp.inc', 'void startRecording()') + '\n'
code += function('049_main.cpp.inc', 'void updateG0VoiceTrigger()') + '\n'
code += r'''
int main(){
 for(bool asleep:{false,true}){
  sleeping=asleep;gRecording=false;gG0VoiceHeld=false;gUiMode=asleep?UiMode::Clock:UiMode::Home;
  synthOwned=true;int beforeSynthStops=synthStops;
  int before=starts;uint32_t requested=now;
  M5Cardputer.BtnA.pressed=true;updateG0VoiceTrigger();
  assert(!synthOwned&&synthStops==beforeSynthStops+1);
  assert(starts==before+1&&gRecording&&!sleeping);
  assert(now-requested==220&&gRecordStartMs==micReadyAt); // Excludes initialization from REC time.
  assert(frameLabels[frameLabels.size()-2]=="Loading voice..."&&frameLabels.back()=="Recording");
  assert(networkCalls==0&&gCanvasSpriteActive&&queued==starts);
  for(int sec=0;sec<20;++sec){now+=1000;updateG0VoiceTrigger();render();}
  assert(starts==before+1&&gRecording&&networkCalls==0&&gCanvasSpriteActive);
  M5Cardputer.BtnA.pressed=false;updateG0VoiceTrigger();
  assert(!gRecording&&!gG0VoiceHeld&&stops==before+1);
 }
 // The first frame appears while the existing poll drains. Keep holding to
 // capture automatically, and release cancels a queued start without a send.
 gUiMode=UiMode::Home;gInboxHttpBusy=true;gG0VoiceHeld=false;gRecording=false;
 int prior=starts,priorFrames=frames;M5Cardputer.BtnA.pressed=true;updateG0VoiceTrigger();
 assert(gG0VoicePending&&gInboxCancelRequested&&starts==prior&&frames==priorFrames+1);
 now+=200;updateG0VoiceTrigger();assert(starts==prior);
 gInboxHttpBusy=false;updateG0VoiceTrigger();assert(gRecording&&starts==prior+1&&!gG0VoicePending);
 M5Cardputer.BtnA.pressed=false;updateG0VoiceTrigger();
 gInboxHttpBusy=true;M5Cardputer.BtnA.pressed=true;updateG0VoiceTrigger();
 M5Cardputer.BtnA.pressed=false;updateG0VoiceTrigger();assert(!gG0VoicePending&&!gRecording);
 gInboxHttpBusy=false;updateG0VoiceTrigger();assert(starts==prior+1);
 // The Mesh mode cannot start capture, an upload, or preconnect from G0.
 gMeshBusOwned=true;gRecording=false;int meshBefore=starts,meshFrames=captureUis;
 M5Cardputer.BtnA.pressed=true;updateG0VoiceTrigger();startRecording();
 assert(!gRecording&&!gG0VoicePending&&starts==meshBefore&&captureUis==meshFrames);
 gMeshBusOwned=false;M5Cardputer.BtnA.pressed=false;
 // Neither a failed mic nor a rejected first buffer may publish REC.
 for(bool sd:{false,true})for(bool mic:{false,true}){
  gStorageReady=sd;micAvailable=mic;queueAvailable=false;
  gRecording=false;int beforeUi=captureUis,beforeError=startErrors;
  frameLabels.clear();startRecording();
  assert(!gRecording&&!gRecordingToFile&&!gVoiceCapturePreparing);
  assert(captureUis==beforeUi&&startErrors==beforeError+1);
  assert(frameLabels.size()==1&&frameLabels[0]=="Loading voice...");
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-capture-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)

# The fallback dial still follows finalization; streaming begins asynchronously
# only after the actual capture and first REC frame have succeeded.
post = function('035_main.cpp.inc', 'bool postRawVoiceTurn(')
assert post.index('beginVoicePreconnect();') < post.index('takeVoicePreconnect()') < post.index('writeClientAll(*client, headers')
begin = function('065_main.cpp.inc', 'void beginVoicePreconnect()')
assert begin.index('if (gRecording) return;') < begin.index('releaseUiCanvasForNetwork(')
print('PASS actual G0 starts on wake, capture/REC precede async streaming, no synchronous TLS/canvas borrowing during a 20-second hold')

paths = r'''
#include <cassert>
#include <string>
#include <ctime>
struct String:std::string {
 using std::string::string;String(const std::string& value):std::string(value){}
};
bool gSdReady=true,canCreate=true;const char* kVoiceDir="/voice";const char* kVoiceAudioExt=".wav";
int SD=0;String made;
bool ensureDirRecursive(int&,const String& path){made=path;return canCreate;}
'''
paths += function('013_main.cpp.inc', 'String voiceAudioPath(') + '\n'
paths += function('013_main.cpp.inc', 'String recordingAudioPath(') + '\n'
paths += r'''
int main(){
 const String legacy=voiceAudioPath("u_saved");assert(legacy=="/voice/u_saved.wav");
 const String fresh=recordingAudioPath("u_new");
 assert(fresh.find("/recordings/")==0&&fresh==made+"/u_new.wav"&&made.size()==20);
 assert(voiceAudioPath("u_saved")==legacy);
 canCreate=false;assert(recordingAudioPath("u_failed").empty());
 gSdReady=false;assert(recordingAudioPath("u_flash")=="/voice/u_flash.wav");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-capture-path-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(paths)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS daily SD recording paths, unchanged old/flash paths, safe directory creation failure')
