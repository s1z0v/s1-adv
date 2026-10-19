#!/usr/bin/env python3
"""Execute the portable capture sender with offline file/socket/clock fixtures.

The native run uses the actual header and std::atomic. A second run instruments
only the atomic type through a preprocessor namespace adapter to deterministically
schedule publication between its two loads. It tests ordering, not a CPU memory
model or the ESP32 filesystem/TLS integration. No device or network is used.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CPP = r'''
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <new>
#include <cassert>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#ifdef SCHEDULE_LOADS
namespace schedule {
inline void (*afterLoad)(const void*)=nullptr;
template<class T> struct Atomic {
 T value;
 constexpr Atomic(T initial):value(initial){}
 T load()const{const T snapshot=value;if(afterLoad)afterLoad(this);return snapshot;}
 void store(T next){value=next;}
};
}
namespace instrumented_std {
using std::unique_ptr;using std::nothrow;using std::min;using std::snprintf;
template<class T>using atomic=schedule::Atomic<T>;
}
// All standard headers above are already guarded. Production algorithm text
// stays unchanged; only its atomic loads receive the deterministic hook.
#define std instrumented_std
#include "capture_upload.h"
#undef std
#else
#include "capture_upload.h"
#endif
using capture_upload::State;
struct Fixture {
 State state;
 uint32_t clock=100;
 std::vector<uint8_t> input,wire;
 size_t maxWrite=99999,writes=0,waits=0,reads=0;
 size_t rejectAt=std::numeric_limits<size_t>::max();
 size_t closeAt=std::numeric_limits<size_t>::max();
 size_t respondAt=std::numeric_limits<size_t>::max();
 std::string incoming;
 uint32_t perWriteMs=0;
 bool online=true,shortRead=false,overreport=false,cancelAfterWrite=false,cancelAfterFooter=false;
 explicit Fixture(size_t n):input(n){for(size_t i=0;i<n;++i)input[i]=uint8_t(i*37+i/71);}
 bool connected(){return online;}
 int available(){return static_cast<int>(incoming.size());}
 size_t write(const uint8_t* data,size_t n){
  ++writes;
  const bool footer=n==5 && std::memcmp(data,"0\r\n\r\n",5)==0;
  if(footer)assert(state.finished.load() && state.sent.load()==state.published.load() && state.commitAttempted.load());
  if(overreport)return n+1;
  if(wire.size()>=rejectAt)return 0;
  const size_t count=std::min({n,maxWrite,rejectAt-wire.size()});
  wire.insert(wire.end(),data,data+count);
  clock+=perWriteMs;
  if(wire.size()>=closeAt)online=false;
  if(wire.size()>=respondAt)incoming="HTTP/1.1 413 Payload Too Large\r\n\r\n";
  if(cancelAfterWrite || (cancelAfterFooter && footer))state.cancelled.store(true);
  return count;
 }
 size_t read(size_t offset,uint8_t* data,size_t n){
  ++reads;assert(offset+n<=state.published.load() && offset+n<=input.size());
  const size_t count=shortRead?n-2:n;
  std::memcpy(data,input.data()+offset,count);return count;
 }
 template<class Wait>bool run(Wait wait,size_t limit=65536,uint32_t timeout=100){
  return capture_upload::sendBody(*this,state,
   [&](size_t at,uint8_t* data,size_t n){return read(at,data,n);},wait,[&](){return clock;},limit,timeout);
 }
 bool run(size_t limit=65536,uint32_t timeout=100){return run([&](){++waits;++clock;},limit,timeout);}
 void finish(){state.published.store(input.size());state.finished.store(true);}
};
std::vector<uint8_t> decode(const std::vector<uint8_t>& wire){
 size_t offset=0;std::vector<uint8_t> out;
 for(;;){
  const size_t begin=offset;
  while(offset<wire.size() && wire[offset]!='\r')++offset;
  assert(offset>begin && offset+1<wire.size() && wire[offset+1]=='\n');
  size_t size=0;
  for(size_t i=begin;i<offset;++i){
   const char c=char(wire[i]);
   assert((c>='0'&&c<='9') || (c>='a'&&c<='f'));
   size=size*16+size_t(c<='9'?c-'0':c-'a'+10);
  }
  offset+=2;assert(size<=4096 && offset+size+2<=wire.size());
  out.insert(out.end(),wire.begin()+offset,wire.begin()+offset+size);offset+=size;
  assert(wire[offset]=='\r' && wire[offset+1]=='\n');offset+=2;
  if(size==0){assert(offset==wire.size());return out;}
 }
}
void productionAndPartialWrites(){
 for(const size_t stride:{size_t(1),size_t(2),size_t(7),size_t(4096),size_t(99999)}){
  Fixture f(10002);f.maxWrite=stride;
  uint32_t released=0;
  assert(f.run([&](){
   ++f.waits;++f.clock;
   if(f.waits==1)f.state.published.store(2048);
   else {assert(f.state.sent.load()==2048 && !f.state.finished.load());released=f.clock;f.finish();}
  }));
  assert(f.waits==2 && f.state.sent.load()==f.input.size());
  assert(f.state.firstSentMs.load()!=0 && f.state.firstSentMs.load()<released);
  assert(f.state.commitAttempted.load() && decode(f.wire)==f.input);
 }
 std::puts("PASS delayed producer sends PCM before release, exact chunk decoding and 1/2/7/full partial socket writes");
}
void limitsAndInvalidReads(){
 Fixture exact(8192);exact.finish();assert(exact.run(size_t(8192)) && decode(exact.wire)==exact.input);
 Fixture tooBig(8194);tooBig.finish();assert(!tooBig.run(size_t(8192)));
 assert(tooBig.wire.empty() && !tooBig.state.commitAttempted.load());
 Fixture odd(4097);odd.finish();assert(!odd.run());
 assert(odd.state.sent.load()==4096 && !odd.state.commitAttempted.load());
 Fixture empty(0);empty.finish();assert(!empty.run() && empty.wire.empty());
 Fixture shortFile(40);shortFile.finish();shortFile.shortRead=true;
 assert(!shortFile.run() && shortFile.wire.empty() && !shortFile.state.commitAttempted.load());
 Fixture regressed(40);regressed.state.sent.store(42);regressed.finish();
 assert(!regressed.run() && regressed.wire.empty());
 Fixture invalidSocket(4);invalidSocket.finish();invalidSocket.overreport=true;
 assert(!invalidSocket.run() && !invalidSocket.state.commitAttempted.load());
 Fixture grew(10);grew.state.published.store(4);
 assert(!grew.run([&](){grew.state.published.store(10);},8));
 assert(grew.state.sent.load()==4 && !grew.state.commitAttempted.load());
 std::puts("PASS exact maximum, oversized/odd/empty publication, regressed length, short file read and invalid write count fail closed");
}
void cancelClosedTimeout(){
 Fixture cancelled(4);cancelled.finish();cancelled.state.cancelled.store(true);
 assert(!cancelled.run() && cancelled.writes==0 && !cancelled.state.commitAttempted.load());
 Fixture closed(4);closed.finish();closed.online=false;
 assert(!closed.run() && closed.writes==0 && !closed.state.commitAttempted.load());
 Fixture partial(64);partial.finish();partial.maxWrite=1;partial.rejectAt=8;
 assert(!partial.run() && partial.state.sent.load()==0 && !partial.state.commitAttempted.load());
 Fixture during(64);during.finish();during.cancelAfterWrite=true;
 assert(!during.run() && !during.state.commitAttempted.load());
 Fixture lost(64);lost.finish();lost.maxWrite=1;lost.closeAt=5;
 assert(!lost.run() && !lost.state.commitAttempted.load());
 Fixture pending(4);
 assert(!pending.run([&](){++pending.waits;pending.state.cancelled.store(true);}));
 assert(pending.waits==1 && pending.wire.empty() && !pending.state.commitAttempted.load());
 for(const uint32_t start:{100U,std::numeric_limits<uint32_t>::max()-2U}){
  Fixture timeout(4);timeout.clock=start;
  assert(!timeout.run(size_t(65536),5));
  assert(timeout.waits==5 && uint32_t(timeout.clock-start)==5 && !timeout.state.commitAttempted.load());
  Fixture slow(64);slow.clock=start;slow.finish();slow.maxWrite=1;slow.perWriteMs=1;
  assert(!slow.run(size_t(65536),5));
  assert(uint32_t(slow.clock-start)==5 && slow.state.sent.load()==0 && !slow.state.commitAttempted.load());
 }
 std::puts("PASS precommit cancel/closed socket/partial failure/wait cancellation and bounded timeout across uint32 wrap");
}
void commitFence(){
 for(const size_t footerBytes:{size_t(0),size_t(1),size_t(4)}){
  Fixture f(4);f.finish();f.rejectAt=9+footerBytes;
  assert(!f.run() && f.state.sent.load()==4 && f.state.commitAttempted.load());
  assert(f.wire.size()==9+footerBytes);
 }
 // The final write can reach the peer while local cancellation is reported.
 // The caller must retain commitAttempted and must not automatically POST again.
 Fixture final(4);final.finish();final.cancelAfterFooter=true;
 assert(!final.run() && final.state.commitAttempted.load() && decode(final.wire)==final.input);
 Fixture notReleased(4);notReleased.state.published.store(4);
 assert(!notReleased.run(size_t(65536),5));
 assert(notReleased.state.sent.load()==4 && !notReleased.state.commitAttempted.load());
 assert(notReleased.wire.size()==9);
 std::puts("PASS zero chunk only after finished and full tail; commitAttempted stays set before any final-chunk write, including failures");
}
void earlyResponse(){
 for(const int code:{401,413,429,507}){
  Fixture f(4);f.incoming="HTTP/1.1 "+std::to_string(code)+" Fixture\r\n\r\n";
  const auto original=f.incoming;
  assert(!f.run() && f.writes==0 && !f.state.finished.load());
  assert(f.state.responseAvailable.load() && !f.state.commitAttempted.load() && f.incoming==original);
 }
 Fixture duringWait(4);duringWait.state.published.store(4);
 assert(!duringWait.run([&](){duringWait.incoming="HTTP/1.1 429 Fixture\r\n\r\n";}));
 assert(duringWait.state.sent.load()==4 && duringWait.wire.size()==9);
 assert(duringWait.state.responseAvailable.load() && !duringWait.state.commitAttempted.load());
 Fixture duringWrite(64);duringWrite.state.published.store(64);duringWrite.maxWrite=1;duringWrite.respondAt=5;
 assert(!duringWrite.run() && duringWrite.wire.size()==5 && duringWrite.state.sent.load()==0);
 assert(duringWrite.state.responseAvailable.load() && !duringWrite.state.commitAttempted.load());
 std::puts("PASS early HTTP bytes before release stop header/body transmission without zero chunk and remain unread for response parsing");
}
#ifdef SCHEDULE_LOADS
State* racing=nullptr;
bool scheduled=false;
const void* firstSnapshot=nullptr;
void publishDuringSnapshot(const void* address){
 if(scheduled || (address!=&racing->finished && address!=&racing->published))return;
 scheduled=true;firstSnapshot=address;
 racing->published.store(8);racing->finished.store(true);
}
void snapshotRace(){
 Fixture f(8);f.state.published.store(4);f.state.sent.store(4);
 f.wire={'4','\r','\n',f.input[0],f.input[1],f.input[2],f.input[3],'\r','\n'};
 racing=&f.state;schedule::afterLoad=publishDuringSnapshot;
 const bool result=f.run();schedule::afterLoad=nullptr;
 assert(result && scheduled && firstSnapshot==&f.state.finished);
 assert(f.state.sent.load()==8 && decode(f.wire)==f.input && f.state.commitAttempted.load());
 std::puts("PASS deterministic release between snapshots cannot commit before the final published PCM tail");
}
#endif
int main(){
 productionAndPartialWrites();limitsAndInvalidReads();cancelClosedTimeout();commitFence();earlyResponse();
#ifdef SCHEDULE_LOADS
 snapshotRace();
#endif
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", action="store_true")
    args = parser.parse_args()
    flags = ["-std=c++17", "-Wall", "-Wextra", "-Werror"]
    if args.sanitize:
        flags += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
    with tempfile.TemporaryDirectory(prefix="s1-capture-upload-") as directory:
        temporary = Path(directory)
        cpp = temporary / "test.cpp"
        cpp.write_text(CPP)
        for scheduled in (False, True):
            binary = temporary / ("scheduled" if scheduled else "native")
            mode = ["-DSCHEDULE_LOADS"] if scheduled else []
            subprocess.run([os.environ.get("CXX", "c++"), *flags, *mode, "-I",
                            str(ROOT / "bots/CardputerADV/src"), str(cpp), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)
    print("Scope: native actual header and deterministic atomic-load instrumentation; caller retry fencing, SD mutex and physical TLS need integration checks.")


if __name__ == "__main__":
    main()
