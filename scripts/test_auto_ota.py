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
bool radioBusy(){return false;}
void stopInternetRadio(){}
template<class T>bool deferInternetRadioMode(T){return false;}
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>
struct String:std::string {using std::string::string;String(const std::string&s):std::string(s){}bool isEmpty()const{return empty();}};
enum class UiMode{Home,ChatFace,Face,Hero,ChatFull,Ota,Clock,Focus,Settings,FocusSettings,ScreenSettings,Nes,Sonar,RfidLab,IrRemote,Tetris,KeyRush,BrainFlow,Files,Chess,Checkers,Minesweeper,Radio,VlcRemote};UiMode gUiMode=UiMode::Home;
namespace brainflow {enum class Phase {Menu,Playing,Feedback,Paused,Finished};}
struct{brainflow::Phase phase=brainflow::Phase::Menu;}gBrainFlow;
struct{bool running=false;}gKeyRush;
bool gTetrisStarted=false,gTetrisPaused=false,gTetrisGameOver=false;
bool gWifiReady=true,gOtaApplyInProgress=false,gTransferUiActive=false,gLauncherVisible=false;
bool gG0VoicePending=false;
bool gBootBackgroundActive=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gVoiceReplySpeechBusy=false,gVoiceDialBusy=false,gRealtimeDialBusy=false,gPendingRealtimeStart=false;
bool gRealtimeActive=false,gRealtimeConnected=false,gRealtimeRecording=false,gRealtimeAwaiting=false;
bool gRealtimeSmokeActive=false,gRealtimeSmokeAudioStreaming=false;
void* gTextTurnTaskHandle=nullptr;void* gCompletedTextTurn=nullptr;
String gActiveTextTurn,gInputBuffer,gDeviceToken="private-in-memory",gHubHost="bridge.invalid";
String gQueuedVoiceReplySpeech;
std::deque<String> gPendingTextTurns,gInboxAckQueue;
uint32_t now=30000,gOtaLastAutoCheckMs=0,gLastUserActivityMs=0,gLastUserInputMs=0,gLastInboxAutoPollMs=0,gInboxRetryAfterMs=0;
constexpr uint32_t kOtaAutoCheckIntervalMs=20000,kOtaScreenCheckIntervalMs=5000,kInboxAutoPollIntervalMs=15000;
constexpr const char* kFirmwareManifestFetchPath="/api/cardputer/firmware/manifest";
constexpr const char* kAppVersion="0.2.167-dev";constexpr const char* kBuildGitSha="test";
bool gInboxHttpBusy=false,gVoiceReplyPending=false,gPendingOtaCheckAction=false,gPendingOtaApplyAction=false,failStart=false;
uint32_t gVoiceReplyPendingMs=0;
uint32_t millis(){return now;}void logf(const char*,...){}
String hubBaseUrl(){return "https://bridge.invalid";}
struct InboxHttpPayload {String url,token,eventId;bool otaManifest=false,applyAfter=false,announce=false;};
std::vector<InboxHttpPayload> dispatched;std::vector<uint32_t> manifestTimes;
bool startInboxNetworkRequest(std::unique_ptr<InboxHttpPayload> p){assert(!gInboxHttpBusy);if(failStart)return false;gInboxHttpBusy=true;
 if(p->otaManifest)manifestTimes.push_back(now);dispatched.push_back(*p);gLastInboxAutoPollMs=now;return true;}
void finish(){gInboxHttpBusy=false;}
'''
code+=r'''
using std::max;
bool gVoiceNoticeVisible=false,gScreenOffActive=false,gScreensaverActive=false,gScreensaverDimmed=false,gPendingRestart=false;
uint32_t gScreensaverStartedMs=0;
UiMode gScreensaverPreviousMode=UiMode::Home;
struct{uint8_t screensaverTimeoutMin=1,screenOffAfterMin=5,screensaverDimAfterMin=1;bool screensaverEnabled=false,screenAutoOffEnabled=false;}gDeviceSettings;
void applyDisplayBrightness(){}void enterScreensaver(){gScreensaverActive=true;}
'''
for sig in ['bool screensaverMayRun()', 'void markUserActivity()', 'void serviceIdleScreensaver()']:
 code+=function('009_main.cpp.inc',sig)+'\n'
code+=function('063_main.cpp.inc','bool appAllowsBackgroundNetwork()')+'\n'
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
 // A due manifest cannot be starved by a durable ACK. The ACK is preserved
 // and takes the worker immediately after the manifest completes.
 now=150000;gInboxAckQueue.push_back("event-one");serviceAutoInboxPoll();
 assert(dispatched.back().otaManifest&&gInboxAckQueue.front()=="event-one");finish();
 now+=250;serviceAutoInboxPoll();assert(dispatched.back().eventId=="event-one");finish();
 // Repeated failed ACKs retain the event and back off for four seconds.
 // Discovery must still recur within its interval plus that bounded backoff.
 const auto firstManifest=manifestTimes.size();
 for(now=150500;now<=450500;now+=250){
  const auto n=dispatched.size();serviceAutoInboxPoll();
  if(dispatched.size()>n && !dispatched.back().eventId.isEmpty())gInboxRetryAfterMs=now+4000;
  finish();
 }
 assert(gInboxAckQueue.size()==1&&gInboxAckQueue.front()=="event-one");
 assert(manifestTimes.size()>=firstManifest+12);
 for(auto i=firstManifest;i<manifestTimes.size();++i)assert(manifestTimes[i]-manifestTimes[i-1]<=24000);
 gInboxAckQueue.clear();gInboxRetryAfterMs=0;
 // An idle saved draft suppresses incoming chat, never release discovery.
 gInputBuffer="unfinished draft";now=manifestTimes.back()+20000;
 serviceAutoInboxPoll();assert(manifestTimes.back()==now);finish();
 const auto draftCount=dispatched.size();now+=15000;serviceAutoInboxPoll();assert(dispatched.size()==draftCount);
 now+=5000;serviceAutoInboxPoll();assert(dispatched.back().otaManifest);finish();gInputBuffer.clear();
 // Failed worker creation is not a dispatched check and cannot spin each loop.
 now+=20000;const auto lastCheck=gOtaLastAutoCheckMs;failStart=true;
 assert(!startBackgroundManifestCheck(false,false));assert(gOtaLastAutoCheckMs==lastCheck);
 const auto failedCount=dispatched.size();serviceAutoInboxPoll();assert(dispatched.size()==failedCount);
 now+=4000;failStart=false;serviceAutoInboxPoll();assert(manifestTimes.back()==now);finish();

 // Execute the real screensaver hold on Firmware and on an accepted-request
 // notice. It refreshes screen-idle time every loop without faking key input.
 for(auto mode:{UiMode::Ota,UiMode::Home}) {
  gUiMode=mode;gVoiceNoticeVisible=mode==UiMode::Home;
  now+=20000;markUserActivity();const auto start=now;const auto count=manifestTimes.size();
  for(now=start;now<=start+65000;now+=250){serviceIdleScreensaver();serviceAutoInboxPoll();finish();}
  assert(gLastUserActivityMs>=start+65000);assert(gLastUserInputMs==start);
  assert(manifestTimes.size()>=count+3);
 }
 gVoiceNoticeVisible=false;gUiMode=UiMode::Home;
 // Browser/device manual checks share the same worker and cannot overlap.
 now+=20000;assert(startBackgroundManifestCheck(true,true));
 assert(dispatched.back().applyAfter&&dispatched.back().announce);
 assert(!startBackgroundManifestCheck(false,false));finish();
 // A queued spoken reply gets the network owner before another background GET.
 gQueuedVoiceReplySpeech="Four";assert(!autoInboxPollAllowed());
 gQueuedVoiceReplySpeech="";assert(autoInboxPollAllowed());
 // File-management transactions suppress background network/storage work.
 gUiMode=UiMode::Files;assert(!autoInboxPollAllowed());
 gUiMode=UiMode::Chess;assert(!autoInboxPollAllowed());
 gUiMode=UiMode::Checkers;assert(!autoInboxPollAllowed());
 gUiMode=UiMode::Minesweeper;assert(!autoInboxPollAllowed());
 // Active games and timing-sensitive peripherals also suppress background work.
 for(auto m:{UiMode::Settings,UiMode::FocusSettings,UiMode::ScreenSettings}){gUiMode=m;assert(autoInboxPollAllowed());}
 gUiMode=UiMode::Tetris;gTetrisStarted=true;assert(!autoInboxPollAllowed());
 gTetrisPaused=true;assert(autoInboxPollAllowed());
 gUiMode=UiMode::KeyRush;gKeyRush.running=true;assert(!autoInboxPollAllowed());gKeyRush.running=false;assert(autoInboxPollAllowed());
 gUiMode=UiMode::BrainFlow;gBrainFlow.phase=brainflow::Phase::Playing;assert(!autoInboxPollAllowed());
 gBrainFlow.phase=brainflow::Phase::Paused;assert(autoInboxPollAllowed());
 gUiMode=UiMode::Nes;assert(!autoInboxPollAllowed());
 // Idle Focus and an open launcher still report the actual device version.
 gUiMode=UiMode::Focus;gLauncherVisible=true;
 assert(autoInboxPollAllowed());now+=20000;gLastUserInputMs=now;
 auto n=dispatched.size();serviceAutoInboxPoll();assert(dispatched.size()==n);
 now+=1001;serviceAutoInboxPoll();assert(dispatched.size()==n+1);finish();
 // An open firmware screen checks every five seconds using that same owner.
 // Returning Home restores twenty seconds. Busy audio still defers a due GET.
 gUiMode=UiMode::Ota;gLauncherVisible=false;gLastUserInputMs=0;gOtaLastAutoCheckMs=now;
 auto screenCount=manifestTimes.size();
 now+=4999;serviceAutoInboxPoll();finish();assert(manifestTimes.size()==screenCount);
 ++now;serviceAutoInboxPoll();assert(manifestTimes.size()==screenCount+1);finish();
 auto lastScreenCheck=now;
 gRecording=true;now+=5000;serviceAutoInboxPoll();assert(manifestTimes.size()==screenCount+1);
 gRecording=false;serviceAutoInboxPoll();assert(manifestTimes.back()==now);finish();
 gUiMode=UiMode::Home;auto homeCount=manifestTimes.size();
 now+=5000;serviceAutoInboxPoll();finish();assert(manifestTimes.size()==homeCount);
 now+=15000;serviceAutoInboxPoll();finish();assert(manifestTimes.size()==homeCount+1);
 assert(lastScreenCheck>0);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-auto-ota-') as directory:
 p=Path(directory);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS actual OTA scheduler: bounded discovery despite failed ACKs and idle drafts, resource pauses, worker failure backoff and one network owner; hardware cadence remains separate')
