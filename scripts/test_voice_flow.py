#!/usr/bin/env python3
"""Exercise the actual render dispatcher through capture, receipt and chat."""
from pathlib import Path
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'


def function(source, signature):
    start = source.index(signature)
    brace = source.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


render = function((parts / '060_main.cpp.inc').read_text() + (parts / '061_main.cpp.inc').read_text(), 'void render()')
notice = (parts / '065_main.cpp.inc').read_text()
modes = sorted(set(re.findall(r'UiMode::(\w+)', render)) | {'Other'})
renderers = set(re.findall(r'\b(render\w+)\(\)', render)) - {'render', 'renderAssistantPulseUi', 'renderVoiceNotice', 'renderChatUi'}
code = r'''
#include <cassert>
#include <string>
#include <vector>
#include <cstdint>
struct String:std::string {using std::string::string;String(const std::string& s):std::string(s){};};
enum class AssistantPulseState{Realtime,Recording,Thinking,Playback,Ready};
enum class VoiceRequestPhase{None,Recording,Sending,Processing,Accepted,Reply,Error};
VoiceRequestPhase gVoiceRequestPhase=VoiceRequestPhase::None;
bool gVoiceNoticeVisible=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gRealtimeActive=false,gRealtimeRecording=false,gRealtimeAwaiting=false;
bool gCanvasSpriteActive=true,gSetupPortalActive=false,gVoiceNoticePending=false;
bool gLauncherVisible=false,gChatCommandsVisible=false;
String gStatusText,gVoiceNoticeText,gVoiceRequestTranscript;
unsigned gStatusUntilMs=0,gLastUiSlowLogMs=0,gVoiceNoticeShownMs=0,gVoiceRequestProgress=0;
unsigned millis(){return 1000;}void logf(const char*,...){}void markUserActivity(){}
String cleanReplyForDevice(String s){return s;}void removeLastUtf8Char(String& s){s.pop_back();}
struct {void pushSprite(int,int){}} gCanvas;
std::vector<std::string> trace;
'''
code += 'enum class UiMode {' + ','.join(modes) + '};UiMode gUiMode=UiMode::Home;\n'
code += function((parts / '064_main.cpp.inc').read_text(), 'bool isAssistantUi()')
code += function(notice, 'bool voiceRequestBusyUi()')
code += function(notice, 'void beginVoiceRequestUi()')
code += function(notice, 'void showVoiceNotice(')
code += function((parts / '009_main.cpp.inc').read_text(), 'AssistantPulseState assistantPulseState()')
code += r'''
void renderAssistantPulseUi(){switch(assistantPulseState()){
 case AssistantPulseState::Recording:trace.push_back("REC");break;
 case AssistantPulseState::Thinking:trace.push_back("THINK");break;
 case AssistantPulseState::Ready:trace.push_back("READY");break;
 default:trace.push_back("OTHER");}}
void renderChatUi(){trace.push_back("CHAT");}
void renderVoiceNotice(){if(gVoiceNoticeVisible&&!voiceRequestBusyUi())trace.push_back(gVoiceNoticePending?"ACCEPTED":"REPLY");}
'''
for renderer in sorted(renderers):
    code += f'void {renderer}(){{}}\n'
code += render
code += r'''
void expect(std::initializer_list<std::string> expected){trace.clear();render();assert(trace==std::vector<std::string>(expected));}
int main(){
 for(auto mode:{UiMode::Home,UiMode::ChatFull,UiMode::ChatFace}){
  gUiMode=mode;beginVoiceRequestUi();gRecording=true;expect({"REC"});
  gRecording=false;gVoiceRequestPhase=VoiceRequestPhase::Sending;
  expect({"THINK"}); // SD finalization precedes the submitting flag: no READY flash.
  gSubmitting=gThinking=true;expect({"THINK"});
  gVoiceRequestPhase=VoiceRequestPhase::Processing;expect({"THINK"});
  gSubmitting=gThinking=false;expect({"THINK"}); // Await a real receipt.
  showVoiceNotice("Please change the firmware",true);
  if(mode==UiMode::Home)expect({"READY","ACCEPTED"});else expect({"CHAT"});
  assert(gUiMode==mode); // Neither receipt nor reply jumps to a different app.
  showVoiceNotice("The agent replied",false);
  if(mode==UiMode::Home)expect({"READY","REPLY"});else expect({"CHAT"});
 }
 gUiMode=UiMode::Home;beginVoiceRequestUi();gRealtimeActive=true;
 assert(!voiceRequestBusyUi()); // Realtime retains its own rendering path.
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-flow-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual render dispatcher: original REC / THINK, no READY flash, receipt ends THINK, Home card and inline chat')
