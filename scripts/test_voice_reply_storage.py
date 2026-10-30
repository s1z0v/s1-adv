#!/usr/bin/env python3
"""Run actual reply storage selection, playback opening and temporary cleanup."""
from pathlib import Path
import os
import subprocess
import tempfile

parts = Path(__file__).resolve().parents[1] / 'bots/CardputerADV/src/main_parts'


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
bool radioBusy(){return false;}
void stopInternetRadio(){}
bool synthOwned=true;void stopPocketSynth(){synthOwned=false;}
template<class T>bool deferInternetRadioMode(T){return false;}
#include <cstdint>
#include <cstdlib>
#include <algorithm>
#include <string>
#include <map>
using std::min;
struct String:std::string {
 using std::string::string;String(const std::string& s):std::string(s){}
 bool startsWith(String s)const{return compare(0,s.size(),s)==0;}
 bool endsWith(String s)const{return size()>=s.size()&&compare(size()-s.size(),s.size(),s)==0;}
};
namespace fs {struct FS;}
bool speakerStopped=true;
struct File {fs::FS* backend=nullptr;bool valid=false;
 explicit operator bool()const{return valid;}void close(){assert(speakerStopped);valid=false;}};
namespace fs {struct FS {
 uint64_t total=2*1024*1024,used=100*1024;std::map<std::string,size_t> files;
 uint64_t totalBytes(){return total;}uint64_t usedBytes(){return used;}
 File open(String path,const char*){return {this,files.count(path)>0};}
};}
fs::FS SD,LittleFS;bool gLittleFsReady=true,storageReady=true;
fs::FS* activeVoiceFs(){return &SD;}
bool ensureVoiceStorageOn(fs::FS&){return storageReady;}
bool fsExists(fs::FS& fs,String path){return fs.files.count(path)>0;}
bool fsRemove(fs::FS& fs,String path){return fs.files.erase(path)>0;}
File gPlaybackStreamFile;String gPlaybackStreamPath;fs::FS* gPlaybackStreamFs=nullptr;
bool gPlaybackStreaming=false,gPlaybackStreamRawPcm=false,gPlaybackActive=false;
size_t gPlaybackStreamRemainingBytes=0,gPlaybackStreamTotalBytes=0,gPlaybackStreamNextBuffer=0;
uint32_t gPlaybackStreamSampleRate=0,gPlaybackStartedMs=0,gPlaybackDurationMs=0,gPlaybackLastProgressMs=0;
void* gDynamicPlaybackBuffer=nullptr;
struct {struct {void stop(){speakerStopped=true;}} Speaker;} M5Cardputer;
void resetPlaybackAnalyzer(){}void pulseButtonPress(){}void setStatus(String,int){}
void setVoiceDiag(String){}enum class FaceMode{Speaking};void setFaceMode(FaceMode){}
uint32_t millis(){return 100;}
uint32_t playbackDurationMsForBytes(size_t bytes,uint32_t rate){return bytes*500/rate;}
'''
code += function('065_main.cpp.inc', 'fs::FS* voiceReplyStorage(')
code += function('021_main.cpp.inc', 'void stopPlaybackStream()')
code += function('022_main.cpp.inc', 'bool startPlaybackStreamFromRawPcmFile(')
code += r'''
int main(){
 size_t capacity=0;
 assert(voiceReplyStorage(capacity)==&LittleFS&&capacity==LittleFS.total-LittleFS.used-65536);
 LittleFS.used=LittleFS.total-65536;assert(voiceReplyStorage(capacity)==&SD);
 LittleFS.used=0;gLittleFsReady=false;assert(voiceReplyStorage(capacity)==&SD);
 gLittleFsReady=true;storageReady=false;assert(voiceReplyStorage(capacity)==&SD);storageReady=true;
 const String reply="/voice/__reply_1.pcm",original="/voice/u_record.wav";
 LittleFS.files[reply]=80000;SD.files[reply]=123;SD.files[original]=749612;
 assert(startPlaybackStreamFromRawPcmFile(reply,24000,80000,"reply",&LittleFS));
 assert(!synthOwned);
 assert(gPlaybackStreamFile.backend==&LittleFS&&gPlaybackStreamFs==&LittleFS);
 speakerStopped=false;stopPlaybackStream();assert(!LittleFS.files.count(reply)&&SD.files[reply]==123);
 assert(!gPlaybackStreamFs&&!gPlaybackStreaming);
 assert(startPlaybackStreamFromRawPcmFile(original,16000,749612,"recording"));
 assert(gPlaybackStreamFile.backend==&SD);stopPlaybackStream();assert(SD.files[original]==749612);
 assert(!startPlaybackStreamFromRawPcmFile(reply,24000,80000,"missing reply",&LittleFS));
}
'''
with tempfile.TemporaryDirectory(prefix='s1-reply-storage-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual reply storage/playback: flash reserve and fallback, same backend for open/delete, original SD recording preserved')
