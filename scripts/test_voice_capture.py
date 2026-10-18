#!/usr/bin/env python3
"""Exercise actual G0/capture startup against slow storage and an idle TLS trap."""
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
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
struct String:std::string {
 using std::string::string;
 bool isEmpty()const{return empty();}
};
uint32_t now=100, micReadyAt=0;
uint32_t millis(){return now;}
bool gRealtimeDialBusy=false,gVoiceReplySpeechBusy=false,gInboxHttpBusy=false;
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
struct {struct {bool record(int16_t*,size_t,uint32_t){return true;}} Mic;
 struct {bool pressed=false;bool isPressed(){return pressed;}} BtnA;} M5Cardputer;
auto& M5=M5Cardputer;
int starts=0,stops=0,networkCalls=0,frames=0,queued=0,wakes=0;bool sleeping=false;
void setStatus(const char*,int=0){}void logf(const char*,...){}void setVoiceDiag(const char*){}
void setFaceMode(FaceMode){}void pushError(const char*){}void releaseTtsBuffer(){}
void dismissVoiceNotice(){}void cancelVoicePreconnect(){}
bool remountSdStorage(const char*){return true;}void showVoiceNotice(const char*,bool){}
void pulseButtonPress(){}bool ensureVoiceStorage(){now+=20;return true;}
fs::FS* activeVoiceFs(){return &storage;}
String makeVoiceNoteId(bool){return "test";}String voiceAudioPath(const String&){return "/voice/test.wav";}
void writeWavHeader(uint8_t*,uint32_t,uint32_t){}void fsRemove(fs::FS&,const String&){}
void handleRecordingStorageFailure(){assert(false);}void logHeapStats(const char*){}
bool ensureRecordBuffer(){return true;}void beginVoiceWifiPerformance(){}void beginVoiceRequestUi(){}
void startMic(){++starts;now+=150;micReadyAt=now;}
void serviceRecordingToFile(){++queued;}
void render(){++frames;assert(gCanvasSpriteActive);}
// The former "optimization" both froze the canvas and aged an unused socket.
void beginVoicePreconnect(){++networkCalls;gCanvasSpriteActive=false;now+=6000;}
bool handleScreensaverWake(){++wakes;bool was=sleeping;sleeping=false;return was;}
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
  int before=starts;uint32_t requested=now;
  M5Cardputer.BtnA.pressed=true;updateG0VoiceTrigger();
  assert(starts==before+1&&gRecording&&!sleeping);
  assert(now-requested==220&&gRecordStartMs==micReadyAt); // Excludes initialization from REC time.
  assert(networkCalls==0&&gCanvasSpriteActive&&queued==starts);
  for(int sec=0;sec<20;++sec){now+=1000;updateG0VoiceTrigger();render();}
  assert(starts==before+1&&gRecording&&networkCalls==0&&gCanvasSpriteActive);
  M5Cardputer.BtnA.pressed=false;updateG0VoiceTrigger();
  assert(!gRecording&&!gG0VoiceHeld&&stops==before+1);
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-capture-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)

# Dialing may only be reachable after finalization, immediately before upload.
post = function('035_main.cpp.inc', 'bool postRawVoiceTurn(')
assert post.index('beginVoicePreconnect();') < post.index('takeVoicePreconnect()') < post.index('writeClientAll(*client, headers')
begin = function('065_main.cpp.inc', 'void beginVoicePreconnect()')
assert begin.index('if (gRecording) return;') < begin.index('releaseUiCanvasForNetwork(')
print('PASS actual G0 starts on wake, capture excludes setup time, no TLS/canvas borrowing during a 20-second hold, fresh dial at upload')
