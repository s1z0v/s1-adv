#!/usr/bin/env python3
"""Exercise actual assistant navigation functions with a blocked network worker."""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
parts=root/'bots/CardputerADV/src/main_parts'
def function(file, signature):
    source=(parts/file).read_text()
    start=source.index(signature)
    brace=source.index('{',start); depth=1; end=brace+1
    while depth:
        depth+=(source[end]=='{')-(source[end]=='}'); end+=1
    return source[start:end]
code=r'''
#include <cassert>
#include <cstdint>
#include <deque>
#include <string>
#include <algorithm>
struct String:std::string {
 using std::string::string;
 String(const std::string& s):std::string(s){}
 String(size_t n):std::string(std::to_string(n)){}
 bool isEmpty() const {return empty();}
 void trim(){auto a=find_first_not_of(" \t\n\r"); if(a==npos){clear();return;} *this=substr(a,find_last_not_of(" \t\n\r")-a+1);}
};
enum class UiMode {Home,Clock,Face,Hero,ChatFull,ChatFace,Nes};
UiMode gUiMode=UiMode::Home;
String gInputBuffer,gActiveTextTurn,gStatusText,lastUser;
std::deque<String> gPendingTextTurns;
bool gAssistantPendingVisible=false,gSubmitting=false,gThinking=false;
void* gTextTurnTaskHandle=nullptr;
void* gCompletedTextTurn=nullptr;
bool gRealtimeDialBusy=false;
bool gInboxHttpBusy=false,gPendingRealtimeStart=false,gPendingRealtimeAutoStart=false;
bool gVoiceDialBusy=false,gVoiceReplySpeechBusy=false;
bool gChatCommandsVisible=false,gLauncherVisible=false,gRealtimeActive=false,gRealtimeExclusiveMode=false;
bool gRealtimeScreenVisible=false,gRealtimeConnected=false,gRealtimeRecording=false;
bool gRecording=false;
bool gVoiceNoticeVisible=false;
bool gRealtimePlaybackActive=false,gPlaybackActive=false,gRealtimeAwaiting=false;
String gRealtimeUiError;
struct Keyboard_Class {struct KeysState {bool ctrl=false,tab=false;};};
int launcherMoves=0;
void moveLauncherSubSelection(int){++launcherMoves;}
uint8_t gChatCommandSelection=0;
constexpr int kEyeSkinCount=6;
struct {uint8_t eyeSkin=0;} gDeviceSettings;
int started=0,closed=0,saved=0;
void cancelRecordingDiscard(){gRecording=false;}
void setUiMode(UiMode m){gUiMode=m;}
bool handleLocalCommand(const String& s){return s=="/local";}
void pushUser(const String& s){lastUser=s;}
void setStatus(const String& s,int=0){gStatusText=s;}
void maybeStartNextTextTurn(){if(!gInboxHttpBusy && !gTextTurnTaskHandle){++started;gTextTurnTaskHandle=(void*)1;}}
void startRealtimeSession(bool){++started;}
void toggleRealtimeVoice(){++started;}
void closeRealtimeSession(const char*){++closed;gRealtimeActive=false;gRealtimeExclusiveMode=false;}
void saveDeviceSettings(){++saved;}
const char* eyeSkinName(uint8_t){return "skin";}
void logf(const char*,...){}
void runChatCommand(uint8_t);
'''
code+=r'''
bool gPendingOtaCheckAction=false,gPendingOtaApplyAction=false,gInboxCancelRequested=false;
bool gG0VoicePending=false,gAlarmRinging=false,gDebugOverlayVisible=false,gTetrisHelpVisible=false;
bool gCtrlSoloHeld=false,gCtrlSoloCandidate=false;uint32_t gLastCtrlTapMs=0;
struct{bool helpVisible=false;}gFocus;String gQueuedVoiceReplySpeech,gNoteInputBuffer;
enum class NotesMode{List,Edit};NotesMode gNotesMode=NotesMode::List;
int gChatScrollOffset=0,gLogScrollOffset=0,gNoteScrollOffset=0,gNoteListScrollOffset=0;
bool handleVoiceRequestEscape(){return false;}void dismissVoiceNotice(){gVoiceNoticeVisible=false;}
void dismissAlarm(const char*){gAlarmRinging=false;}void stopPlaybackStream(){}
enum class FaceMode{Idle};void setFaceMode(FaceMode){}void setKeyDiag(const char*){}
void appendRuntimeLog(const char*,const char*,bool){}
'''
code+='\n'+function('047_main.cpp.inc','bool handleGlobalEscape()')
code+='\n'+function('064_main.cpp.inc','bool isAssistantUi()')
code+='\n'+function('064_main.cpp.inc','String makeRealtimeUpgradeRequest(')
code+='\n'+function('064_main.cpp.inc','bool handleAssistantMenuKey(')
code+='\n'+function('064_main.cpp.inc','const char* realtimeStageLabel()')
code+='\n'+function('064_main.cpp.inc','void servicePendingRealtimeStart()')
code+='\n'+function('064_main.cpp.inc','void runChatCommand(uint8_t index)')
code+='\n'+function('064_main.cpp.inc','bool handleEyeSkinKey(')
code+='\n'+function('044_main.cpp.inc','void submitInput()')
code+=r'''
int main(){
 String request=makeRealtimeUpgradeRequest("bridge.example.com",443,"/realtime","nonce","X-Device-Id: test");
 assert(request.find("Host: bridge.example.com\r\n")!=std::string::npos);
 assert(request.find("Host: bridge.example.com:443")==std::string::npos);
 assert(request.find("X-Device-Id: test\r\nUser-Agent:")!=std::string::npos);
 request=makeRealtimeUpgradeRequest("bridge.example.com",8443,"/realtime","nonce","");
 assert(request.find("Host: bridge.example.com:8443\r\n")!=std::string::npos);
 // The app launcher remains reachable from Home and while the mic is busy.
 Keyboard_Class::KeysState keys;keys.tab=true;
 assert(handleAssistantMenuKey('\t',keys) && gLauncherVisible && !gChatCommandsVisible);
 assert(handleAssistantMenuKey('\t',keys) && launcherMoves==1);
 keys.tab=false;keys.ctrl=true;
 assert(handleAssistantMenuKey('k',keys) && gChatCommandsVisible && !gLauncherVisible);
 assert(handleAssistantMenuKey('k',keys) && !gChatCommandsVisible);
 gUiMode=UiMode::Face;gRealtimeRecording=true;
 assert(handleAssistantMenuKey('k',keys) && gChatCommandsVisible);
 keys.tab=true;keys.ctrl=false;
 assert(handleAssistantMenuKey('\t',keys) && gLauncherVisible && !gChatCommandsVisible);
 keys.tab=false;keys.ctrl=true;
 assert(handleAssistantMenuKey('l',keys) && !gLauncherVisible);
 gUiMode=UiMode::Nes;assert(!handleAssistantMenuKey('k',keys));
 gUiMode=UiMode::Home;gRealtimeRecording=false;
 // Labels follow the actual transport/mic flags, including teardown errors.
 assert(std::string(realtimeStageLabel())=="OFF");
 gPendingRealtimeStart=true;assert(std::string(realtimeStageLabel())=="WAIT");
 gPendingRealtimeStart=false;gRealtimeActive=true;
 assert(std::string(realtimeStageLabel())=="CONNECT");
 gRealtimeConnected=true;assert(std::string(realtimeStageLabel())=="READY");
 gRealtimeRecording=true;assert(std::string(realtimeStageLabel())=="LISTEN");
 gRealtimeRecording=false;gRealtimeAwaiting=true;
 assert(std::string(realtimeStageLabel())=="THINK");
 gPlaybackActive=true;assert(std::string(realtimeStageLabel())=="SPEAK");
 gRealtimeUiError="TLS failure";gRealtimeActive=false;
 assert(std::string(realtimeStageLabel())=="ERROR");
 gRealtimeUiError="";gRealtimeConnected=false;gRealtimeAwaiting=false;gPlaybackActive=false;
 // A network worker can remain blocked for any duration; submit must still
 // change the visible mode, retain typed text and expose the pending bubble.
 gInboxHttpBusy=true;gInputBuffer="  hello  ";submitInput();
 assert(gUiMode==UiMode::ChatFull && gAssistantPendingVisible && gInputBuffer.empty());
 assert(lastUser=="hello" && gPendingTextTurns.front()=="hello" && started==0);
 gUiMode=UiMode::ChatFace;gInputBuffer="second";submitInput();
 assert(gUiMode==UiMode::ChatFace && gPendingTextTurns.size()==2);
 gRecording=true;gRealtimeScreenVisible=true;runChatCommand(3);
 assert(gUiMode==UiMode::Face && started==0 && !gRealtimeScreenVisible && !gRecording);
 gRealtimeActive=true;gRealtimeExclusiveMode=true;runChatCommand(2);
 assert(closed==1 && gUiMode==UiMode::ChatFace);
 runChatCommand(4);assert(gDeviceSettings.eyeSkin==5);
 runChatCommand(5);assert(gDeviceSettings.eyeSkin==0 && saved==2);
 // The literal keys printed in the command menu work on both eye screens,
 // including during a live microphone turn, without changing audio ownership.
 gUiMode=UiMode::Face;gLauncherVisible=false;gRealtimeActive=true;gRealtimeRecording=true;
 keys.ctrl=false;
 assert(handleEyeSkinKey(']',keys) && gDeviceSettings.eyeSkin==1);
 assert(handleEyeSkinKey('[',keys) && gDeviceSettings.eyeSkin==0);
 assert(gRealtimeActive && gRealtimeRecording);
 gUiMode=UiMode::ChatFace;assert(handleEyeSkinKey(']',keys));
 gUiMode=UiMode::ChatFull;assert(!handleEyeSkinKey('[',keys));
 keys.ctrl=true;assert(handleEyeSkinKey(',',keys));
 gLauncherVisible=true;assert(!handleEyeSkinKey(']',keys));gLauncherVisible=false;
 gRecording=true;assert(!handleEyeSkinKey(']',keys));gRecording=false;
 gUiMode=UiMode::Face;gVoiceNoticeVisible=true;
 assert(handleAssistantMenuKey('k',keys) && !gVoiceNoticeVisible);
 gRealtimeActive=false;gRealtimeRecording=false;gChatCommandsVisible=false;
 gPendingRealtimeStart=true;servicePendingRealtimeStart();assert(started==0);
 gInboxHttpBusy=false;gPendingTextTurns.clear();servicePendingRealtimeStart();
 assert(started==1 && !gPendingRealtimeStart);
 gPendingRealtimeStart=true;gUiMode=UiMode::Nes;servicePendingRealtimeStart();assert(started==1);
 // Escape and Ctrl+K still route while a poll/audio operation owns resources.
 gUiMode=UiMode::Home;gInboxHttpBusy=true;gPlaybackActive=true;gChatCommandsVisible=false;
 assert(handleAssistantMenuKey('k',keys)&&gChatCommandsVisible);
 handleGlobalEscape();assert(!gChatCommandsVisible);
 gUiMode=UiMode::Face;gLauncherVisible=true;gG0VoicePending=true;
 handleGlobalEscape();assert(gUiMode==UiMode::Home&&!gLauncherVisible&&!gPlaybackActive&&!gG0VoicePending);
 assert(gInboxHttpBusy); // input never destroys another task's transport.

}
'''
out=Path(tempfile.mkdtemp(prefix='s1-assistant-'))
(out/'test.cpp').write_text(code)
subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(out/'test.cpp'),'-o',str(out/'test')],check=True)
subprocess.run([str(out/'test')],check=True)
# Worker source contracts catch accidentally reintroducing UI mutation or
# FreeRTOS deletion before C++ TLS destructors have run.
for file,name in [('037_main.cpp.inc','TextTurnTaskResult* performTextTurnRequest'),
                  ('020_main.cpp.inc','InboxHttpResult* performInboxHttpRequest')]:
    worker=function(file,name)
    for banned in ['releaseUiCanvasForNetwork','restoreUiCanvasAfterNetwork','prepareNetworkMemory',
                   'ensureWifiForHttp','setUiMode','setStatus','logf(','vTaskDelete']:
        assert banned not in worker,(name,banned)
poll=function('020_main.cpp.inc','void serviceAutoInboxPoll()')
assert 'fetchLatestInboxMessage' not in poll and 'startInboxNetworkRequest' in poll
assert 'xTaskCreate(inboxHttpTask' in function('020_main.cpp.inc','bool startInboxNetworkRequest(')
assert 'ensureWifiForHttp' not in function('043_main.cpp.inc','void maintainConnectivity()')
typing=(parts/'048_main.cpp.inc').read_text()
assert typing.index('handleVoiceNoticeKey(key, keys)') < typing.index('handleAssistantMenuKey(key,keys)')
assert typing.index('handleEyeSkinKey(key,keys)') < typing.index('if (gRealtimeRecording')
assert 'if (gRecording)' not in typing[typing.index('void pollTyping()'):]
print('PASS actual submit/navigation: pending inbox, immediate chat, queue, six skins, Realtime gating; worker UI ownership')
