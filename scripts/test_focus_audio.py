#!/usr/bin/env python3
"""Exercise real language readiness, cue opt-out and selective playback stop."""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1];parts=root/'bots/CardputerADV/src/main_parts'
def fn(file,name):
 s=(parts/file).read_text();a=s.index(name);i=s.index('{',a)+1;n=1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include <cassert>
#include <cstdint>
#include <set>
#include <string>
#include <algorithm>
struct String:std::string{
 using std::string::string;String(const std::string&s):std::string(s){}
 void trim(){auto a=find_first_not_of(" \t");if(a==npos){clear();return;}*this=substr(a,find_last_not_of(" \t")-a+1);}
 void toLowerCase(){std::transform(begin(),end(),begin(),[](unsigned char c){return std::tolower(c);});}
};
namespace fs{struct FS{};}fs::FS disk;
std::set<std::string> files;bool mounted=true;
fs::FS* activeVoiceFs(){return mounted?&disk:nullptr;}
bool ensurePomodoroStorageOn(fs::FS&){return true;}
bool fsExists(fs::FS&,const String&p){return files.count(p)>0;}
const char* kPomodoroAudioLanguages[]={"ru","en","es"};constexpr size_t kPomodoroAudioLanguageCount=3;
const char* kPomodoroAudioCues[]={"start","break","reflection"};constexpr size_t kPomodoroAudioCueCount=3;
const char* kPomodoroAudioDir="/pomodoro/audio";
const char* kFocusCuePath="/legacy/start.wav";const char* kBreakCuePath="/legacy/break.wav";const char* kReflectionCuePath="/legacy/reflection.wav";
struct{String audioLanguage="en";}gDeviceSettings;
struct{bool guidedAudio=true;}gFocusSettings;
enum class FocusState{Stopped,Focus,ShortBreak,LongBreak,Reflect,Paused};
bool gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false,gRealtimeActive=false,gRealtimeExclusiveMode=false;
String gPlaybackStreamPath;int plays=0,stops=0;
bool startPlaybackStreamFromWavFile(const String&p,const String&){++plays;gPlaybackActive=true;gPlaybackStreamPath=p;return true;}
void stopPlaybackStream(){++stops;gPlaybackStreamPath="";}
const char* focusStateName(FocusState){return "focus";}
'''
for name in ['String normalizedPomodoroAudioLanguage(', 'String pomodoroMeditationAssetPath(', 'bool isPomodoroMeditationAssetPath(', 'bool pomodoroMeditationAssetsPresent()']:
 code+=fn('016_main.cpp.inc',name)+'\n'
code+=fn('027_main.cpp.inc','bool playFocusCue(')+'\n'+fn('028_main.cpp.inc','void toggleFocusGuidedAudio()')
code+=r'''
int main(){
 assert(!pomodoroMeditationAssetsPresent());
 for(auto c:kPomodoroAudioCues)files.insert(pomodoroMeditationAssetPath("en",c));
 assert(pomodoroMeditationAssetsPresent());assert(playFocusCue(FocusState::Focus));assert(plays==1);
 toggleFocusGuidedAudio();assert(!gFocusSettings.guidedAudio&&!gPlaybackActive&&stops==1);
 assert(!playFocusCue(FocusState::ShortBreak)&&plays==1);
 // Turning cues off never interrupts music or spoken assistant replies.
 toggleFocusGuidedAudio();gPlaybackActive=true;gPlaybackStreamPath="/music/song.wav";
 toggleFocusGuidedAudio();assert(gPlaybackActive&&stops==1);
 gPlaybackActive=false;toggleFocusGuidedAudio();
 // A three-file EN-only manifest is complete even if RU/ES was selected.
 for(auto lang:{"ru","es"}) {
  gDeviceSettings.audioLanguage=lang;
  assert(pomodoroMeditationAssetsPresent());
  for(auto phase:{FocusState::Focus,FocusState::ShortBreak,FocusState::Reflect}) {
   gPlaybackActive=false;assert(playFocusCue(phase));
   assert(gPlaybackStreamPath.find("/pomodoro/audio/en/")==0);
  }
 }
 // An existing selected RU cue wins over EN; switching to EN keeps EN.
 for(auto c:kPomodoroAudioCues)files.insert(pomodoroMeditationAssetPath("ru",c));
 gPlaybackActive=false;gDeviceSettings.audioLanguage="ru";
 assert(playFocusCue(FocusState::Reflect));assert(gPlaybackStreamPath=="/pomodoro/audio/ru/reflection.wav");
 gPlaybackActive=false;gDeviceSettings.audioLanguage="en";
 assert(playFocusCue(FocusState::Focus));assert(gPlaybackStreamPath=="/pomodoro/audio/en/start.wav");
 // Keep the old private-RU-only installation usable without rewriting it.
 for(auto c:kPomodoroAudioCues)files.erase(pomodoroMeditationAssetPath("en",c));
 assert(pomodoroMeditationAssetsPresent());gPlaybackActive=false;assert(playFocusCue(FocusState::Reflect));
 assert(gPlaybackStreamPath=="/pomodoro/audio/ru/reflection.wav");
 files.erase(pomodoroMeditationAssetPath("ru","start"));assert(!pomodoroMeditationAssetsPresent());
 mounted=false;assert(!pomodoroMeditationAssetsPresent());
}
'''
with tempfile.TemporaryDirectory(prefix='s1-focus-audio-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS actual Focus audio: EN-only readiness, optional RU, selected-language priority and private RU fallback, missing storage, opt-out and stopping only a guided cue')
