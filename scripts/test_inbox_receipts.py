#!/usr/bin/env python3
"""Execute real inbox handling with decoded JSON fixtures and urgent reordering."""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
parts=root/'bots/CardputerADV/src/main_parts'
def function(file,signature):
 s=(parts/file).read_text();a=s.index(signature);i=s.index('{',a)+1;n=1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include <cassert>
#include <algorithm>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include <type_traits>
struct String:std::string {using std::string::string;String(const std::string&s):std::string(s){}String(unsigned n):std::string(std::to_string(n)){}bool isEmpty()const{return empty();}};
struct Value;
struct JsonObject {std::shared_ptr<std::map<std::string,Value>> data;JsonObject();Value operator[](const char*)const;};
struct JsonArray {std::vector<JsonObject> data;auto begin(){return data.begin();}auto end(){return data.end();}};
struct Value {int kind=0;String text;unsigned number=0;JsonObject object;JsonArray array;
 Value():object(nullptr){} // Child objects remain lazy to avoid recursive allocation.
 Value(const char*s):kind(1),text(s),object(nullptr){}Value(unsigned n):kind(2),number(n),object(nullptr){}
 Value(JsonObject o):kind(3),object(o){}Value(JsonArray a):kind(4),object(nullptr),array(a){}
 template<class T>bool is()const{return std::is_same_v<T,JsonObject>?kind==3:kind==4;}
 template<class T>T as()const{if constexpr(std::is_same_v<T,JsonObject>)return object;else return array;}
 Value operator|(Value b)const{return kind?*this:b;}
 String operator|(const char*s)const{return kind?text:String(s);}
 unsigned operator|(int n)const{return kind?number:unsigned(n);}
 Value operator[](const char*k)const{return object[k];}
};
'''
# The null constructor must be declared before Value uses it.
code=code.replace('JsonObject();Value operator[]','JsonObject();JsonObject(std::nullptr_t):data(nullptr){}Value operator[]')
code+=r'''
JsonObject::JsonObject():data(std::make_shared<std::map<std::string,Value>>()){}
Value JsonObject::operator[](const char*k)const {if(!data)return {};auto i=data->find(k);return i==data->end()?Value():i->second;}
void set(JsonObject o,const char*k,Value v){(*o.data)[k]=v;}
JsonObject decoded;
struct DynamicJsonDocument {JsonObject root;DynamicJsonDocument(int){}Value operator[](const char*k){return root[k];}void clear(){}};
struct ParseError{operator bool()const{return false;}const char*c_str(){return "";}};
ParseError deserializeJson(DynamicJsonDocument&d,const String&){d.root=decoded;return {};}
enum class UiMode{Home,ChatFull,ChatFace};UiMode gUiMode=UiMode::Home;
enum class LineKind{Assistant,User};
bool gVoiceReplyPending=true,gAssistantPendingVisible=false,gSubmitting=false,gThinking=false,gInboxUnread=false;
bool gInboxLastFromAssistant=false,gVoiceNoticeVisible=true;
unsigned gVoiceReplyAfterSeq=30,gInboxLastSeq=20,gInboxLastVoiceSize=0,gVoiceReplyNotifyUntilMs=10000;
String gInboxLastText,gInboxLastKind,gInboxLastSender,gInboxLastVoiceUrl,gInboxLastVoiceTitle,gInboxLastVoiceSha256;
String gQueuedVoiceReplySpeech,gHubHost="bridge.invalid",jobState;
std::deque<String>gInboxAckQueue;std::deque<uint32_t>gStoredAssistantSeqs;
std::vector<String>stored;
void logf(const char*,...){}void setStatus(String,int){}void appendRuntimeLog(String,String,bool){}
String cleanReplyForDevice(String s){return s;}
void pushLine(String,String s,LineKind){stored.push_back(s);}
void pushVoiceHistoryLine(String,String s,LineKind,String,String,String,unsigned){stored.push_back(s);}
unsigned millis(){return 1000;}void showVoiceNotice(String,bool){}bool playLastInboxMessage(){return false;}
bool executeInlineDeviceActionsFromText(String){return false;}
void applyFirmwareJobState(String s,String){jobState=s;}
struct{struct{void tone(int,int){}}Speaker;}M5Cardputer;
'''
for f,s in [('065_main.cpp.inc','void rememberStoredAssistantSeq('),('065_main.cpp.inc','bool consumeStoredAssistantSeq('),('020_main.cpp.inc','bool handleInboxHistoryItem('),('020_main.cpp.inc','bool ackDeviceEvent('),('020_main.cpp.inc','bool applyInboxResponse(')]:code+=function(f,s)+'\n'
code+=r'''
JsonObject event(const char*id,unsigned seq,const char*text){
 JsonObject sender,content,message,event;
 set(sender,"kind","assistant");set(sender,"display_name","Agent");set(content,"kind","text");set(content,"text",text);
 set(message,"seq",seq);set(message,"sender",sender);set(message,"content",content);
 set(event,"event_id",id);set(event,"message",message);return event;
}
bool poll(std::initializer_list<JsonObject>items){decoded=JsonObject();JsonArray array;array.data=items;set(decoded,"items",array);String body="decoded JSON";return applyInboxResponse(body,false,false,true,true);}
int main(){
 stored.push_back("Second request accepted");rememberStoredAssistantSeq(30);
 assert(gInboxLastSeq==20);
 // An urgent OTA event can precede a still-unseen final from an older job.
 assert(poll({event("urgent",50,"Urgent OTA notice")}));assert(gInboxLastSeq==50);
 assert(poll({event("older-final",29,"First job final"),event("receipt",30,"Second request accepted")}));
 assert(gInboxLastSeq==50&&stored.back()=="First job final");
 assert(!poll({event("older-final",29,"First job final"),event("receipt",30,"Second request accepted")}));
 assert(stored.size()==3&&gStoredAssistantSeqs.empty()&&gInboxAckQueue.size()==3);
 assert(!poll({event("receipt",30,"Second request accepted")}));assert(stored.size()==3);
 assert(poll({event("new-final",51,"Second job final")}));assert(gInboxLastSeq==51&&stored.size()==4);
 // Status sync is delivered even when there is no new chat item.
 decoded=JsonObject();set(decoded,"items",JsonArray{});JsonObject job;set(job,"state","building");set(job,"request_id","two");set(decoded,"firmware_job",job);
 String body="decoded JSON";assert(!applyInboxResponse(body,false,false,true,true));assert(jobState=="building");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-inbox-receipts-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS actual inbox: receipt replay ACK, older final after urgent OTA, monotonic watermark, queued ACK dedupe and status-only poll')
