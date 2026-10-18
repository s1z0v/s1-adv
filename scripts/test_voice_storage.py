#!/usr/bin/env python3
"""Exercise real bounded history/recovery scans without mutating SD files."""
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
#include <cstdint>
#include <string>
#include <vector>
#include <deque>
struct String:std::string {
 using std::string::string;String(const std::string& s):std::string(s){}
 bool endsWith(String suffix)const{return size()>=suffix.size()&&compare(size()-suffix.size(),suffix.size(),suffix)==0;}
 int indexOf(String text)const{auto n=find(text);return n==npos?-1:int(n);}
};
uint32_t now=0;uint32_t millis(){return now;}void yield(){++now;}
void logf(const char*,...){}void pumpBlockingNetworkUi(){now+=10;}
constexpr unsigned kMicSampleRate=16000;const char* kVoiceDir="/voice";
struct Entry{String path;size_t bytes;bool dir=false;};std::vector<Entry> entries,recordingRoot,recordingDay;
bool endless=false;
struct File{
 bool valid=false,dir=false;Entry entry;size_t cursor=0;
 explicit operator bool()const{return valid;}
 bool isDirectory(){return dir;}String path(){return entry.path;}size_t size(){return entry.bytes;}
 void close(){valid=false;}
 File openNextFile(){if(endless)return {true,false,{"/voice/other.wav",100}};
  auto& files=entry.path=="/recordings"?recordingRoot:entry.path=="/recordings/20261018"?recordingDay:entries;
  if(cursor==files.size())return {};auto next=files[cursor++];return {true,next.dir,next};}
} gVoiceNotesScanDir;
namespace fs{struct FS{File open(const String& path){return {true,true,{path,0,true}};}};}
fs::FS sd;fs::FS* activeVoiceFs(){return &sd;}bool ensureVoiceStorage(){return true;}
bool gVoiceNotesScanActive=false;int remaining=0;
void startVoiceNotesScan(){gVoiceNotesScanActive=true;gVoiceNotesScanDir={true,true,{}};}
bool serviceVoiceNotesScan(int){++now;if(remaining<0)return false;
 if(remaining--==0){gVoiceNotesScanActive=false;return true;}return false;}
struct VoiceNote{String audioPath;unsigned durationMs=0;};
'''
code += function('014_main.cpp.inc', 'bool loadVoiceNotes()')
code += function('043_main.cpp.inc', 'bool findSavedVoiceNoteBySize(')
code += r'''
int main(){
 remaining=3;assert(loadVoiceNotes()&&!gVoiceNotesScanActive);
 remaining=-1;now=0;assert(!loadVoiceNotes()&&now>=5000&&now<5020);
 assert(!gVoiceNotesScanActive&&!gVoiceNotesScanDir);
 now=0xfffffff0U;assert(!loadVoiceNotes()&&uint32_t(now-0xfffffff0U)>=5000);
 VoiceNote note;entries={{"/voice/a_answer.wav",749612},{"/voice/u_record.wav",749612},{"/voice/u_other.wav",100}};
 now=0;assert(findSavedVoiceNoteBySize(749612,note)&&note.audioPath=="/voice/u_record.wav"&&note.durationMs==23424);
 entries.push_back({"/voice/u_duplicate.wav",749612});
 assert(!findSavedVoiceNoteBySize(749612,note)); // Never guess between recordings.
 entries.clear();assert(!findSavedVoiceNoteBySize(749612,note));
 recordingRoot={{"/recordings/20261018",0,true}};
 recordingDay={{"/recordings/20261018/u_new.wav",749612}};
 assert(findSavedVoiceNoteBySize(749612,note)&&note.audioPath=="/recordings/20261018/u_new.wav");
 entries={{"/voice/u_duplicate.wav",749612}};
 assert(!findSavedVoiceNoteBySize(749612,note)); // Refuse a duplicate across old and new storage.
 entries.clear();recordingRoot.clear();recordingDay.clear();
 assert(!findSavedVoiceNoteBySize(44,note));
 endless=true;now=0;assert(!findSavedVoiceNoteBySize(749612,note)&&now==5000);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-storage-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual history/recovery scans: finite wait, timer wrap, exact saved WAV, duplicate refusal and stalled directory')
