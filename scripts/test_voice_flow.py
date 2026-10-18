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
renderers = set(re.findall(r'\b(render\w+)\(\)', render)) - {'render', 'renderAssistantPulseUi', 'renderVoiceNotice', 'renderChatUi', 'renderClockUi'}
code = r'''
#include <cassert>
#include <string>
#include <vector>
#include <cstdint>
#include <algorithm>
using std::min;using std::max;
struct String:std::string {using std::string::string;String(const std::string& s):std::string(s){};};
enum class AssistantPulseState{Realtime,Recording,Thinking,Playback,Ready};
enum class VoiceRequestPhase{None,Recording,Sending,Processing,Accepted,Reply,Error};
VoiceRequestPhase gVoiceRequestPhase=VoiceRequestPhase::None;
bool gVoiceNoticeVisible=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gRealtimeActive=false,gRealtimeRecording=false,gRealtimeAwaiting=false;
bool gRealtimeScreenVisible=false;
struct UiFrameTrace{};void presentUiFrame(){}
struct{bool needsFullFrame(bool,unsigned,bool){return true;}void invalidate(){}}gUiFramePolicy;
unsigned uiSceneKey(){return 0;}bool gUiInputPending=false;
bool gCanvasSpriteActive=true,gSetupPortalActive=false,gVoiceNoticePending=false;
bool gLauncherVisible=false,gChatCommandsVisible=false;
bool gVoiceReplySpeechBusy=false,gTransferUiActive=false,gOtaApplyInProgress=false,gPendingRestart=false;
int speakerPlaying=0;struct {struct {int isPlaying(){return speakerPlaying;}} Speaker;} M5Cardputer;
String gStatusText,gVoiceNoticeText,gVoiceRequestTranscript;
unsigned gStatusUntilMs=0,gLastUiSlowLogMs=0,gVoiceNoticeShownMs=0,gVoiceRequestProgress=0;
unsigned millis(){return 1000;}void logf(const char*,...){}void markUserActivity(){}
String cleanReplyForDevice(String s){return s;}void removeLastUtf8Char(String& s){s.pop_back();}
std::vector<std::string> trace;
bool gScreensaverActive=false,gScreensaverDimmed=false,gScreenOffActive=false;
unsigned gLastRenderMs=0;void render();bool handleScreensaverWake(){gScreensaverActive=gScreensaverDimmed=gScreenOffActive=false;return true;}
namespace fonts {int Font0,Font2,efontCN_12;}
constexpr uint16_t TFT_WHITE=0xffff;
uint16_t rgb565_local(int r,int g,int b){return uint16_t(r+g+b);}
int cardLines=1;std::vector<String> cardText;
std::vector<String> wrapText(String text,int){return std::vector<String>(cardLines,text);}
String fitCurrentFontToWidth(String text,int){return text;}
struct {
 int panelY=0,panelH=0,cursorY=0;const int* font=nullptr;int pushed=0;
 void pushSprite(int,int){++pushed;}
 void fillRoundRect(int,int y,int w,int h,int,uint16_t){assert(y>=0&&y+h<=135&&w<=240);panelY=y;panelH=h;}
 void drawRoundRect(int,int,int,int,int,uint16_t){}
 void setFont(const int* f){font=f;}void setTextColor(uint16_t,uint16_t){}
 void setCursor(int,int y){cursorY=y;}
 void print(String s){
  assert(cursorY>=panelY&&cursorY+(font==&fonts::Font2?16:font==&fonts::Font0?8:12)<=panelY+panelH);
  if(s=="Request accepted")trace.push_back("ACCEPTED");else if(s=="AI Agent")trace.push_back("REPLY");
  cardText.push_back(s);
 }
} gCanvas;
'''
code += 'enum class UiMode {' + ','.join(modes) + '};UiMode gUiMode=UiMode::Home;\n'
code += function((parts / '064_main.cpp.inc').read_text(), 'bool isAssistantUi()')
code += function(notice, 'bool voiceRequestBusyUi()')
code += function(notice, 'void beginVoiceRequestUi()')
code += function(notice, 'void showVoiceNotice(')
code += function(notice, 'bool voiceReplyFeedbackReady()')
code += function((parts / '009_main.cpp.inc').read_text(), 'AssistantPulseState assistantPulseState()')
code += function((parts / '009_main.cpp.inc').read_text(), 'bool screensaverMayRun()')
code += r'''
void renderAssistantPulseUi(){switch(assistantPulseState()){
 case AssistantPulseState::Recording:trace.push_back("REC");break;
 case AssistantPulseState::Thinking:trace.push_back("THINK");break;
 case AssistantPulseState::Ready:trace.push_back("READY");break;
 default:trace.push_back("OTHER");}}
void renderChatUi(){trace.push_back("CHAT");}
'''
code += function(notice, 'void renderVoiceNotice()')
code += function((parts / '059_main.cpp.inc').read_text(), 'void renderClockUi()')
for renderer in sorted(renderers):
    code += f'void {renderer}(){{}}\n'
code += render
code += r'''
void expect(std::initializer_list<std::string> expected){trace.clear();render();assert(trace==std::vector<std::string>(expected));}
int main(){
 for(auto mode:{UiMode::Home,UiMode::Clock,UiMode::ChatFull,UiMode::ChatFace}){
  gUiMode=mode;beginVoiceRequestUi();gRecording=true;expect({"REC"});
  gRecording=false;gVoiceRequestPhase=VoiceRequestPhase::Sending;
  expect({"THINK"}); // SD finalization precedes the submitting flag: no READY flash.
  gSubmitting=gThinking=true;expect({"THINK"});
  gVoiceRequestPhase=VoiceRequestPhase::Processing;expect({"THINK"});
  gSubmitting=gThinking=false;expect({"THINK"}); // Await a real receipt.
  showVoiceNotice("Please change the firmware",true);
  if(mode==UiMode::Home||mode==UiMode::Clock)expect({"READY","ACCEPTED"});else expect({"CHAT"});
  assert(gUiMode==mode); // Neither receipt nor reply jumps to a different app.
  showVoiceNotice("The agent replied",false);
  if(mode==UiMode::Home||mode==UiMode::Clock)expect({"READY","REPLY"});else expect({"CHAT"});
 }
 gUiMode=UiMode::Clock;cardLines=8;gScreensaverActive=true;
 showVoiceNotice("It’s 4:52 PM in Bali.",false);
 assert(!gScreensaverActive&&gCanvas.panelY==4&&gCanvas.panelH==122);
 expect({"READY","REPLY"}); // Real card is fully visible in its FIRST frame.
 assert(cardText.back()=="Enter read more   Esc OK");
 assert(voiceReplyFeedbackReady());speakerPlaying=1;assert(!voiceReplyFeedbackReady());speakerPlaying=0;
 gCanvasSpriteActive=false;assert(!voiceReplyFeedbackReady());
 // Even with the sprite loaned to TLS, the real dispatcher must render Home,
 // the clock, and chat immediately. This used to return before drawing.
 for(auto mode:{UiMode::Home,UiMode::Clock,UiMode::ChatFull,UiMode::ChatFace}) {
  gUiMode=mode;showVoiceNotice("Background poll stays responsive",false);
  if(mode==UiMode::Home||mode==UiMode::Clock)expect({"READY","REPLY"});else expect({"CHAT"});
 }
 gCanvasSpriteActive=true;gUiMode=UiMode::Home;showVoiceNotice("Unread reply",false);
 assert(!screensaverMayRun()); // Unread feedback must not disappear into a saver.
 gVoiceNoticeVisible=false;assert(screensaverMayRun());
 gVoiceReplySpeechBusy=true;assert(!screensaverMayRun());gVoiceReplySpeechBusy=false;
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
print('PASS actual dispatcher AND card: Home/Clock, first-frame visibility, bounds, wake, REC/THINK, receipt and inline chat')
