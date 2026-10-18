#!/usr/bin/env python3
"""Execute the real shared-worker scheduler with a deterministic clock and transport."""
from pathlib import Path
import os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
parts=root/'bots/CardputerADV/src/main_parts'
def function(file,signature):
 s=(parts/file).read_text();a=s.index(signature);i=s.index('{',a)+1;depth=1
 while depth:
  depth+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include <cassert>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>
struct String:std::string {using std::string::string;String(const std::string&s):std::string(s){}bool isEmpty()const{return empty();}};
enum class UiMode{Home,ChatFace,Face,Hero,ChatFull,Ota,Clock};UiMode gUiMode=UiMode::Home;
bool gWifiReady=true,gOtaApplyInProgress=false,gTransferUiActive=false,gLauncherVisible=false;
bool gG0VoicePending=false;
bool gBootBackgroundActive=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gVoiceReplySpeechBusy=false,gVoiceDialBusy=false,gRealtimeDialBusy=false,gPendingRealtimeStart=false;
bool gRealtimeActive=false,gRealtimeConnected=false,gRealtimeRecording=false,gRealtimeAwaiting=false;
bool gRealtimeSmokeActive=false,gRealtimeSmokeAudioStreaming=false;
void* gTextTurnTaskHandle=nullptr;void* gCompletedTextTurn=nullptr;
String gActiveTextTurn,gInputBuffer,gDeviceToken="private-in-memory",gHubHost="bridge.invalid";
std::deque<String> gPendingTextTurns,gInboxAckQueue;
uint32_t now=30000,gOtaLastAutoCheckMs=0,gLastUserActivityMs=0,gLastInboxAutoPollMs=0,gInboxRetryAfterMs=0;
constexpr uint32_t kOtaAutoCheckIntervalMs=20000,kInboxAutoPollIntervalMs=15000;
constexpr const char* kFirmwareManifestFetchPath="/api/cardputer/firmware/manifest";
constexpr const char* kAppVersion="0.2.167-dev";constexpr const char* kBuildGitSha="test";
bool gInboxHttpBusy=false,gVoiceReplyPending=false,gPendingOtaCheckAction=false,gPendingOtaApplyAction=false;
uint32_t gVoiceReplyPendingMs=0;
uint32_t millis(){return now;}void logf(const char*,...){}
String hubBaseUrl(){return "https://bridge.invalid";}
struct InboxHttpPayload {String url,token,eventId;bool otaManifest=false,applyAfter=false,announce=false;};
std::vector<InboxHttpPayload> dispatched;std::vector<uint32_t> manifestTimes;
bool startInboxNetworkRequest(std::unique_ptr<InboxHttpPayload> p){assert(!gInboxHttpBusy);gInboxHttpBusy=true;
 if(p->otaManifest)manifestTimes.push_back(now);dispatched.push_back(*p);gLastInboxAutoPollMs=now;return true;}
void finish(){gInboxHttpBusy=false;}
'''
for file,signature in [('020_main.cpp.inc','bool autoInboxPollAllowed()'),('020_main.cpp.inc','bool startBackgroundManifestCheck('),('020_main.cpp.inc','void serviceAutoInboxPoll()')]:code+=function(file,signature)+'\n'
code+=r'''
int main(){
 serviceAutoInboxPoll();assert(dispatched.back().otaManifest);finish();
 for(uint32_t t=30001;t<=90000;++t){now=t;serviceAutoInboxPoll();finish();}
 assert((manifestTimes==std::vector<uint32_t>{30000,50000,70000,90000}));
 assert(dispatched.front().url=="https://bridge.invalid/api/cardputer/firmware/manifest");
 // Due checks stay due while recording/transport/audio/UI work owns resources.
 now=110000;
 for(bool* busy:{&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gVoiceReplySpeechBusy,&gVoiceDialBusy,
    &gRealtimeDialBusy,&gRealtimeActive,&gOtaApplyInProgress,&gTransferUiActive,&gInboxHttpBusy,&gBootBackgroundActive,&gG0VoicePending}){
  *busy=true;auto n=dispatched.size();serviceAutoInboxPoll();assert(dispatched.size()==n);*busy=false;}
 serviceAutoInboxPoll();assert(manifestTimes.back()==110000);finish();
 // A failed attempt cannot spin; next due GET is 20 seconds after dispatch.
 now=110001;gInboxRetryAfterMs=114000;serviceAutoInboxPoll();assert(!gInboxHttpBusy);
 now=130000;serviceAutoInboxPoll();assert(manifestTimes.back()==130000);finish();
 // Durable device ACKs take priority over a due manifest.
 now=150000;gInboxAckQueue.push_back("event-one");serviceAutoInboxPoll();
 assert(dispatched.back().eventId=="event-one"&&!dispatched.back().otaManifest);finish();
 gInboxAckQueue.clear();now+=250;serviceAutoInboxPoll();assert(dispatched.back().otaManifest);finish();
 // Browser/device manual checks share the same worker and cannot overlap.
 now+=20000;assert(startBackgroundManifestCheck(true,true));
 assert(dispatched.back().applyAfter&&dispatched.back().announce);
 assert(!startBackgroundManifestCheck(false,false));finish();
}
'''
with tempfile.TemporaryDirectory(prefix='s1-auto-ota-') as directory:
 p=Path(directory);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS actual OTA scheduler: 20s GET dispatch, busy pauses, retry interval, ACK priority and one network owner; hardware cadence remains separate')
