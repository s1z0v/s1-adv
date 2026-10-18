#!/usr/bin/env python3
"""Run the actual shared HTTP owner and queued-log completion boundaries."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'


def function(file, signature):
    s = (parts / file).read_text()
    start = s.index(signature)
    i, depth = s.index('{', start) + 1, 1
    while depth:
        depth += (s[i] == '{') - (s[i] == '}')
        i += 1
    return s[start:i]


code = r'''
#include <cassert>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>
struct String:std::string {
 using std::string::string;String(const std::string&s):std::string(s){}
 String(int n):std::string(std::to_string(n)){}
 bool isEmpty()const{return empty();}bool startsWith(const char*s)const{return rfind(s,0)==0;}
};
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
'''
state = (parts / '005_main.cpp.inc').read_text()
for name in ['InboxHttpPayload', 'InboxHttpResult']:
    start = state.index('struct ' + name)
    code += state[start:state.index(';\n', start) + 2] + '\n'
code += r'''
uint32_t now=100000,gLastInboxAutoPollMs=0,gInboxRetryAfterMs=0,gOtaLastAutoCheckMs=0,gPendingOtaActionAfterMs=0;
uint32_t millis(){return now;}
bool gInboxHttpBusy=false,gInboxCancelRequested=false,gInboxAllocationFailed=false;
bool gCanvasSpriteActive=true,gInboxCanvasReleased=false,gPendingLogsUpload=false,gLogsUploadBusy=false;
bool gRecording=false,gSubmitting=false,gPlaybackActive=false,gTransferUiActive=false;
bool gPendingOtaApplyAction=false,allowed=true,taskFails=false;
bool gWifiReady=true;int gInboxHttpMux=0,loanCount=0,restoreCount=0;
InboxHttpResult* gInboxHttpResult=nullptr;
std::deque<String>gInboxAckQueue;
String status,diag;
void logf(const char*,...){}void appendRuntimeLog(String,String,bool){}
void setStatus(String s,int){status=s;}void setHttpDiag(String s){diag=s;}
bool autoInboxPollAllowed(){return allowed;}
bool homeFirmwareUpdateAvailable(){return true;}
bool applyRemoteOtaManifestBody(String){return true;}
void applyInboxResponse(String,bool,bool,bool,bool){}
void prepareNetworkMemory(const char*,bool){}void clearEmojiCache(){}
bool tlsHandshakeNeedsCanvas(){return true;}
bool releaseUiCanvasForNetwork(const char*){++loanCount;gCanvasSpriteActive=false;return true;}
void restoreUiCanvasAfterNetwork(){++restoreCount;gCanvasSpriteActive=true;}
void inboxHttpTask(void*){}
constexpr int pdPASS=1;
void* pendingArg=nullptr;
int xTaskCreate(void(*)(void*),const char*,int,void*arg,int,void*){
 if(taskFails)return 0;assert(!pendingArg);pendingArg=arg;return pdPASS;
}
constexpr int WL_CONNECTED=3;
struct{int status(){return WL_CONNECTED;}}WiFi;
int responseCode=204,posts=0,getCount=0;String posted;
struct WiFiClientSecure{void setHandshakeTimeout(int seconds){assert(seconds>=6);}};
void configureSecureClient(WiFiClientSecure&){}
struct DynamicJsonDocument{DynamicJsonDocument(int){}String value;String& operator[](const char*){return value;}};
void serializeJson(DynamicJsonDocument&d,String&out){out=d.value;}
struct HTTPClient {
 void setConnectTimeout(int ms){assert(ms>=2500);}void setTimeout(int ms){assert(ms>=4000);}void setReuse(bool){}
 bool begin(WiFiClientSecure&,String){return true;}bool begin(String){return true;}
 void addHeader(const char*,String){}int POST(String body){++posts;posted=body;return responseCode;}
 int GET(){++getCount;return responseCode;}String getString(){return "{}";}void end(){}
};
'''
for signature in ['InboxHttpResult* performInboxHttpRequest(',
                  'bool startInboxNetworkRequest(', 'void serviceInboxNetworkCompletion()']:
    code += function('020_main.cpp.inc', signature) + '\n'
code += function('016_main.cpp.inc', 'bool uploadRuntimeLogs()') + '\n'
code += r'''
// Snapshot construction is compiled by the target build. Inject an immutable
// snapshot here and execute the actual worker, owner and completion logic.
bool startRuntimeLogsUpload(){
 auto p=std::make_unique<InboxHttpPayload>();p->url="https://bridge.invalid/api/cardputer/logs";
 p->token="fixture";p->body="immutable diagnostic snapshot";p->logsUpload=true;
 if(!startInboxNetworkRequest(std::move(p)))return false;gLogsUploadBusy=true;return true;
}
'''
code += function('016_main.cpp.inc', 'void servicePendingLogsUpload()') + r'''
void complete(){assert(pendingArg);auto*arg=pendingArg;pendingArg=nullptr;gInboxHttpResult=performInboxHttpRequest(arg);serviceInboxNetworkCompletion();}
int main(){
 // U is accepted once while a background worker owns TLS; it cannot overlap
 // that worker or falsely report delivery before the POST finishes.
 gInboxHttpBusy=true;assert(uploadRuntimeLogs());assert(uploadRuntimeLogs());
 assert(gPendingLogsUpload&&status=="Logs queued");servicePendingLogsUpload();assert(!pendingArg);
 gInboxHttpBusy=false;allowed=false;servicePendingLogsUpload();assert(!pendingArg);
 allowed=true;servicePendingLogsUpload();assert(pendingArg&&gInboxHttpBusy&&gLogsUploadBusy&&!gPendingLogsUpload);
 assert(uploadRuntimeLogs()&&!gPendingLogsUpload);assert(status!="Logs uploaded");
 assert(gCanvasSpriteActive&&loanCount==0);complete();
 assert(posts==1&&getCount==0&&posted=="immutable diagnostic snapshot");
 assert(status=="Logs uploaded"&&diag=="logs: ok"&&!gLogsUploadBusy&&!gInboxHttpBusy);
 assert(gCanvasSpriteActive&&loanCount==0&&restoreCount==0);
 // Failed upload leaves an explicit failure, never a fabricated receipt.
 responseCode=503;assert(uploadRuntimeLogs());servicePendingLogsUpload();complete();
 assert(status=="Logs HTTP 503"&&!gLogsUploadBusy&&!gInboxHttpBusy);
 // Failed task creation retains the request, backs off, and leaves the frame.
 now+=4000;taskFails=true;assert(uploadRuntimeLogs());servicePendingLogsUpload();
 assert(gPendingLogsUpload&&!gInboxHttpBusy&&gInboxRetryAfterMs==now+4000);
 assert(gCanvasSpriteActive&&loanCount==0);taskFails=false;
 servicePendingLogsUpload();assert(!pendingArg);now+=4000;servicePendingLogsUpload();
 responseCode=204;complete();assert(status=="Logs uploaded");
 // A failed durable event ACK stays queued. No UI/canvas work occurs in TLS.
 auto p=std::make_unique<InboxHttpPayload>();p->url="https://bridge.invalid/ack";p->eventId="event-one";
 gInboxAckQueue.push_back("event-one");responseCode=500;
 assert(startInboxNetworkRequest(std::move(p)));complete();assert(gInboxAckQueue.size()==1);
 assert(gCanvasSpriteActive&&loanCount==0);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-background-http-') as directory:
    p = Path(directory)
    (p / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(p / 'test.cpp'), '-o', str(p / 'test')], check=True)
    subprocess.run([str(p / 'test')], check=True)
print('PASS actual HTTP owner: queued U, one immutable POST, truthful completion, failure backoff, durable ACK and retained framebuffer')
