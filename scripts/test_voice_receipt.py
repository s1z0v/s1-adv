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
void appendAssistantReply(String s){replyText=s;}void setStatus(String,int){}
void setVoiceDiag(String){}void setHttpDiag(String s){gLastHttpDiag=s;}
void executeOrDeferDeviceActionsJson(String){++actions;}
struct {struct {void tone(int,int){assert(painted);++tones;}} Speaker;} M5Cardputer;
struct HTTPClient{static String errorToString(int){return "connection";}};
// Parsing is separately covered by bridge contract tests. Inject decoded values
// here so the actual firmware receipt handler must close every THINK path.
struct Value {
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
code += function('065_main.cpp.inc', 'void showVoiceRequestError(')
code += function('039_main.cpp.inc', 'bool finishVoiceSubmission(')
code += r'''
void reset(){decoded.clear();badJson=false;errors=actions=tones=0;painted=false;gVoiceRequestPhase=VoiceRequestPhase::Processing;
 gVoiceNoticeVisible=true;gVoiceReplyPending=false;gAssistantPendingVisible=true;
 gVoiceNoticeText="";gVoiceRequestTranscript="";gLastHttpDiag="";gQueuedVoiceReplySpeech="";replyText="";userText="";}
int main(){
 for(auto mode:{UiMode::Home,UiMode::Clock,UiMode::ChatFull,UiMode::ChatFace}){
  gUiMode=mode;reset();decoded["pending"]={"",0,true,false};
  decoded["transcript"]={"Change the battery",0,false,false};decoded["reply_seq"]={"",30,false,false};
  assert(finishVoiceSubmission(true,202,"json","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Accepted&&gVoiceReplyPending&&!gAssistantPendingVisible);
  assert(tones==1&&gQueuedVoiceReplySpeech.empty()&&gInboxLastSeq==30&&userText=="Change the battery");
  assert(gVoiceNoticeVisible==(mode==UiMode::Home||mode==UiMode::Clock));
  reset();decoded["reply"]={"Done",0,false,false};
  assert(finishVoiceSubmission(true,200,"json","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Reply&&!gVoiceReplyPending&&replyText=="Done"&&gQueuedVoiceReplySpeech=="Done");
  reset();assert(finishVoiceSubmission(true,200,"json","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Reply&&!gVoiceNoticeText.empty()); // Empty 2xx must end THINK.
  reset();badJson=true;assert(!finishVoiceSubmission(true,200,"broken","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Error&&errors==1);
  reset();assert(!finishVoiceSubmission(true,503,"unavailable","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Error&&!gVoiceReplyPending&&errors>0);
  reset();assert(!finishVoiceSubmission(false,-1,"","saved.wav",749568));
  assert(gVoiceRequestPhase==VoiceRequestPhase::Error&&!gVoiceReplyPending&&tones==0);
  assert(gVoiceNoticeText.find("No delivery receipt")!=std::string::npos);
 }
}
'''
with tempfile.TemporaryDirectory(prefix='s1-voice-receipt-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS actual voice receipt handler: pending ACK, reply, empty 2xx, invalid JSON, HTTP 503 and ambiguous transport failure on Home/chat')
