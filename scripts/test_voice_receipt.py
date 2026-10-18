#!/usr/bin/env python3
"""Run real voice response handling with injected HTTP/JSON boundary results."""
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
#include <map>
#include <vector>
#include <memory>
#include <deque>
#include <algorithm>
struct String:std::string {
 using std::string::string;String(const std::string& s):std::string(s){}
 String(int n):std::string(std::to_string(n)){}bool isEmpty()const{return empty();}
};
enum class UiMode{Home,Clock,ChatFull,ChatFace};UiMode gUiMode=UiMode::Home;
enum class VoiceRequestPhase{None,Recording,Sending,Processing,Accepted,Reply,Error};
VoiceRequestPhase gVoiceRequestPhase;
bool gVoiceNoticeVisible=true,gVoiceNoticePending=false,gLauncherVisible=false,gChatCommandsVisible=false;
bool gVoiceReplyPending=false,gAssistantPendingVisible=true;
unsigned gVoiceReplyNotifyUntilMs=0,gVoiceReplyAfterSeq=0,gInboxLastSeq=20,gVoiceReplyPendingMs=0;
unsigned gLastInboxAutoPollMs=0,gVoiceNoticeShownMs=0;
String gVoiceRequestTranscript,gVoiceNoticeText,gQueuedVoiceReplySpeech,gLastHttpDiag;
String userText,replyText;int errors=0,actions=0,tones=0;
unsigned millis(){return 1000;}void markUserActivity(){}void logf(const char*,...){}
bool gScreensaverActive=false,gScreensaverDimmed=false,gScreenOffActive=false,gCanvasSpriteActive=true;
unsigned gLastRenderMs=0;bool painted=false;void render(){painted=true;}
bool handleScreensaverWake(){return false;}
String cleanReplyForDevice(String s){return s;}void removeLastUtf8Char(String& s){s.pop_back();}
enum class FaceMode{Idle,Error};void setFaceMode(FaceMode){}
void pushError(String){++errors;}void pushSystem(String){}void pushUser(String s){userText=s;}
std::vector<String> history;unsigned cursorAtStorage=0;
void appendAssistantReply(String s){cursorAtStorage=gInboxLastSeq;replyText=s;history.push_back(s);}void setStatus(String,int){}
void setVoiceDiag(String){}void setHttpDiag(String s){gLastHttpDiag=s;}
void executeOrDeferDeviceActionsJson(String){++actions;}
struct {struct {void tone(int,int){assert(painted);++tones;}} Speaker;} M5Cardputer;
struct HTTPClient{static String errorToString(int){return "connection";}};
// Parsing is separately covered by bridge contract tests. Inject decoded values
// here so the actual firmware receipt handler must close every THINK path.
struct JsonObject{};void applyFirmwareJobState(String,String){}
struct Value {
 template<class T> bool is()const{return false;}
 Value operator[](const char*)const{return {};}
 String text;unsigned number=0;bool flag=false,missing=true;
 bool isNull()const{return missing;}
 Value operator|(Value b)const{return missing?b:*this;}
 String operator|(const char* fallback)const{return missing?String(fallback):text;}
 bool operator|(bool fallback)const{return missing?fallback:flag;}
 unsigned operator|(int fallback)const{return missing?unsigned(fallback):number;}
};
std::map<std::string,Value> decoded;bool badJson=false;
struct DynamicJsonDocument{DynamicJsonDocument(int){}Value operator[](const char* k){return decoded[k];}};
bool deserializeJson(DynamicJsonDocument&,const String&){return badJson;}
void serializeJson(Value,String& out){out="actions";}
'''
code += function('065_main.cpp.inc', 'void showVoiceNotice(')
code += 'std::deque<uint32_t> gStoredAssistantSeqs;\n'
code += function('065_main.cpp.inc', 'void rememberStoredAssistantSeq(')
code += function('065_main.cpp.inc', 'bool consumeStoredAssistantSeq(')
code += function('065_main.cpp.inc', 'void acceptPendingAssistantRequest(')
code += function('065_main.cpp.inc', 'void showVoiceRequestError(')
code += function('039_main.cpp.inc', 'bool finishVoiceSubmission(')
source = (parts / '003_main.cpp.inc').read_text()
start = source.index('struct TextTurnTaskResult {')
code += source[start:source.index('\n};', start)+3]
code += r'''
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
TextTurnTaskResult* gCompletedTextTurn=nullptr;
void* gTextTurnTaskHandle=nullptr;
bool gTextTurnAllocationFailed=false,gSubmitting=true,gThinking=true,gRecording=false,gPlaybackActive=false;
String gActiveTextTurn;
std::deque<String> gPendingTextTurns;
int tts=0,nextTurns=0;
void maybeStartNextTextTurn(){++nextTurns;gActiveTextTurn=gPendingTextTurns.front();gPendingTextTurns.pop_front();gSubmitting=gThinking=true;}
bool downloadAndPlayResponseAudio(String,String,String,unsigned,String,String){++tts;return true;}
bool shouldSpeakAssistantTextReply(String){return true;}
void requestAndPlayTts(String){++tts;}
'''
code += function('038_main.cpp.inc', 'void processCompletedTextTurn()')
code += r'''
void reset(){gStoredAssistantSeqs.clear();history.clear();gInboxLastSeq=20;decoded.clear();badJson=false;errors=actions=tones=0;painted=false;gVoiceRequestPhase=VoiceRequestPhase::Processing;
 gVoiceNoticeVisible=true;gVoiceReplyPending=false;gAssistantPendingVisible=true;
 gVoiceNoticeText="";gVoiceRequestTranscript="";gLastHttpDiag="";gQueuedVoiceReplySpeech="";replyText="";userText="";}
int main(){
 for(auto mode:{UiMode::Home,UiMode::Clock,UiMode::ChatFull,UiMode::ChatFace}){
  gUiMode=mode;reset();decoded["pending"]={"",0,true,false};
  decoded["transcript"]={"Change the battery",0,false,false};decoded["reply_seq"]={"",30,false,false};
  decoded["reply"]={"Request accepted. Firmware is building on the server.",0,false,false};
  assert(finishVoiceSubmission(true,202,"json","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Accepted&&gVoiceReplyPending&&!gAssistantPendingVisible);
  assert(tones==1&&gQueuedVoiceReplySpeech.empty()&&gInboxLastSeq==20&&gStoredAssistantSeqs.back()==30&&userText=="Change the battery");
  assert(gVoiceNoticeVisible==(mode==UiMode::Home||mode==UiMode::Clock));
  assert(history.size()==1&&replyText==decoded["reply"].text&&gVoiceNoticeText==replyText);
  assert(cursorAtStorage==20); // Persist first, then skip/ACK the duplicated inbox receipt.
  reset();decoded["reply"]={"Done",0,false,false};
  assert(finishVoiceSubmission(true,200,"json","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Reply&&!gVoiceReplyPending&&replyText=="Done"&&gQueuedVoiceReplySpeech=="Done");
  reset();assert(finishVoiceSubmission(true,200,"json","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Reply&&!gVoiceNoticeText.empty()); // Empty 2xx must end THINK.
  reset();badJson=true;assert(!finishVoiceSubmission(true,200,"broken","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Error&&errors==1);
  reset();assert(!finishVoiceSubmission(true,503,"unavailable","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Error&&!gVoiceReplyPending&&errors>0);
  assert(gVoiceNoticeText.find("HTTP 503")!=std::string::npos);
  reset();assert(!finishVoiceSubmission(true,502,"<html>Bad Gateway</html>","saved.wav",749568));
  assert(gVoiceNoticeText.find("HTTP 502")!=std::string::npos&&errors==1);
  reset();assert(!finishVoiceSubmission(false,-1,"","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Error&&!gVoiceReplyPending&&tones==0);
  assert(gVoiceNoticeText.find("No delivery receipt")!=std::string::npos);
  }
 // Text acceptance must also keep the body, end THINK and never speak an ACK.
 for(auto mode:{UiMode::Home,UiMode::Clock,UiMode::ChatFull,UiMode::ChatFace}) {
  reset();gUiMode=mode;tts=0;gActiveTextTurn="first";gSubmitting=gThinking=true;
  auto* accepted=new TextTurnTaskResult();accepted->ok=true;accepted->pending=true;
  accepted->reply="Accepted by the real firmware agent";accepted->replySeq=31;accepted->afterSeq=31;
  gCompletedTextTurn=accepted;processCompletedTextTurn();
  assert(!gSubmitting&&!gThinking&&gVoiceReplyPending&&tts==0&&history.size()==1);
  assert(replyText=="Accepted by the real firmware agent"&&cursorAtStorage==20&&gInboxLastSeq==20&&gStoredAssistantSeqs.back()==31);
  assert(gVoiceNoticeVisible==(mode==UiMode::Home||mode==UiMode::Clock));
  auto* final=new TextTurnTaskResult();final->ok=final->hasReply=true;final->reply="Published";final->replySeq=32;
  gCompletedTextTurn=final;processCompletedTextTurn();assert(replyText=="Published"&&tts==0&&gQueuedVoiceReplySpeech=="Published");
  assert(cursorAtStorage==20&&gInboxLastSeq==20&&gStoredAssistantSeqs.back()==32);
  auto* empty=new TextTurnTaskResult();empty->ok=true;gCompletedTextTurn=empty;
  gThinking=gSubmitting=true;processCompletedTextTurn();assert(!gSubmitting&&!gThinking);
  auto* error=new TextTurnTaskResult();error->error="HTTP 503";error->statusCode=503;
  gThinking=gSubmitting=true;gCompletedTextTurn=error;processCompletedTextTurn();assert(!gSubmitting&&!gThinking);
 }
 // A later HTTP receipt must not advance past an unseen earlier final.
 reset();acceptPendingAssistantRequest("second","Second accepted",30,30);
 assert(gInboxLastSeq==20&&consumeStoredAssistantSeq(30)&&!consumeStoredAssistantSeq(29));
 assert(!consumeStoredAssistantSeq(30));
 reset();gPendingTextTurns.push_back("second");gActiveTextTurn="first";
 auto* first=new TextTurnTaskResult();first->ok=first->pending=true;first->reply="First accepted";
 gCompletedTextTurn=first;processCompletedTextTurn();
 assert(gActiveTextTurn=="second"&&gSubmitting&&gThinking&&nextTurns==1&&replyText=="First accepted");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-receipt-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual voice receipt handler: pending ACK, reply, empty 2xx, invalid JSON, HTTP 503 and ambiguous transport failure on Home/chat')
