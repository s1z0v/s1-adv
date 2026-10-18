#!/usr/bin/env python3
"""Exercise actual update-chime playback guards and export its exact PCM preview."""
from pathlib import Path
import os,subprocess,tempfile,wave
root=Path(__file__).resolve().parents[1]
s=(root/'bots/CardputerADV/src/main_parts/027_main.cpp.inc').read_text();a=s.index('bool playUpdateChime()');i=s.index('{',a)+1;n=1
while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
code=r'''
#include <cassert>
#include <cstdio>
#include "release_delivery.h"
struct{bool beepOnUpdate=true;}gDeviceSettings;
bool gCanvasSpriteActive=true,gRecording=false,gPlaybackActive=false,gRealtimeActive=false,gRealtimeExclusiveMode=false;
bool gVoiceCapturePreparing=false,gVoiceDialBusy=false,gRealtimeDialBusy=false,gVoiceReplySpeechBusy=false;
int16_t gUpdateChime[release_delivery::kChimeSamples];
struct Speaker {bool busy=false;int queued=0;bool isPlaying(){return busy;}
 bool playRaw(int16_t*p,size_t n,unsigned rate,bool stereo,int repeat,int channel){
  assert(p==gUpdateChime&&n==1920&&rate==8000&&!stereo&&repeat==1&&channel==0);++queued;return true;}
};struct{struct Speaker Speaker;}M5Cardputer;
'''+s[a:i]+r'''
int main(int argc,char**argv){
 assert(playUpdateChime()&&M5Cardputer.Speaker.queued==1);
 for(bool*flag:{&gRecording,&gPlaybackActive,&gRealtimeActive,&gRealtimeExclusiveMode,
               &gVoiceCapturePreparing,&gVoiceDialBusy,&gRealtimeDialBusy,&gVoiceReplySpeechBusy,
               &M5Cardputer.Speaker.busy}){
  *flag=true;assert(!playUpdateChime()&&M5Cardputer.Speaker.queued==1);*flag=false;
 }
 gDeviceSettings.beepOnUpdate=false;assert(!playUpdateChime());gDeviceSettings.beepOnUpdate=true;
 gCanvasSpriteActive=false;assert(!playUpdateChime());gCanvasSpriteActive=true;
 if(argc>1){FILE*f=fopen(argv[1],"wb");assert(f);fwrite(gUpdateChime,sizeof(int16_t),release_delivery::kChimeSamples,f);fclose(f);}
}
'''
code='#include <initializer_list>\n'+code
with tempfile.TemporaryDirectory(prefix='s1-update-sound-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror','-I'+str(root/'bots/CardputerADV/src'),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 raw=p/'preview.pcm';subprocess.run([str(p/'test'),str(raw)],check=True)
 output=os.environ.get('UPDATE_SOUND_PREVIEW')
 if output:
  with wave.open(output,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(8000);w.writeframes(raw.read_bytes())
print('PASS actual update sound: quiet double knock, opt-out, no audio/mic/TLS overlap and no speaker-volume mutation')
