#!/usr/bin/env python3
"""Exercise production Pomodoro UDP adapter and exact GL2 bank preservation."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1];parts=root/'bots/CardputerADV/src/main_parts'
def extract(signature):
 s=(parts/'044_main.cpp.inc').read_text();a=s.index(signature);i=s.index('{',a)+1;n=1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include "focus_lamp_link.h"
#include "smartlamp_gl2_protocol.h"
#include <cassert>
#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>
using std::min;using std::max;
struct String:std::string{using std::string::string;String(const std::string&s):std::string(s){} };
struct IPAddress{int value=9;bool operator==(const IPAddress&o)const{return value==o.value;}bool operator!=(const IPAddress&o)const{return value!=o.value;}};
constexpr int WL_CONNECTED=3;
struct{int connected=WL_CONNECTED;int status(){return connected;}}WiFi;
uint32_t tick=1000;uint32_t millis(){return tick;}
constexpr uint32_t kSmartLampOnlineTimeoutMs=5000,kSmartLampMinCommandGapMs=520;
constexpr uint16_t kSmartLampUdpPort=55555;
struct{bool lampSync=true;int lampFocusPreset=1,lampBreakPreset=5;}gFocusSettings;
struct{bool online=true,presetsLearned=true,power=false;uint32_t lastSeenMs=1000,lastCommandMs=0,presetSendDueMs=0;IPAddress ip;String status;cardputer_smartlamp::PresetBank presets;}gSmartLamp;
focus_lamp::Link gFocusLampLink;IPAddress gFocusLampIp;
bool gTimeValid=true,gTransferUiActive=false,gRecording=false,gSubmitting=false,gRealtimeActive=false;
String lastStatus;void setStatus(const String&s,int){lastStatus=s;}
void logf(const char*,...){}
focus_lamp::Phase phase=focus_lamp::Phase::Focus;
focus_lamp::Phase focusLampPhase(){return phase;}
void smartLampClockFields(uint8_t&day,uint8_t&hour,uint8_t&minute,uint8_t&second){day=4;hour=19;minute=23;second=45;}
String smartLampControlPacket(uint8_t command){assert(command==1);return "GL,0,1,4,19,23,45";}
struct Udp{
 bool beginOk=true,endOk=true;String pending;std::vector<String>packets;IPAddress peer;
 int beginPacket(IPAddress p,uint16_t port){assert(port==kSmartLampUdpPort);peer=p;pending.clear();return beginOk?1:0;}
 size_t write(const uint8_t*p,size_t n){pending.assign((const char*)p,n);return n;}
 int endPacket(){if(endOk)packets.push_back(pending);return endOk?1:0;}
}gSmartLampUdp;
bool ensureSmartLampUdp(){return true;}
IPAddress smartLampBroadcastAddress(){return IPAddress{255};}
'''+extract('bool smartLampSendPacket(')+extract('void serviceFocusLamp()')+r'''
std::vector<int> fields(const std::string&s){std::vector<int>out;size_t p=s.find(',')+1;for(;;){size_t end=s.find(',',p);out.push_back(std::stoi(s.substr(p,end-p)));if(end==std::string::npos)break;p=end+1;}return out;}
void reset(int original=8,int focus=1,int rest=5){
 tick=1000;gSmartLamp={};gSmartLamp.online=gSmartLamp.presetsLearned=true;gSmartLamp.ip.value=9;
 gSmartLamp.lastSeenMs=tick;gSmartLamp.presets.count=40;gSmartLamp.presets.selected=original;
 for(int p=0;p<40;++p)for(int i=0;i<13;++i)gSmartLamp.presets.values[p][i]=uint8_t((p*7+i*3)%10);
 gFocusSettings={true,focus,rest};gFocusLampLink={};gFocusLampLink.observe(original,tick);gSmartLampUdp={};
 phase=focus_lamp::Phase::Focus;gTimeValid=true;WiFi.connected=WL_CONNECTED;lastStatus.clear();
}
int applyPacket(const String&packet,int actual){
 if(packet=="GL,0,1,4,19,23,45")return actual;
 assert(packet.find("GL,2,")==0);cardputer_smartlamp::PresetBank decoded;
 assert(cardputer_smartlamp::parsePresetPacket(packet.c_str(),decoded));
 assert(decoded.count==gSmartLamp.presets.count);
 assert(!memcmp(decoded.values,gSmartLamp.presets.values,decoded.count*cardputer_smartlamp::kPresetSize));
 auto values=fields(packet);const size_t selected=2+13*decoded.count;
 assert(values[selected]==decoded.selected+1&&values[selected+1]==4&&values[selected+2]==19&&values[selected+3]==23&&values[selected+4]==45);
 return decoded.selected;
}
int settle(int actual){
 size_t applied=gSmartLampUdp.packets.size();
 for(int j=0;j<12;++j){tick+=600;gSmartLamp.lastSeenMs=tick;serviceFocusLamp();
  while(applied<gSmartLampUdp.packets.size())actual=applyPacket(gSmartLampUdp.packets[applied++],actual);
  gFocusLampLink.observe(actual,tick+10);
 }
 return actual;
}
int main(){
 // Every original/target pair including 1->40 and 40->1 selects once,
 // without ever emitting intermediate +/- controls or mutating effect bytes.
 for(int original=0;original<40;++original)for(int target=0;target<40;++target){
  reset(original,target,5);const auto before=gSmartLamp.presets;
  int actual=settle(original);assert(actual==target&&gFocusLampLink.original==original);
  const size_t expected=original==target?2:3;assert(gSmartLampUdp.packets.size()==expected);
  assert(!memcmp(&before,&gSmartLamp.presets,sizeof(before)));assert(gSmartLampUdp.peer==gFocusLampIp);
  phase=focus_lamp::Phase::Idle;actual=settle(actual);assert(actual==original&&!gFocusLampLink.active);
  assert(gSmartLampUdp.packets.size()==expected+(target==original?0:1));
 }
 // Dense byte values remain byte-for-byte intact for ordinary banks.
 reset();gSmartLamp.presets.count=15;
 for(int p=0;p<15;++p)for(int i=0;i<13;++i)gSmartLamp.presets.values[p][i]=uint8_t((p*67+i*31)&255);
 assert(settle(8)==1);
 // Oversized bank updates must not be split into partial UDP messages.
 reset();memset(gSmartLamp.presets.values,255,sizeof(gSmartLamp.presets.values));
 const auto dense=gSmartLamp.presets;settle(8);
 assert(gFocusLampLink.suspended&&gSmartLampUdp.packets.size()==2);
 assert(!memcmp(&dense,&gSmartLamp.presets,sizeof(dense)));
 reset();assert(!smartLampSendPacket(String(1461,'x'))&&gSmartLampUdp.packets.empty());
 // Focus->break and returning to original are also one bank each.
 reset();int actual=settle(8);assert(actual==1);phase=focus_lamp::Phase::Break;actual=settle(actual);assert(actual==5);
 phase=focus_lamp::Phase::Idle;actual=settle(actual);assert(actual==8&&!gFocusLampLink.active);
 // Validate immutable builder at all bank sizes, non-target settings, clock,
 // capacity and range checks. Zero bank or absent target never emits bytes.
 char packet[cardputer_smartlamp::kMaxPacketBytes];
 for(int count=1;count<=40;++count){reset();gSmartLamp.presets.count=count;
  for(int index=0;index<count;++index){auto before=gSmartLamp.presets;auto n=cardputer_smartlamp::buildPresetSelectionPacket(before,index,4,19,23,45,packet,sizeof(packet));assert(n>0);assert(applyPacket(packet,0)==index);assert(!memcmp(&before,&gSmartLamp.presets,sizeof(before)));}
 }
 reset();for(auto bad:{40,41,255})assert(!cardputer_smartlamp::buildPresetSelectionPacket(gSmartLamp.presets,bad,4,19,23,45,packet,sizeof(packet)));
 assert(!cardputer_smartlamp::buildPresetSelectionPacket(gSmartLamp.presets,0,7,19,23,45,packet,sizeof(packet)));
 assert(!cardputer_smartlamp::buildPresetSelectionPacket(gSmartLamp.presets,0,4,24,23,45,packet,sizeof(packet)));
 assert(!cardputer_smartlamp::buildPresetSelectionPacket(gSmartLamp.presets,0,4,19,60,45,packet,sizeof(packet)));
 assert(!cardputer_smartlamp::buildPresetSelectionPacket(gSmartLamp.presets,0,4,19,23,60,packet,sizeof(packet)));
 assert(!cardputer_smartlamp::buildPresetSelectionPacket(gSmartLamp.presets,0,4,19,23,45,packet,6));
 // No learned bank, out-of-bank target, failed send, offline peer, bad clock,
 // capture/transfer ownership or pending manual edits cannot trigger fallback.
 reset();gSmartLamp.presetsLearned=false;serviceFocusLamp();assert(gSmartLampUdp.packets.empty()&&gFocusLampLink.suspended&&lastStatus.find("Sync")!=std::string::npos);
 reset();gSmartLamp.presets.count=1;serviceFocusLamp();assert(gSmartLampUdp.packets.empty()&&gFocusLampLink.suspended);
 for(bool begin:{false,true}){reset();gSmartLampUdp.beginOk=begin;gSmartLampUdp.endOk=false;serviceFocusLamp();assert(gSmartLampUdp.packets.empty()&&gFocusLampLink.suspended);}
 for(bool*p:{&gTransferUiActive,&gRecording,&gSubmitting,&gRealtimeActive}){reset();*p=true;serviceFocusLamp();assert(gSmartLampUdp.packets.empty());*p=false;}
 reset();gTimeValid=false;serviceFocusLamp();assert(gSmartLampUdp.packets.empty());
 reset();gSmartLamp.presetSendDueMs=2000;serviceFocusLamp();assert(gSmartLampUdp.packets.empty());
 reset();gSmartLamp.lastCommandMs=tick-100;serviceFocusLamp();assert(gSmartLampUdp.packets.empty());
 reset();settle(8);gSmartLamp.ip.value=10;tick+=600;gSmartLamp.lastSeenMs=tick;serviceFocusLamp();assert(gFocusLampLink.suspended&&!gFocusLampLink.active);
 // An in-flight target can be acknowledged after a phase change, then the
 // next target is selected directly. No optimistic/forged presence update.
 reset();for(int i=0;i<3;++i){tick+=600;gSmartLamp.lastSeenMs=tick;serviceFocusLamp();}
 assert(gFocusLampLink.waiting&&gFocusLampLink.current==8&&gFocusLampLink.expected==1);
 phase=focus_lamp::Phase::Break;tick+=600;gSmartLamp.lastSeenMs=tick;serviceFocusLamp();assert(gFocusLampLink.waiting&&gFocusLampLink.expected==1&&gFocusLampLink.target==5);
 gFocusLampLink.observe(1,tick);assert(!gFocusLampLink.waiting);assert(settle(1)==5);
 puts("PASS actual Focus UDP adapter: 1600 direct transition/restore pairs, exact full-bank preservation, correct independent weekday/clock, ACK ownership, bounds and no scrolling/unsafe-opcode fallback (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-lamp-direct-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-g','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I'+str(root/'bots/CardputerADV/src'),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=60)
