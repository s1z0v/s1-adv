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
enum class UiMode {Home,Face,Hero,ChatFull,ChatFace,Nes};
UiMode gUiMode=UiMode::Home;
String gInputBuffer,gActiveTextTurn,gStatusText,lastUser;
std::deque<String> gPendingTextTurns;
bool gAssistantPendingVisible=false,gSubmitting=false,gThinking=false;
void* gTextTurnTaskHandle=nullptr;
void* gCompletedTextTurn=nullptr;
bool gInboxHttpBusy=false,gPendingRealtimeStart=false,gPendingRealtimeAutoStart=false;
bool gChatCommandsVisible=false,gLauncherVisible=false,gRealtimeActive=false,gRealtimeExclusiveMode=false;
uint8_t gChatCommandSelection=0;
constexpr int kEyeSkinCount=6;
struct {uint8_t eyeSkin=0;} gDeviceSettings;
int started=0,closed=0,saved=0;
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
'''
code+='\n'+function('064_main.cpp.inc','bool isAssistantUi()')
code+='\n'+function('064_main.cpp.inc','void servicePendingRealtimeStart()')
code+='\n'+function('064_main.cpp.inc','void runChatCommand(uint8_t index)')
code+='\n'+function('044_main.cpp.inc','void submitInput()')
code+=r'''
int main(){
 // A network worker can remain blocked for any duration; submit must still
 // change the visible mode, retain typed text and expose the pending bubble.
 gInboxHttpBusy=true;gInputBuffer="  hello  ";submitInput();
 assert(gUiMode==UiMode::ChatFull && gAssistantPendingVisible && gInputBuffer.empty());
 assert(lastUser=="hello" && gPendingTextTurns.front()=="hello" && started==0);
 gUiMode=UiMode::ChatFace;gInputBuffer="second";submitInput();
 assert(gUiMode==UiMode::ChatFace && gPendingTextTurns.size()==2);
 runChatCommand(3);assert(gUiMode==UiMode::Face && started==0);
 gRealtimeActive=true;gRealtimeExclusiveMode=true;runChatCommand(2);
 assert(closed==1 && gUiMode==UiMode::ChatFace);
 runChatCommand(4);assert(gDeviceSettings.eyeSkin==5);
 runChatCommand(5);assert(gDeviceSettings.eyeSkin==0 && saved==2);
 gPendingRealtimeStart=true;servicePendingRealtimeStart();assert(started==0);
 gInboxHttpBusy=false;gPendingTextTurns.clear();servicePendingRealtimeStart();
 assert(started==1 && !gPendingRealtimeStart);
 gPendingRealtimeStart=true;gUiMode=UiMode::Nes;servicePendingRealtimeStart();assert(started==1);
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
assert 'fetchLatestInboxMessage' not in poll and 'xTaskCreate(inboxHttpTask' in poll
assert 'ensureWifiForHttp' not in function('043_main.cpp.inc','void maintainConnectivity()')
print('PASS actual submit/navigation: pending inbox, immediate chat, queue, six skins, Realtime gating; worker UI ownership')
