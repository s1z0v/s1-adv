#!/usr/bin/env python3
"""Compile actual Mesh lifecycle functions against controlled hardware/tasks."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
PARTS=ROOT/'bots/CardputerADV/src/main_parts'
def function(file,signature):
    s=(PARTS/file).read_text();start=s.index(signature);end=s.index('{',start)+1;depth=1
    while depth:
        depth+=(s[end]=='{')-(s[end]=='}');end+=1
    return s[start:end]

enum=(PARTS/'002_main.cpp.inc').read_text().split('enum class UiMode',1)[1].split('};',1)[0]
code=r'''
#include "mesh_leaf_state.h"
#include <cassert>
bool radioBusy(){return false;}
bool vlcBusy(){return false;} namespace vlc_remote{void cancel(){}}
void stopInternetRadio(){}
bool synthStopOk=true;bool stopPocketSynth(){return synthStopOk;}
template<class T>bool deferInternetRadioMode(T){return false;}
template<class T>bool deferVlcRemoteMode(T){return false;}
#include <atomic>
#include <algorithm>
#include <memory>
#include <string>
#include <vector>
struct String:std::string {
 using std::string::string;using std::string::operator=;
 String(const std::string&s):std::string(s){} String(int n):std::string(std::to_string(n)){}
 bool isEmpty()const{return empty();}
};
uint32_t clockMs=1000;uint32_t millis(){return clockMs;}
constexpr int HIGH=1,OUTPUT=1,CARD_NONE=0,pdPASS=1,RADIOLIB_ERR_UNKNOWN=-1;
constexpr int kRfidCsPin=5,kSdCsPin=12,kSdSckPin=40,kSdMisoPin=39,kSdMosiPin=14,kSdFrequencyHz=4000000;
int live=0,sdEnds=0,sdBegins=0,spiBegins=0,updates=0,renders=0,initError=0,taskCreates=0;
bool workerPending=false,taskSucceeds=true,sdSucceeds=true;
void(*workerFunction)(void*)=nullptr;void* workerArg=nullptr;
bool gMeshBusOwned=false,gMeshCancelStart=false,gMeshExitAfterStop=false,gLauncherVisible=false;
bool gSdReady=true,gStorageReady=true,gLittleFsReady=true;
bool gBootBackgroundActive=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gTransferUiActive=false,gOtaApplyInProgress=false,gInboxHttpBusy=false,gVoiceDialBusy=false;
bool gVoiceReplySpeechBusy=false,gRealtimeActive=false,gRealtimeDialBusy=false,gRealtimeExclusiveMode=false;
bool gPendingRealtimeStart=false,gG0VoicePending=false,gVoiceCapturePreparing=false,gCanvasSpriteActive=true;
void* gTextTurnTaskHandle=nullptr;void* gCompletedTextTurn=nullptr;
String gActiveTextTurn,gQueuedVoiceReplySpeech,gMeshNotice;
std::vector<String>gPendingTextTurns;
uint32_t gMeshNoticeUntilMs=0;
struct {uint32_t free=128000;uint32_t getFreeHeap(){return free;}}ESP;
constexpr int MALLOC_CAP_8BIT=1;uint32_t largest=64000;
uint32_t heap_caps_get_largest_free_block(int){return largest;}
std::array<int,49>pins{};
void digitalWrite(int p,int v){assert((p==5||p==12)&&v==HIGH);pins[p]=v;}
void pinMode(int p,int v){assert((p==5||p==12)&&v==OUTPUT&&pins[p]==HIGH);}
struct Spi {void begin(int a,int b,int c,int d){assert(a==40&&b==39&&c==14&&d==12);assert(pins[5]==HIGH&&pins[12]==HIGH);++spiBegins;}}gSdSpi;
namespace fs {struct FS{};}
struct Sd:fs::FS {
 void end(){++sdEnds;}
 bool begin(int cs,Spi&,int hz){assert(cs==12&&hz==4000000&&!gMeshBusOwned&&live==0);++sdBegins;return sdSucceeds;}
 int cardType(){return 1;}
}SD;
fs::FS LittleFS;
namespace m5 {
struct I2C_Class {
 bool enabled=true;int sda=8,scl=9,writes=0,failWrite=0;std::array<uint8_t,256>reg{};
 bool isEnabled()const{return enabled;}int getSDA()const{return sda;}int getSCL()const{return scl;}
 bool readRegister(int a,int r,uint8_t*b,size_t n,int hz){assert(a==0x43&&n==1&&hz==100000);if(!enabled)return false;*b=reg[r];return true;}
 bool writeRegister8(int a,int r,uint8_t b,int hz){assert(a==0x43&&hz==100000);++writes;if(failWrite==writes)return false;reg[r]=b;return true;}
};I2C_Class In_I2C,Ex_I2C;
}
m5::I2C_Class* gMeshCapBus=nullptr;uint8_t gMeshCapBits[3]={};bool gMeshCapBitsSaved=false;
std::array<uint8_t,64> nv{};bool nvPresent=false,nvOpen=true,nvWritable=true;int nvWrites=0;
struct Preferences {
 bool begin(const char*s,bool ro){assert(std::string(s)=="s1mesh"&&!ro);return nvOpen;}
 size_t getBytesLength(const char*){return nvPresent?64:0;}
 size_t getBytes(const char*,uint8_t*b,size_t n){if(!nvPresent)return 0;memcpy(b,nv.data(),n);return n;}
 size_t putBytes(const char*,const uint8_t*b,size_t n){++nvWrites;if(!nvWritable)return 0;memcpy(nv.data(),b,n);nvPresent=true;return n;}
 void end(){}
};
namespace libmeshtastic_leaf {
struct MeshPacket{};
struct MeshCryptoPKI {
 static bool isUsablePublicKey(const uint8_t*p){return p[0]!=0;}
 static bool regeneratePublicKey(uint8_t*out,const uint8_t*p){memcpy(out,p,32);return p[0]!=0;}
};
struct libmeshtastic_leaf {
 static bool generateKeyPair(uint8_t*p,uint8_t*s){memset(p,42,32);memset(s,42,32);return true;}
};
}
uint32_t nextSendId=100;
struct FakeMesh {
 void setMyPublicKey(const uint8_t*p){assert(p[0]==42);}void setMyPrivateKey(const uint8_t*p){assert(p[0]==42);}
 uint32_t getNodeNum()const{return 42;}
 uint32_t sendText(const char*){assert(gMeshBusOwned&&!gSdReady);return nextSendId;}
 void onReceive(void(*)(const libmeshtastic_leaf::MeshPacket&)){}
 void update(){assert(gMeshBusOwned&&!gSdReady);++updates;}
};
namespace s1_mesh {
constexpr int kInitPending=-32768;
struct RadioSession {
 FakeMesh mesh;State state;std::atomic<int>initResult{kInitPending};
 bool readyReported=false;uint32_t lowHeap=UINT32_MAX,lowLargest=UINT32_MAX;
 explicit RadioSession(Spi&){++live;}
 ~RadioSession(){assert(!workerPending);--live;}
 int initialize(){assert(gMeshBusOwned&&!gSdReady);return initError;}
};
}
std::unique_ptr<s1_mesh::RadioSession>gMeshSession;
int xTaskCreate(void(*fn)(void*),const char*,int stack,void*arg,int priority,void*) {
 assert(stack==8192&&priority==1&&gMeshBusOwned&&!gSdReady);++taskCreates;
 if(!taskSucceeds){return 0;}
 workerFunction=fn;workerArg=arg;workerPending=true;return pdPASS;
}
void vTaskDelete(void*p){assert(p==nullptr);workerPending=false;}
void render(){++renders;}
template<class...T>void logf(const char*,T...){ }
void setStatus(const String&,int){}
struct Keyboard_Class {struct KeysState {bool ctrl=false,enter=false,del=false;};};
String translateInputChar(char c){return String(1,c);}
void meshHandlePacket(const libmeshtastic_leaf::MeshPacket&){}
void setUiMode(UiMode);
'''
code=code.replace('void setUiMode(UiMode);','enum class UiMode'+enum+'};\nUiMode gUiMode=UiMode::Mesh;\nvoid setUiMode(UiMode);')
for signature in ['bool mountSdCardOnSharedSpi()','fs::FS* activeVoiceFs()','fs::FS* activeNotesFs()']:
    file='032_main.cpp.inc' if signature.startswith('bool mount') else '011_main.cpp.inc'
    code+=function(file,signature)+'\n'
code+='bool stopMeshMode(bool goHome);\n'
for signature in ['bool handleMeshEscape(', 'bool meshBlocksMode(','bool meshStartIsBusy(','bool meshCapBit(',
                  'void meshRestoreCap(','bool meshEnableCap(','bool loadMeshIdentity(',
                  'void meshRadioInitTask(','bool stopMeshMode(','void startMeshMode(',
                  'void serviceMeshMode(','bool meshSendInput(','bool handleMeshKey(']:
    code+=function('068_main.cpp.inc',signature)+'\n'
actual=function('024_main.cpp.inc','void setUiMode(')
code+=actual[:actual.index('  if (mode != UiMode::Face)')]+ 'gUiMode=mode;\n}\n'
realtime=function('042_main.cpp.inc','void startRealtimeSession(')
code+='int realtimeStarts=0;\n'+realtime[:realtime.index('  handleScreensaverWake();')]+ '(void)startAfterReady;++realtimeStarts;\n}\n'
code+=r'''
void reset() {
 assert(!gMeshBusOwned&&!workerPending&&live==0);
 gUiMode=UiMode::Mesh;gSdReady=true;gStorageReady=true;gLittleFsReady=true;
 ESP.free=128000;largest=64000;gCanvasSpriteActive=true;taskSucceeds=sdSucceeds=true;initError=0;
 m5::In_I2C={};m5::Ex_I2C={};m5::Ex_I2C.enabled=false;
 m5::In_I2C.reg[3]=0xaa;m5::In_I2C.reg[5]=0x54;m5::In_I2C.reg[7]=0xff;
 nvPresent=false;nvOpen=nvWritable=true;nvWrites=0;
 sdEnds=sdBegins=spiBegins=updates=renders=taskCreates=0;nextSendId=100;
}
void completeWorker(){assert(workerPending);workerFunction(workerArg);assert(!workerPending);}
void active(){reset();startMeshMode();assert(gMeshBusOwned&&!gSdReady&&!gStorageReady&&workerPending);completeWorker();serviceMeshMode();assert(updates==1);}
void restored(){assert(!gMeshBusOwned&&gSdReady&&gStorageReady&&live==0&&sdBegins==1);assert(m5::In_I2C.reg[3]==0xaa&&m5::In_I2C.reg[5]==0x54&&m5::In_I2C.reg[7]==0xff);}
int main() {
 synthStopOk=false;startRealtimeSession(true);assert(realtimeStarts==0);synthStopOk=true;
 reset();
 bool* flags[]={&gBootBackgroundActive,&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gTransferUiActive,
 &gOtaApplyInProgress,&gInboxHttpBusy,&gVoiceDialBusy,&gVoiceReplySpeechBusy,&gRealtimeActive,
 &gRealtimeDialBusy,&gRealtimeExclusiveMode,&gPendingRealtimeStart,&gG0VoicePending,&gVoiceCapturePreparing};
 for(auto* p:flags){*p=true;startMeshMode();assert(!live&&!sdEnds&&!taskCreates&&!m5::In_I2C.writes);*p=false;}
 ESP.free=65535;startMeshMode();assert(!live&&!sdEnds);ESP.free=128000;
 largest=24575;startMeshMode();assert(!live&&!sdEnds);largest=64000;
 gCanvasSpriteActive=false;startMeshMode();assert(!live&&!sdEnds);gCanvasSpriteActive=true;
 nvOpen=false;startMeshMode();assert(!live&&!sdEnds);nvOpen=true;
 nvWritable=false;startMeshMode();assert(!live&&!sdEnds);nvWritable=true;
 m5::In_I2C.enabled=false;startMeshMode();assert(!live&&!sdEnds);m5::In_I2C.enabled=true;
 for(int fail=1;fail<=3;++fail){reset();m5::In_I2C.failWrite=fail;startMeshMode();assert(!live&&!sdEnds&&!gMeshCapBitsSaved);assert(m5::In_I2C.reg[3]==0xaa&&m5::In_I2C.reg[5]==0x54&&m5::In_I2C.reg[7]==0xff);}
 reset();startMeshMode();assert(gMeshBusOwned&&live==1&&workerPending);
 const int begins=spiBegins;assert(!mountSdCardOnSharedSpi()&&spiBegins==begins);
 assert(activeVoiceFs()==nullptr&&activeNotesFs()==nullptr);
 assert(!stopMeshMode(true)&&workerPending&&live==1&&sdBegins==0);
 completeWorker();serviceMeshMode();restored();assert(gUiMode==UiMode::Home);
 active();startRealtimeSession(true);startRealtimeSession(false);assert(realtimeStarts==0);
 gLauncherVisible=true;startRealtimeSession(true);assert(realtimeStarts==0);gLauncherVisible=false;
 Keyboard_Class::KeysState key;
 assert(handleMeshKey('h',key)&&handleMeshKey('i',key)&&std::string(gMeshSession->state.input)=="hi");
 key.ctrl=true;assert(handleMeshKey('n',key)&&gMeshSession->state.nodeView);
 assert(handleMeshKey('o',key)&&gMeshSession->state.detailView&&!gMeshSession->state.nodeView);
 assert(handleMeshKey('r',key)&&gMeshBusOwned);key.ctrl=false;key.del=true;
 assert(handleMeshKey('\b',key)&&std::string(gMeshSession->state.input)=="h");key.del=false;key.enter=true;
 assert(handleMeshKey('\n',key)&&gMeshSession->state.messageCount==1&&!gMeshSession->state.input[0]);
 stopMeshMode(false);restored();
 startRealtimeSession(false);assert(realtimeStarts==1);
 reset();taskSucceeds=false;startMeshMode();restored();
 reset();initError=-19;startMeshMode();completeWorker();serviceMeshMode();restored();assert(gMeshNotice.find("-19")!=std::string::npos);
 for(UiMode mode:{UiMode::Voice,UiMode::Library,UiMode::AudioFolders,UiMode::Notes,UiMode::Assets,UiMode::Files,UiMode::Nes,UiMode::RfidLab,UiMode::Sonar}) {
   active();setUiMode(mode);assert(gUiMode==UiMode::Mesh&&gMeshBusOwned&&sdBegins==0);assert(stopMeshMode(false));restored();
 }
 for(UiMode mode:{UiMode::Home,UiMode::Calculator,UiMode::Chess,UiMode::Checkers,UiMode::Focus,UiMode::Settings}) {
   active();setUiMode(mode);restored();assert(gUiMode==mode);
 }
 active();gMeshSession->state.detailView=true;assert(handleMeshEscape());
 assert(!gMeshSession->state.detailView&&gMeshBusOwned&&sdBegins==0);
 gLauncherVisible=true;assert(!handleMeshEscape()&&gMeshBusOwned);gLauncherVisible=false;
 assert(handleMeshEscape());restored();assert(gUiMode==UiMode::Home&&!handleMeshEscape());
 reset();startMeshMode();assert(handleMeshEscape()&&workerPending&&live==1&&sdBegins==0);
 completeWorker();serviceMeshMode();restored();assert(gUiMode==UiMode::Home);
 active();assert(gMeshSession->state.append("hello"));nextSendId=0;assert(!meshSendInput());assert(gMeshSession->state.messageCount==0&&std::string(gMeshSession->state.input)=="hello");
 nextSendId=77;assert(meshSendInput());assert(gMeshSession->state.messageCount==1&&gMeshSession->state.messages[0].outgoing&&!gMeshSession->state.input[0]);
 for(int i=0;i<50;++i){serviceMeshMode();}
 assert(sdBegins==0);stopMeshMode(false);restored();
 active();sdSucceeds=false;stopMeshMode(false);assert(!gMeshBusOwned&&!gSdReady&&gStorageReady&&!live);assert(activeVoiceFs()==&LittleFS);assert(activeNotesFs()==&LittleFS);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-mesh-mode-') as directory:
    cpp=Path(directory)/'lifecycle.cpp';exe=Path(directory)/'lifecycle';cpp.write_text(code)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-fno-omit-frame-pointer',
                    '-I'+str(ROOT/'bots/CardputerADV/src'),str(cpp),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
print('PASS actual Mesh lifecycle: busy/heap/NVS/Cap/task failures, cancellation during init, SD exclusivity and rollback, app guards, bounded send and no worker use-after-free (ASan/UBSan)')
