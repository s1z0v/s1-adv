#!/usr/bin/env python3
"""Compile actual launcher functions and PCM-to-meter wiring against host stubs."""
from pathlib import Path
import subprocess
import tempfile

root=Path(__file__).resolve().parents[1]
part=lambda n:(root/f'src/main_parts/{n:03}_main.cpp.inc').read_text()
def block(text, start):
    begin=text.index(start)
    opening=text.index('{',begin)
    depth=1
    end=opening+1
    while depth:
        depth += (text[end]=='{')-(text[end]=='}')
        end+=1
    return text[begin:end]

ui=part(59)
assert 'if (!realtime && now > 100000)' in ui
assert 'if (realtime) d.setFont(&fonts::Font4)' in ui
assert 'realtime ? 35' in ui
assert 'if (micRecording || realtime) {' in ui and '} else for (int i = 0; i < bars;' in ui
assert 'gMicInputMeter.visibleLevel(micRecording, nowMs)' in ui
assert 'mic_input_meter::draw' in ui
assert 'gMicInputMeter.reset()' in part(33) and 'gMicInputMeter.reset()' in part(42)
assert 'updateVoiceLevelFromSamples(gRealtimeInputBuffers[chunkIndex]' in part(41)
assert 'updateVoiceLevelFromSamples(gRecordChunkBuffers[chunkIndex]' in part(32)
assert 'C+1-7 open' in part(52)
assert 'mic_input_meter' not in part(40) # no binary transport work

declarations='\n'.join(block(part(n),start)+';' for n,start in [
    (2,'enum class UiMode'),(4,'struct LauncherSubItem'),(4,'struct LauncherGroup'),
    (4,'constexpr LauncherGroup kLauncherGroups')])
functions='\n'.join(block(part(24),start) for start in [
    'bool findLauncherEntryForMode(', 'void syncLauncherToMode(', 'void applyLauncherSelection('])
pcm=block(part(9),'void updateVoiceLevelFromSamples(')
source=f'''#include <cassert>
#include <cstdint>
#include <cstddef>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include "{root}/src/mic_input_meter.h"
using std::min;
constexpr uint8_t kLauncherGroupCount=7,kLauncherMaxSubItems=7;
constexpr uint16_t rgb565_local(int,int,int) {{ return 0; }}
{declarations}
int gLauncherSelection=0,gLauncherSubSelection=0,gLauncherLastSub[7]={{}};
bool gRealtimeActive=false,gRecording=false,gRealtimeRecording=false,allowStart=true;
bool gRealtimeScreenVisible=false,gPendingRealtimeStart=false,gRealtimeExclusiveMode=false;
int starts=0,closes=0,statuses=0; bool gMeshBusOwned=false; uint32_t clockMs=100;
uint8_t gVoiceLevel8=0; mic_input_meter::State gMicInputMeter;
uint32_t millis(){{return clockMs;}}
template<typename T>T clampValue(T x,T lo,T hi){{return std::max(lo,std::min(x,hi));}}
UiMode current=UiMode::Home;
void setUiMode(UiMode mode){{current=mode;}}
void setStatus(const char* message,int duration){{++statuses;assert(std::strcmp(message,"Esc exits Mesh for voice")==0 && duration==1600);}}
void closeRealtimeSession(const char*){{++closes;gRealtimeActive=false;}}
void cancelRecordingDiscard(){{gRecording=false;}}
void startRealtimeSession(bool listen){{assert(listen);++starts;gRealtimeActive=allowStart;}}
{functions}
{pcm}
int main() {{
 assert(kLauncherGroups[0].count==6 && kLauncherGroups[0].items[0].startRealtime);
 assert(kLauncherGroups[0].items[5].mode==UiMode::Hero);
 gMeshBusOwned=true;applyLauncherSelection();assert(starts==0 && closes==0 && statuses==1 && current==UiMode::Home);
 gMeshBusOwned=false;
 applyLauncherSelection();assert(starts==1 && closes==0 && gLauncherSubSelection==0);
 applyLauncherSelection();assert(starts==1 && closes==0 && current==UiMode::Face && gRealtimeScreenVisible);
 gLauncherSubSelection=1;applyLauncherSelection();assert(!gRealtimeActive && closes==1 && gLauncherSubSelection==1);
 gLauncherSubSelection=0;allowStart=false;applyLauncherSelection();assert(!gRealtimeActive && gLauncherSubSelection==1);
 for(int g=0;g<7;++g)for(int s=0;s<kLauncherGroups[g].count;++s){{
  const auto item=kLauncherGroups[g].items[s];if(item.startRealtime)continue;
  gRealtimeActive=true;gRealtimeScreenVisible=true;gPendingRealtimeStart=true;
  gLauncherSelection=g;gLauncherSubSelection=s;applyLauncherSelection();assert(current==item.mode);
  assert(!gRealtimeActive && !gRealtimeScreenVisible && !gPendingRealtimeStart);
 }}
 int16_t loud[720];std::fill(loud,loud+720,-32768);
 updateVoiceLevelFromSamples(loud,720);assert(!gMicInputMeter.seen); // speaker PCM ignored
 gRealtimeRecording=true;updateVoiceLevelFromSamples(loud,720);assert(gMicInputMeter.visibleLevel(true,100)>0);
 gRealtimeRecording=false;gMicInputMeter.reset();gRecording=true;
 updateVoiceLevelFromSamples(loud,720);assert(gMicInputMeter.visibleLevel(true,100)>0);
 int16_t quiet[720]={{}};for(int i=0;i<40;++i)updateVoiceLevelFromSamples(quiet,720);
 assert(gMicInputMeter.level==0);
 std::puts("PASS actual launcher open/reopen/failure/Pulse exit/all entries and real PCM mic-only wiring");
}}
'''
with tempfile.TemporaryDirectory(prefix='cardputer-ui-') as directory:
    cpp=Path(directory)/'test.cpp'; binary=Path(directory)/'test'
    cpp.write_text(source)
    subprocess.run(['c++','-std=c++11',str(cpp),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
