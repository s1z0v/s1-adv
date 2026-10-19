#!/usr/bin/env python3
"""Execute production Realtime ring/accept/reset/recording functions offline.

The PCM storage declaration, constants and tested functions are extracted from
the firmware. Speaker/Mic, time, queue refill and cancellation are controlled
fixtures. This checks byte ownership, bounds and half-duplex ordering, not ESP32
heap fragmentation, asynchronous DMA lifetime, Wi-Fi or physical acceptance.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "bots/CardputerADV/src/main_parts"


def function(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    end, depth = opening + 1, 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


PREAMBLE = r'''
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <vector>
using std::min;
using String=std::string;
enum class FaceMode {Error,Thinking,Speaking,Listening};
enum class Event {Attempt,Allocated,Freed,SpeakerStop,MicStop,MicStart};
std::array<Event,128> events{};
size_t eventCount=0;
void event(Event value){assert(eventCount<events.size());events[eventCount++]=value;}
size_t eventIndex(Event value){
 for(size_t i=0;i<eventCount;++i){if(events[i]==value)return i;}
 assert(false && "expected lifetime event missing");return 0;
}
uint32_t clockMs=100;
uint32_t millis(){return clockMs;}
unsigned delayCalls=0;
void delay(unsigned ms){assert(ms==1);clockMs+=ms;++delayCalls;}
template<class... Args>void logf(const char*,Args...){ }
template<class... Args>void setStatus(const char*,Args...){ }
void setVoiceDiag(const char*){ }
void appendRuntimeLog(const char*,const char*,bool){ }
FaceMode lastFace=FaceMode::Error;
unsigned speakingFaces=0;
void setFaceMode(FaceMode mode){lastFace=mode;if(mode==FaceMode::Speaking)++speakingFaces;}
struct FakeESP {size_t getFreeHeap(){return 65536;}} ESP;
constexpr unsigned MALLOC_CAP_8BIT=0;
size_t heap_caps_get_largest_free_block(unsigned){return 32768;}
struct FakeMic {unsigned ends=0;void end(){++ends;event(Event::MicStop);}};
struct FakeSpeaker {unsigned stops=0;void stop(){++stops;event(Event::SpeakerStop);}};
struct {FakeMic Mic;FakeSpeaker Speaker;} M5Cardputer;
struct RealtimeChunkQueue {
 unsigned count=0;
 void clear(){count=0;}
 bool empty()const{return count==0;}
 size_t size()const{return count;}
};
struct {unsigned resets=0;void reset(){++resets;}} gMicInputMeter;
bool gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
void serviceRealtimePlayback();
void serviceRealtimeRecording(bool);
void failRealtimeSession(const char*);
void startRealtimeSession(bool);
void startRealtimeMic();
void initSpeaker(){ }
void pulseButtonPress(){ }
'''

FIXTURES = r'''
size_t attempts=0,frees=0,liveBytes=0;
void* liveRing=nullptr;
bool denyNextArray=false;
void* operator new[](std::size_t bytes,const std::nothrow_t&)noexcept{
 ++attempts;event(Event::Attempt);
 assert(bytes==kRealtimePlaybackRingBytes && !liveRing && liveBytes==0);
 assert(!gRealtimeRecording && "PCM allocation must follow Mic stop");
 if(denyNextArray){denyNextArray=false;return nullptr;}
 void* p=std::malloc(bytes);
 if(p){liveRing=p;liveBytes=bytes;event(Event::Allocated);}
 return p;
}
void operator delete[](void* p)noexcept{
 if(!p)return;
 assert(p==liveRing && liveBytes==kRealtimePlaybackRingBytes);
 ++frees;event(Event::Freed);liveRing=nullptr;liveBytes=0;std::free(p);
}
void operator delete[](void* p,std::size_t)noexcept{::operator delete[](p);}
void operator delete[](void* p,const std::nothrow_t&)noexcept{::operator delete[](p);}
size_t drainBytes=0,serviceCalls=0,cancelAtService=0,maxBuffered=0;
unsigned failures=0,micStarts=0,sessionStarts=0;
bool failMicQueue=false,cancelDuringMicDrain=false;
String failureReason;
std::vector<uint8_t> played;
void resetRealtimePlaybackState(bool);
size_t readRealtimePlaybackRing(uint8_t*,size_t);
void failRealtimeSession(const char* reason){
 ++failures;failureReason=reason;
 gRealtimeActive=false;gRealtimeConnected=false;gRealtimeRecording=false;
 // Model cancellation through the actual reset primitive. Full session close
 // and hardware callbacks are deliberately outside this fixture's scope.
 resetRealtimePlaybackState(true);
}
void serviceRealtimePlayback(){
 ++serviceCalls;
 assert(gRealtimePlaybackBufferedBytes<=kRealtimePlaybackRingBytes);
 maxBuffered=std::max(maxBuffered,gRealtimePlaybackBufferedBytes);
 if(cancelAtService && serviceCalls==cancelAtService){
  gRealtimeActive=false;resetRealtimePlaybackState(true);return;
 }
 if(drainBytes && gRealtimePlaybackBufferedBytes){
  assert(gRealtimePlaybackRing);
  std::array<uint8_t,1024> out{};
  const size_t length=min({drainBytes,out.size(),gRealtimePlaybackBufferedBytes});
  const size_t read=readRealtimePlaybackRing(out.data(),length);
  assert(read==length);played.insert(played.end(),out.begin(),out.begin()+read);
 }
}
void serviceRealtimeRecording(bool refill){
 if(!refill){
  assert(!gRealtimeRecording && !gRealtimePlaybackRing && liveBytes==0);
  assert(!gRealtimeVadStopPending);
  if(cancelDuringMicDrain)gRealtimeActive=false;
  return;
 }
 if(!failMicQueue)gRealtimeInflightChunks.count=2;
}
void startRealtimeMic(){
 assert(gRealtimeRecording && !gRealtimePlaybackRing && liveBytes==0);
 ++micStarts;event(Event::MicStart);
}
void startRealtimeSession(bool automatic){assert(automatic);++sessionStarts;}
'''

TESTS = r'''
std::vector<uint8_t> bytes(size_t count,unsigned salt=0){
 std::vector<uint8_t> out(count);
 for(size_t i=0;i<count;++i)out[i]=static_cast<uint8_t>((i*37+i/113+salt*11)&255);
 return out;
}
void clean(){
 resetRealtimePlaybackState(false);
 assert(!gRealtimePlaybackRing && !liveRing && liveBytes==0);
 eventCount=0;attempts=frees=0;denyNextArray=false;
 clockMs=100;delayCalls=0;serviceCalls=cancelAtService=maxBuffered=drainBytes=0;
 failures=micStarts=sessionStarts=0;failMicQueue=cancelDuringMicDrain=false;
 failureReason.clear();played.clear();speakingFaces=0;
 M5Cardputer.Mic.ends=M5Cardputer.Speaker.stops=0;
 gRealtimeActive=gRealtimeConnected=true;gRealtimeRecording=false;
 gRealtimeVadStopPending=gRealtimeGotAudio=gRealtimeAwaiting=false;
 gRealtimeHandsFreeActive=gRealtimeRestartAfterPlayback=false;
 gRecording=gSubmitting=gThinking=gPlaybackActive=false;
 gRealtimeInflightChunks.clear();gRealtimeText.clear();
}
void checkReset(){
 assert(!gRealtimePlaybackRing && !liveRing && liveBytes==0);
 assert(!gRealtimePlaybackActive && !gRealtimePlaybackFeeding && !gRealtimePlaybackEverStarted);
 assert(!gRealtimeAudioComplete && !gRealtimeResponseComplete);
 assert(gRealtimePlaybackRead==0 && gRealtimePlaybackWrite==0 && gRealtimePlaybackBufferedBytes==0);
 assert(gRealtimePlaybackDroppedBytes==0 && gRealtimePlaybackNextBuffer==0 && gRealtimeReplyBytes==0);
 assert(gRealtimeLatencyOriginMs==0 && gRealtimeFirstAudioDeltaMs==0 && gRealtimeLastAudioDeltaMs==0);
 assert(gRealtimePlaybackStartMs==0 && gRealtimePlaybackProgressMs==0 && gRealtimeAudioDoneMs==0);
}
void lazyAndInvalid(){
 assert(!gRealtimePlaybackRing && attempts==0 && liveBytes==0);
 clean();const auto input=bytes(64);
 gRealtimeRecording=true;gRealtimeVadStopPending=true;
 for(const auto length:{size_t(0),size_t(1),size_t(3)}){
  assert(!acceptRealtimePcmBytes(input.data(),length));
 }
 assert(!acceptRealtimePcmBytes(nullptr,2));
 assert(attempts==0 && !gRealtimePlaybackRing && !gRealtimeGotAudio);
 assert(gRealtimeRecording && gRealtimeVadStopPending && M5Cardputer.Mic.ends==0);
 gRealtimeRecording=false;gRealtimeVadStopPending=false;
 assert(acceptRealtimePcmBytes(input.data(),input.size()));
 auto* const address=gRealtimePlaybackRing.get();
 assert(address && attempts==1 && liveBytes==kRealtimePlaybackRingBytes);
 assert(gRealtimeReplyBytes==input.size() && gRealtimePlaybackBufferedBytes==input.size());
 assert(gRealtimeGotAudio && gRealtimeFirstAudioDeltaMs==100 && speakingFaces==1);
 clockMs=123;
 assert(acceptRealtimePcmBytes(input.data(),input.size()));
 assert(attempts==1 && gRealtimePlaybackRing.get()==address && speakingFaces==1);
 assert(gRealtimeLastAudioDeltaMs==123 && gRealtimeReplyBytes==2*input.size());
 std::array<uint8_t,256> output{};
 assert(readRealtimePlaybackRing(output.data(),output.size())==2*input.size());
 assert(std::equal(input.begin(),input.end(),output.begin()));
 assert(std::equal(input.begin(),input.end(),output.begin()+input.size()));
 output.fill(0xA5);
 assert(readRealtimePlaybackRing(output.data(),output.size())==0 && output[0]==0xA5);
 assert(writeRealtimePlaybackRing(nullptr,8)==0 && writeRealtimePlaybackRing(input.data(),0)==0);
 resetRealtimePlaybackState(false);assert(frees==1);checkReset();
 std::puts("PASS no startup/empty/odd/null allocation; first valid PCM allocates exactly once and preserves bytes");
}
void wrapAndCapacity(){
 clean();const auto seed=bytes(2);assert(acceptRealtimePcmBytes(seed.data(),seed.size()));
 resetRealtimePlaybackState(false);
 // Allocate through the actual entry point, then begin with empty cursors.
 assert(acceptRealtimePcmBytes(seed.data(),seed.size()));
 std::array<uint8_t,2> discard{};assert(readRealtimePlaybackRing(discard.data(),2)==2);
 gRealtimePlaybackRead=gRealtimePlaybackWrite=0;
 const auto input=bytes(kRealtimePlaybackRingBytes+258,4);
 std::vector<uint8_t> output(input.size());
 const size_t first=kRealtimePlaybackRingBytes-4;
 assert(writeRealtimePlaybackRing(input.data(),first)==first);
 assert(readRealtimePlaybackRing(output.data(),first-6)==first-6);
 assert(std::equal(input.begin(),input.begin()+first-6,output.begin()));
 assert(writeRealtimePlaybackRing(input.data()+first,20)==20);
 assert(gRealtimePlaybackWrite==16 && gRealtimePlaybackBufferedBytes==26);
 assert(readRealtimePlaybackRing(output.data(),26)==26);
 assert(std::equal(input.begin()+first-6,input.begin()+first+20,output.begin()));
 std::deque<uint8_t> expected;
 uint32_t random=0xC0FFEE12U;
 auto next=[&](){random^=random<<13;random^=random>>17;random^=random<<5;return random;};
 size_t dropped=0;
 for(unsigned i=0;i<1500;++i){
  const size_t length=next()%input.size();
  if(next()&1U){
   const size_t count=min(length,kRealtimePlaybackRingBytes-expected.size());
   assert(writeRealtimePlaybackRing(input.data(),length)==count);
   expected.insert(expected.end(),input.begin(),input.begin()+count);dropped+=length-count;
  }else{
   const size_t count=min(length,expected.size());
   output.assign(output.size(),0xA5);
   assert(readRealtimePlaybackRing(output.data(),length)==count);
   for(size_t j=0;j<count;++j){assert(output[j]==expected.front());expected.pop_front();}
   if(count<output.size())assert(output[count]==0xA5);
  }
  assert(gRealtimePlaybackBufferedBytes==expected.size() && gRealtimePlaybackDroppedBytes==dropped);
  assert(gRealtimePlaybackRead<kRealtimePlaybackRingBytes && gRealtimePlaybackWrite<kRealtimePlaybackRingBytes);
 }
 assert(attempts==2 && frees==1 && liveBytes==kRealtimePlaybackRingBytes);
 std::puts("PASS exact wraparound, full-capacity bounds/drop accounting and 1500 deterministic FIFO operations");
}
void burstAndBackpressure(){
 clean();drainBytes=1024;
 const auto input=bytes(3*kRealtimePlaybackRingBytes+246,8);
 const auto preserved=input;
 assert(acceptRealtimePcmBytes(input.data(),input.size()));
 assert(input==preserved && attempts==1 && failures==0);
 assert(gRealtimeReplyBytes==input.size() && gRealtimePlaybackDroppedBytes==0);
 assert(maxBuffered<=kRealtimePlaybackRingBytes && serviceCalls<100);
 while(gRealtimePlaybackBufferedBytes)serviceRealtimePlayback();
 assert(played==input && liveBytes==kRealtimePlaybackRingBytes);
 for(const uint32_t start:{100U,std::numeric_limits<uint32_t>::max()-10U}){
  clean();clockMs=start;
  const auto full=bytes(kRealtimePlaybackRingBytes);
  assert(acceptRealtimePcmBytes(full.data(),full.size()));
  const uint32_t began=millis();
  assert(!acceptRealtimePcmBytes(full.data(),2));
  assert(failures==1 && failureReason=="Audio stream stalled");
  assert(static_cast<uint32_t>(millis()-began)==kRealtimeStreamStallTimeoutMs+1);
  assert(delayCalls==kRealtimeStreamStallTimeoutMs+1 && attempts==1 && frees==1);
  checkReset();
 }
 std::puts("PASS bursts larger than the ring drain without loss; stalled playback times out and frees memory across clock wrap");
}
void allocationAndCancellation(){
 clean();const auto input=bytes(kRealtimePlaybackRingBytes+10);
 denyNextArray=true;
 assert(!acceptRealtimePcmBytes(input.data(),2));
 assert(attempts==1 && frees==0 && failures==1 && !gRealtimeGotAudio);
 assert(failureReason=="Not enough memory for reply audio");checkReset();
 for(const size_t when:{size_t(1),size_t(2)}){
  clean();cancelAtService=when;
  assert(!acceptRealtimePcmBytes(input.data(),input.size()));
  assert(serviceCalls==when && attempts==1 && frees==1 && failures==0);
  checkReset();
 }
 clean();gRealtimeRecording=true;gRealtimeVadStopPending=true;cancelDuringMicDrain=true;
 assert(!acceptRealtimePcmBytes(input.data(),2));
 assert(!gRealtimeActive && !gRealtimeRecording && !gRealtimeVadStopPending);
 assert(M5Cardputer.Mic.ends==1 && attempts==0 && failures==0);
 assert(!gRealtimePlaybackRing && liveBytes==0 && gRealtimePlaybackBufferedBytes==0);
 assert(gRealtimeReplyBytes==0 && gRealtimeFirstAudioDeltaMs==0);
 // The actual VAD stop still stamps its latency origin after the controlled
 // cancellation; only buffer ownership is promised by the entry-point guard.
 resetRealtimePlaybackState(false);checkReset();
 std::puts("PASS failed allocation and cancellation before/after partial copy leave no live ring or subsequent writes");
}
void resetOwnership(){
 const auto input=bytes(4);
 for(unsigned mask=0;mask<8;++mask){
  clean();assert(acceptRealtimePcmBytes(input.data(),input.size()));
  const bool stop=(mask&1U)!=0,active=(mask&2U)!=0,ever=(mask&4U)!=0;
  gRealtimePlaybackActive=active;gRealtimePlaybackEverStarted=ever;
  gRealtimePlaybackFeeding=gRealtimeAudioComplete=gRealtimeResponseComplete=true;
  gRealtimePlaybackDroppedBytes=17;gRealtimePlaybackNextBuffer=1;
  gRealtimeLatencyOriginMs=gRealtimeFirstAudioDeltaMs=gRealtimeLastAudioDeltaMs=41;
  gRealtimePlaybackStartMs=gRealtimePlaybackProgressMs=gRealtimeAudioDoneMs=42;
  resetRealtimePlaybackState(stop);checkReset();
  assert(frees==1 && M5Cardputer.Speaker.stops==unsigned(stop&&(active||ever)));
  if(stop&&(active||ever))assert(eventIndex(Event::SpeakerStop)<eventIndex(Event::Freed));
  resetRealtimePlaybackState(stop);assert(frees==1);checkReset();
 }
 clean();assert(acceptRealtimePcmBytes(input.data(),input.size()));
 gRealtimeText="previous reply";resetRealtimeTurnState();
 assert(gRealtimeText.empty() && !gRealtimeGotAudio && frees==1);checkReset();
 std::puts("PASS reset releases once, clears all playback cursors/timestamps and optionally stops Speaker before free");
}
void recordingIntegration(){
 clean();const auto input=bytes(64,13);
 assert(acceptRealtimePcmBytes(input.data(),input.size()));
 for(unsigned turn=0;turn<3;++turn){
  eventCount=0;const size_t beforeFrees=frees,beforeAttempts=attempts;
  gRealtimeText="old response";gRealtimeVadStopPending=true;
  startRealtimeRecording();
  assert(frees==beforeFrees+1 && attempts==beforeAttempts && liveBytes==0);
  assert(eventIndex(Event::Freed)<eventIndex(Event::MicStart));
  assert(gRealtimeRecording && gRealtimeHandsFreeActive && !gRealtimeAwaiting);
  assert(gRealtimeInflightChunks.size()==2 && gRealtimeText.empty() && !gRealtimeGotAudio);
  assert(lastFace==FaceMode::Listening);
  eventCount=0;gRealtimeVadStopPending=true;
  assert(acceptRealtimePcmBytes(input.data(),input.size()));
  assert(eventIndex(Event::MicStop)<eventIndex(Event::Attempt));
  assert(!gRealtimeRecording && !gRealtimeVadStopPending && gRealtimeInflightChunks.empty());
  assert(attempts==beforeAttempts+1 && gRealtimeGotAudio && gRealtimeAwaiting);
  std::array<uint8_t,64> copied{};
  assert(readRealtimePlaybackRing(copied.data(),copied.size())==input.size());
  assert(std::equal(input.begin(),input.end(),copied.begin()));
 }
 for(unsigned gate=0;gate<6;++gate){
  clean();assert(acceptRealtimePcmBytes(input.data(),input.size()));
  if(gate==0)gRealtimeRecording=true;
  if(gate==1)gRecording=true;
  if(gate==2)gSubmitting=true;
  if(gate==3)gThinking=true;
  if(gate==4)gPlaybackActive=true;
  if(gate==5)gRealtimeConnected=false;
  startRealtimeRecording();
  assert(attempts==1 && frees==0 && micStarts==0 && gRealtimePlaybackRing);
  assert(sessionStarts==unsigned(gate==5));
 }
 clean();assert(acceptRealtimePcmBytes(input.data(),input.size()));
 failMicQueue=true;startRealtimeRecording();
 assert(micStarts==1 && failures==1 && failureReason=="Microphone start failed");
 assert(M5Cardputer.Mic.ends==1 && frees==1 && !gRealtimeRecording);checkReset();
 std::puts("PASS actual recording restart frees before Mic start; three PCM turns stop Mic before allocation, busy gates preserve ownership");
}
int main(){
 static_assert(kRealtimePlaybackRingBytes==16*1024,"Review PCM memory contract if capacity changes");
 lazyAndInvalid();wrapAndCapacity();burstAndBackpressure();allocationAndCancellation();
 resetOwnership();recordingIntegration();clean();
 std::puts("Scope: actual production functions with controlled audio/clock/queue/cancel fixtures; physical Wi-Fi, heap and DMA need device checks.");
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", action="store_true")
    args = parser.parse_args()
    playback = (PARTS / "041_main.cpp.inc").read_text()
    realtime = (PARTS / "042_main.cpp.inc").read_text()
    bodies = [function(playback, signature) for signature in (
        "void resetRealtimePlaybackState(", "void markRealtimeLatencyOrigin(",
        "size_t writeRealtimePlaybackRing(", "size_t readRealtimePlaybackRing(",
        "void stopRealtimeMicNonBlocking(", "void stopRealtimeRecordingForVad(",
        "void resetRealtimeTurnState(",
    )]
    bodies += [function(realtime, signature) for signature in (
        "void startRealtimeRecording(", "bool acceptRealtimePcmBytes(",
    )]
    declarations = (PARTS / "005_main.cpp.inc").read_text()
    globals_needed = set(re.findall(r"\bgRealtime\w+", "\n".join(bodies)))
    globals_needed.add("gVoiceLevel8")
    globals_source = []
    for name in sorted(globals_needed):
        matches = re.findall(rf"^[^\n;]*\b{re.escape(name)}\b[^\n;]*;", declarations, re.MULTILINE)
        if len(matches) != 1:
            raise SystemExit(f"Expected one production declaration for {name}, got {len(matches)}")
        globals_source.append(matches[0])
    constants = (PARTS / "001_main.cpp.inc").read_text()
    constants_needed = ("kRealtimePlaybackRingBytes", "kRealtimeStreamStallTimeoutMs",
                        "kRealtimeInputSampleRate", "kRealtimeInputChunkSamples")
    constant_source = []
    for name in constants_needed:
        match = re.search(rf"^constexpr[^\n]*\b{name}\b[^\n]*;", constants, re.MULTILINE)
        if not match:
            raise SystemExit(f"Production constant missing: {name}")
        constant_source.append(match[0])
    source = "\n".join([PREAMBLE, *constant_source, *globals_source, FIXTURES, *bodies, TESTS])
    flags = ["-std=c++17", "-Wall", "-Wextra", "-Werror"]
    if args.sanitize:
        flags += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
    with tempfile.TemporaryDirectory(prefix="s1-rt-audio-buffer-") as directory:
        temporary = Path(directory)
        cpp, binary = temporary / "test.cpp", temporary / "test"
        cpp.write_text(source)
        subprocess.run([os.environ.get("CXX", "c++"), *flags, str(cpp), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
