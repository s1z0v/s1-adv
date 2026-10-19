#!/usr/bin/env python3
"""Compile the recovery policy and actual maintainConnectivity integration.

This test only supplies failure/success/time/idle events to the production
header, plus Wi-Fi/IP/busy events to the extracted production function. It
does not copy either state machine, contact a network, modify credentials or
prove that reassociation repairs a physical transport fault.
"""
import argparse
from pathlib import Path
import os
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

CPP = r'''
#include "network_recovery.h"
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <limits>
using network_recovery::Policy;

uint32_t after(uint32_t start,uint32_t elapsed){return start+elapsed;}
void threeFailures(Policy& policy,uint32_t start){
 policy.failure(start);policy.failure(after(start,1));policy.failure(after(start,2));
}

void thresholdAndGrace(){
 static_assert(Policy::kGraceMs==1000,"Review the grace contract if changed");
 static_assert(Policy::kCooldownMs==60000,"Review the cooldown contract if changed");
 Policy fresh;
 assert(!fresh.takeReconnect(0,true,true));
 assert(!fresh.takeReconnect(100000,true,true));
 for(unsigned failures=1;failures<=2;++failures){
  Policy policy;
  for(unsigned i=0;i<failures;++i)policy.failure(i);
  assert(!policy.takeReconnect(100000,true,true));
 }
 Policy three;threeFailures(three,0);
 assert(!three.takeReconnect(999,true,true));
 assert(three.takeReconnect(1000,true,true));
 assert(!three.takeReconnect(1000,true,true));
 // A stream loss promotes one observed failure to the recovery threshold.
 Policy lost;lost.streamLost(500);
 assert(!lost.takeReconnect(1499,true,true));
 assert(lost.takeReconnect(1500,true,true));
 // Grace belongs to the first failure, not the last callback in a streak.
 Policy staggered;staggered.failure(100);staggered.failure(800);staggered.failure(1099);
 assert(staggered.takeReconnect(1100,true,true));
 Policy promoted;promoted.failure(100);promoted.streamLost(800);
 assert(promoted.takeReconnect(1100,true,true));
 std::puts("PASS cold/1/2/3 failures, severe stream loss, exact first-failure grace and one-shot consumption");
}

void busyAndAssociation(){
 for(unsigned mask=0;mask<3;++mask){
  Policy policy;threeFailures(policy,0);
  const bool idle=(mask&1U)!=0,associated=(mask&2U)!=0;
  assert(!policy.takeReconnect(1000,idle,associated));
  // A refused opportunity must not consume the only attempt or start cooldown.
  assert(policy.takeReconnect(1000,true,true));
 }
 Policy changing;changing.streamLost(0);
 assert(!changing.takeReconnect(999,true,true));
 assert(!changing.takeReconnect(1000,false,true));
 assert(!changing.takeReconnect(2000,true,false));
 assert(!changing.takeReconnect(3000,false,false));
 assert(changing.takeReconnect(3000,true,true));
 std::puts("PASS grace/busy/not-associated gates do not consume an attempt");
}

void boundedOutage(){
 Policy saturated;
 // More events than uint8_t can hold must still reach the three-failure gate.
 for(unsigned i=0;i<1024;++i)saturated.failure(i);
 assert(saturated.takeReconnect(1024,true,true));
 Policy outage;threeFailures(outage,0);
 assert(outage.takeReconnect(1000,true,true));
 unsigned extraAttempts=0;
 for(uint32_t hour=1;hour<=24U*31U;++hour){
  const uint32_t now=1000U+hour*3600000U;
  outage.failure(now);outage.streamLost(now);
  if(outage.takeReconnect(now,true,true))++extraAttempts;
 }
 assert(extraAttempts==0);
 // Passing a cooldown is insufficient: application success must rearm policy.
 assert(!outage.takeReconnect(3000000000U,true,true));
 std::puts("PASS saturating failure counter and 31-day outage permit one reconnect until application success");
}

void successAndCooldown(){
 Policy cancelled;cancelled.failure(0);cancelled.failure(1);cancelled.success();
 assert(!cancelled.takeReconnect(5000,true,true));
 cancelled.failure(6000);cancelled.failure(6001);
 assert(!cancelled.takeReconnect(6001,true,true));
 cancelled.failure(6002);
 assert(!cancelled.takeReconnect(6999,true,true));
 assert(cancelled.takeReconnect(7000,true,true));

 Policy rearmed;rearmed.streamLost(0);
 assert(rearmed.takeReconnect(1000,true,true));
 rearmed.success();rearmed.streamLost(1001);
 assert(!rearmed.takeReconnect(2000,true,true)); // New streak's grace.
 assert(!rearmed.takeReconnect(2001,true,true)); // Grace passed, cooldown has not.
 assert(!rearmed.takeReconnect(60999,true,true));
 assert(rearmed.takeReconnect(61000,true,true));
 assert(!rearmed.takeReconnect(121000,true,true)); // No application success.

 Policy repeated;repeated.streamLost(0);
 assert(repeated.takeReconnect(1000,true,true));
 for(unsigned i=0;i<32;++i)repeated.success();
 repeated.streamLost(6000);
 assert(!repeated.takeReconnect(7000,true,true));
 assert(!repeated.takeReconnect(60999,true,true));
 assert(repeated.takeReconnect(61000,true,true));

 Policy cancelPending;cancelPending.streamLost(0);cancelPending.success();
 assert(!cancelPending.takeReconnect(1000,true,true));
 cancelPending.streamLost(1000);
 assert(!cancelPending.takeReconnect(1999,true,true));
 assert(cancelPending.takeReconnect(2000,true,true));
 std::puts("PASS success cancels old failures and rearms; cooldown survives success and repeated refused opportunities");
}

void clockWrap(){
 constexpr uint32_t max=std::numeric_limits<uint32_t>::max();
 const uint32_t first=max-499U;
 Policy grace;threeFailures(grace,first);
 assert(!grace.takeReconnect(after(first,999),true,true));
 assert(grace.takeReconnect(after(first,1000),true,true));

 const uint32_t attempt=max-255U;
 Policy cooling;cooling.streamLost(attempt-1000U);
 assert(cooling.takeReconnect(attempt,true,true));
 cooling.success();cooling.streamLost(after(attempt,1));
 assert(!cooling.takeReconnect(after(attempt,59999),true,true));
 assert(cooling.takeReconnect(after(attempt,60000),true,true));

 // A real attempt at millis()==0 must not be confused with 'never attempted'.
 Policy atZero;atZero.streamLost(uint32_t{0}-Policy::kGraceMs);
 assert(!atZero.takeReconnect(max,true,true));
 assert(atZero.takeReconnect(0,true,true));
 atZero.success();atZero.streamLost(0);
 assert(!atZero.takeReconnect(999,true,true));
 assert(!atZero.takeReconnect(1000,true,true));
 assert(!atZero.takeReconnect(59999,true,true));
 assert(atZero.takeReconnect(60000,true,true));
 std::puts("PASS unsigned millis wrap for grace/cooldown and an actual attempt at time zero");
}

void independentInstances(){
 Policy a,b;
 threeFailures(a,0);assert(a.takeReconnect(1000,true,true));
 assert(!b.takeReconnect(1000,true,true));
 b.streamLost(1000);assert(b.takeReconnect(2000,true,true));
 a.success();a.streamLost(2000);
 assert(!a.takeReconnect(3000,true,true));
 assert(a.takeReconnect(61000,true,true));
 assert(!b.takeReconnect(62000,true,true));
 b.success();b.streamLost(62000);
 assert(b.takeReconnect(63000,true,true));
 std::puts("PASS instances do not share failure, one-shot or cooldown state");
}

'''


CPP_INTEGRATION = r'''
#include <string>
#include <vector>
namespace integration {
class String {
 public:
  std::string value;
  String()=default;
  String(const char* text):value(text?text:""){}
  String(std::string text):value(std::move(text)){}
  bool isEmpty()const{return value.empty();}
  const char* c_str()const{return value.c_str();}
};
String operator+(const String& a,const String& b){return String(a.value+b.value);}
struct IPAddress {
 uint32_t address;
 IPAddress(uint8_t a,uint8_t b,uint8_t c,uint8_t d):
  address(uint32_t{a}<<24|uint32_t{b}<<16|uint32_t{c}<<8|d){}
 bool operator!=(const IPAddress& other)const{return address!=other.address;}
 String toString()const{return address?"192.0.2.4":"0.0.0.0";}
};
constexpr int WL_CONNECTED=3;
struct Fixture {
 uint32_t now=1000;
 bool associated=true,hasIP=true,reconnectResult=true;
 unsigned reconnectCalls=0,portalCalls=0,ntpCalls=0,wsCalls=0,statusReads=0,logs=0;
 std::vector<std::string> statuses,errors,events;
};
Fixture f;
Policy gNetworkRecovery;
bool gSetupPortalActive=false,gBootBackgroundActive=false,gG0VoicePending=false;
bool gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gRealtimeActive=false,gPendingRealtimeStart=false,gRealtimeDialBusy=false;
bool gInboxHttpBusy=false,gVoiceDialBusy=false,gVoiceReplySpeechBusy=false;
bool gOtaApplyInProgress=false,gTransferUiActive=false;
void* gTextTurnTaskHandle=nullptr;
std::vector<int> gPendingTextTurns;
bool gWifiReady=true,gWsReady=false,gResumeWsAfterVoice=false;
uint32_t gLastWifiReconnectMs=17;
constexpr bool kUseHubWebSocket=false; // Unrelated legacy WS feature is off in this fixture.
String gHubHost="fixture.invalid";
struct Wifi {
 int status(){++f.statusReads;return f.associated?WL_CONNECTED:0;}
 IPAddress localIP(){return f.hasIP?IPAddress(192,0,2,4):IPAddress(0,0,0,0);}
 bool reconnect(){++f.reconnectCalls;return f.reconnectResult;}
} WiFi;
uint32_t millis(){return f.now;}
void serviceSetupPortal(){++f.portalCalls;}
void setStatus(const String& text,unsigned){f.statuses.push_back(text.value);}
void pushError(const String& text){f.errors.push_back(text.value);}
void pushSystem(const String& text){f.events.push_back(text.value);}
void syncClockFromNtp(bool){++f.ntpCalls;}
void startHubWebSocket(){++f.wsCalls;}
template<class... T> void logf(const char*,T...){++f.logs;}
void reset(){
 f=Fixture{};gNetworkRecovery=Policy{};
 gSetupPortalActive=gBootBackgroundActive=gG0VoicePending=false;
 gRecording=gSubmitting=gThinking=gPlaybackActive=false;
 gRealtimeActive=gPendingRealtimeStart=gRealtimeDialBusy=false;
 gInboxHttpBusy=gVoiceDialBusy=gVoiceReplySpeechBusy=false;
 gOtaApplyInProgress=gTransferUiActive=false;
 gTextTurnTaskHandle=nullptr;gPendingTextTurns.clear();
 gWifiReady=true;gWsReady=gResumeWsAfterVoice=false;gLastWifiReconnectMs=17;
}
'''

CPP_INTEGRATION_TESTS = r'''
void assertScheduledOnce(){
 assert(f.reconnectCalls==1 && !gWifiReady && gLastWifiReconnectMs==f.now);
 assert(f.statuses.size()==1 && f.statuses.back()=="Reconnecting Wi-Fi");
 assert(f.ntpCalls==0 && f.events.empty() && f.errors.empty());
}
void busyGuards(){
 struct Guard {const char* name;bool* value;};
 const Guard guards[]={
  {"boot background",&gBootBackgroundActive},{"pending G0",&gG0VoicePending},
  {"recording",&gRecording},{"submitting",&gSubmitting},{"thinking",&gThinking},
  {"playback",&gPlaybackActive},{"realtime",&gRealtimeActive},
  {"pending realtime",&gPendingRealtimeStart},{"realtime dial worker",&gRealtimeDialBusy},
  {"inbox worker",&gInboxHttpBusy},{"voice dial worker",&gVoiceDialBusy},
  {"speech worker",&gVoiceReplySpeechBusy},{"OTA apply",&gOtaApplyInProgress},
  {"transfer",&gTransferUiActive}
 };
 for(const auto& guard:guards){
  reset();gNetworkRecovery.streamLost(0);*guard.value=true;
  maintainConnectivity();
  if(f.reconnectCalls){std::fprintf(stderr,"Busy guard failed: %s\n",guard.name);assert(false);}
  assert(gWifiReady && gLastWifiReconnectMs==17 && f.statuses.empty());
  *guard.value=false;
  maintainConnectivity();assertScheduledOnce(); // Same time: token was not consumed.
 }
 reset();gNetworkRecovery.streamLost(0);gTextTurnTaskHandle=reinterpret_cast<void*>(uintptr_t{1});
 maintainConnectivity();assert(f.reconnectCalls==0 && gLastWifiReconnectMs==17);
 gTextTurnTaskHandle=nullptr;maintainConnectivity();assertScheduledOnce();
 reset();gNetworkRecovery.streamLost(0);gPendingTextTurns.push_back(1);
 maintainConnectivity();assert(f.reconnectCalls==0 && gLastWifiReconnectMs==17);
 gPendingTextTurns.clear();maintainConnectivity();assertScheduledOnce();
 reset();gNetworkRecovery.streamLost(0);gSetupPortalActive=true;
 maintainConnectivity();assert(f.portalCalls==1 && f.statusReads==0 && f.reconnectCalls==0);
 gSetupPortalActive=false;maintainConnectivity();assertScheduledOnce();
 std::puts("PASS actual maintainConnectivity: every busy flag, text worker/queue and setup portal defer without consuming recovery");
}
void stalledAssociated(){
 reset();threeFailures(gNetworkRecovery,0);f.now=999;
 maintainConnectivity();assert(f.reconnectCalls==0 && gWifiReady && gLastWifiReconnectMs==17);
 f.now=1000;maintainConnectivity();assertScheduledOnce();
 // A still-associated radio is not successful HTTP: it must not rearm recovery.
 for(uint32_t hour=1;hour<=48;++hour){
  f.now=1000U+hour*3600000U;gNetworkRecovery.failure(f.now);
  maintainConnectivity();
 }
 assert(f.reconnectCalls==1 && gLastWifiReconnectMs==1000);
 std::puts("PASS actual maintainConnectivity: associated stalled link reconnects once after grace, updates readiness/timestamp and stays bounded without application success");
}
void rejectedReconnect(){
 reset();f.reconnectResult=false;gNetworkRecovery.streamLost(0);
 maintainConnectivity();
 assert(f.reconnectCalls==1 && gLastWifiReconnectMs==1000 && gWifiReady);
 assert(f.statuses.empty() && f.events.empty()); // No claim that scheduling succeeded.
 for(uint32_t step=1;step<=20;++step){
  f.now=1000U+step*10000U;gNetworkRecovery.streamLost(f.now);maintainConnectivity();
 }
 assert(f.reconnectCalls==1 && gLastWifiReconnectMs==1000);
 std::puts("PASS actual maintainConnectivity: reconnect=false consumes one bounded attempt, without a false reconnecting status");
}
void zeroAddress(){
 reset();gNetworkRecovery.streamLost(0);gWifiReady=false;f.hasIP=false;
 // Avoid exercising the pre-existing disconnected retry interval in this test.
 gLastWifiReconnectMs=f.now;
 maintainConnectivity();
 assert(!gWifiReady && f.reconnectCalls==0 && f.statuses.empty() && f.events.empty());
 assert(f.ntpCalls==0 && f.wsCalls==0);
 f.hasIP=true;maintainConnectivity();assertScheduledOnce();
 std::puts("PASS actual maintainConnectivity: WL_CONNECTED with zero IP is not reported restored and does not spend the associated-recovery token");
}
} // namespace integration

int main(){
 thresholdAndGrace();busyAndAssociation();boundedOutage();
 successAndCooldown();clockWrap();independentInstances();
 integration::busyGuards();integration::stalledAssociated();
 integration::rejectedReconnect();integration::zeroAddress();
}
'''


def extract_function(text, signature):
    start = text.index(signature)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', action='store_true', help='Enable compiler AddressSanitizer and UBSan')
    args = parser.parse_args()
    header_dir = ROOT / 'bots/CardputerADV/src'
    if not (header_dir / 'network_recovery.h').is_file():
        raise SystemExit('Production network_recovery.h is missing from this checkout.')
    flags = ['-std=c++17', '-Wall', '-Wextra', '-Werror']
    if args.sanitize:
        flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer']
    source = (header_dir / 'main_parts/043_main.cpp.inc').read_text()
    constants = (header_dir / 'main_parts/001_main.cpp.inc').read_text()
    interval = re.search(r'constexpr uint32_t kWifiReconnectIntervalMs\s*=\s*\d+;', constants)
    if not interval:
        raise SystemExit('Wi-Fi reconnect interval declaration changed; review the extraction.')
    code = CPP + CPP_INTEGRATION + interval.group() + '\n'
    code += extract_function(source, 'void maintainConnectivity()') + CPP_INTEGRATION_TESTS
    with tempfile.TemporaryDirectory(prefix='s1-network-recovery-') as directory:
        cpp = Path(directory) / 'test.cpp'
        binary = Path(directory) / 'test'
        cpp.write_text(code)
        subprocess.run([os.environ.get('CXX', 'c++'), *flags, '-I', str(header_dir),
                        str(cpp), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
    print('Scope: production policy + actual connectivity guards/calls with simulated Wi-Fi; physical transport recovery needs device acceptance.')


if __name__ == '__main__':
    main()
