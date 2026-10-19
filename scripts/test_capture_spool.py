#!/usr/bin/env python3
"""Run actual SD-spool integration helpers with offline File/FS/socket fixtures.

The real capture_upload header, VoiceCaptureUpload declaration, file-lock helper
and stream/publish/finish/producer functions are compiled. File storage models buffered
writes, flushed size and shared w+ cursors. A second thread probes the real mutex
at each controlled file/socket operation. This does not emulate an SD driver or
prove physical concurrency, TLS behavior or audio capture timing.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PARTS = ROOT / "bots/CardputerADV/src/main_parts"


def block(source, signature):
    start = source.index(signature)
    end = source.index("{", start) + 1
    depth = 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


PREAMBLE = r'''
#include "capture_upload.h"
#include <cassert>
#include <cstring>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
using std::min;
struct String:std::string {
 String()=default;
 using std::string::string;
 using std::string::operator=;
 explicit String(unsigned value):std::string(std::to_string(value)){}
};
bool gRecording=true;
enum class FaceMode {Error};
void setFaceMode(FaceMode){ }
void setStatus(const char*,unsigned){ }
void setHttpDiag(const std::string&){ }
void updateVoiceLevelFromSamples(const int16_t*,size_t){ }
uint32_t clockMs=100;
std::function<void()> tick;
uint32_t millis(){return clockMs;}
void delay(unsigned ms){assert(ms==2);clockMs+=ms;if(tick)tick();}
template<class... Args>void logf(const char*,Args...){ }
bool mutexFree(std::mutex* mutex){
 if(!mutex)return true;
 bool available=false;
 std::thread observer([&](){available=mutex->try_lock();if(available)mutex->unlock();});
 observer.join();return available;
}
struct Disk {
 std::vector<uint8_t> bytes=std::vector<uint8_t>(44,0xEE);
 size_t flushed=44;
 unsigned flushes=0,reads=0,seeks=0,opens=0,closes=0,deletedReads=0,writes=0;
 unsigned liveReadHandles=0,maxReadHandles=0;
 std::mutex* mutex=nullptr;
 bool removed=false,failFlush=false,shortRead=false,failOpen=false,failRestoreOnce=false;
 std::function<void()> onFlush;
 void locked()const{assert(mutex && !mutexFree(mutex));}
};
struct Handle {std::shared_ptr<Disk> disk;size_t position=0;bool open=true,readOnly=false;};
class File {
 std::shared_ptr<Handle> handle;
 public:
 File()=default;
 explicit File(std::shared_ptr<Disk> disk,size_t position=0,bool readOnly=false):handle(std::make_shared<Handle>()){
  handle->disk=std::move(disk);handle->position=position;handle->readOnly=readOnly;
  if(readOnly){++handle->disk->liveReadHandles;handle->disk->maxReadHandles=std::max(handle->disk->maxReadHandles,handle->disk->liveReadHandles);}
 }
 explicit operator bool()const{return handle && handle->open;}
 size_t cursorForTest()const{return handle->position;}
 size_t position()const{handle->disk->locked();return handle->position;}
 bool seek(size_t position){
  if(!*this)return false;
  auto& disk=*handle->disk;disk.locked();++disk.seeks;
  if(position>disk.bytes.size())return false;
  if(disk.failRestoreOnce && position==disk.bytes.size() && handle->position!=position){disk.failRestoreOnce=false;return false;}
  handle->position=position;return true;
 }
 int read(uint8_t* output,size_t count){
  assert(*this);auto& disk=*handle->disk;disk.locked();++disk.reads;
  if(disk.removed){++disk.deletedReads;return -1;}
  assert(handle->position>=44 && handle->position+count<=disk.flushed);
  if(disk.shortRead)count-=2;
  std::memcpy(output,disk.bytes.data()+handle->position,count);handle->position+=count;
  return static_cast<int>(count);
 }
 size_t write(const uint8_t* input,size_t count){
  assert(*this);auto& disk=*handle->disk;disk.locked();assert(!disk.removed);++disk.writes;
  const size_t end=handle->position+count;
  if(end>disk.bytes.size())disk.bytes.resize(end);
  std::memcpy(disk.bytes.data()+handle->position,input,count);handle->position=end;return count;
 }
 void flush(){
  assert(*this);auto& disk=*handle->disk;disk.locked();++disk.flushes;
  if(disk.onFlush)disk.onFlush();
  if(!disk.failFlush)disk.flushed=disk.bytes.size();
 }
 size_t size()const{handle->disk->locked();return handle->disk->flushed;}
 void close(){if(*this){handle->disk->locked();++handle->disk->closes;
  if(handle->readOnly){assert(handle->disk->liveReadHandles>0);--handle->disk->liveReadHandles;}
  handle->open=false;}}
};
namespace fs {
struct FS {
 std::shared_ptr<Disk> disk;
 File open(const String& path,const char* mode){
  disk->locked();++disk->opens;assert(path=="/voice/fixture.wav" && std::strcmp(mode,"r")==0);
  if(disk->removed || disk->failOpen)return {};
  return File(disk,0,true);
 }
};
}
struct WiFiClient {
 std::mutex* mutex=nullptr;
 std::vector<uint8_t> wire;
 std::vector<unsigned> timeouts;
 size_t stride=257;
 bool online=true;
 std::function<void()> onWrite;
 void setTimeout(unsigned seconds){timeouts.push_back(seconds);}
 bool connected(){return online;}
 int available(){return 0;}
 size_t write(const uint8_t* input,size_t count){
  assert(mutexFree(mutex) && "socket write retained the capture file mutex");
  if(onWrite)onWrite();
  const size_t size=std::min(stride,count);wire.insert(wire.end(),input,input+size);return size;
 }
};
'''

TESTS = r'''
const String headers="POST /fixture HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
std::vector<uint8_t> payload(size_t bytes,unsigned salt=0){
 std::vector<uint8_t> data(bytes);
 for(size_t i=0;i<bytes;++i)data[i]=uint8_t(i*31+i/67+salt*3);
 return data;
}
std::vector<uint8_t> decoded(const std::vector<uint8_t>& wire){
 assert(wire.size()>=headers.size() && std::equal(headers.begin(),headers.end(),wire.begin()));
 size_t at=headers.size();std::vector<uint8_t> data;
 for(;;){
  size_t size=0,begin=at;
  while(at<wire.size() && wire[at]!='\r'){
   const char c=char(wire[at++]);assert((c>='0'&&c<='9') || (c>='a'&&c<='f'));
   size=size*16+size_t(c<='9'?c-'0':c-'a'+10);
  }
  assert(at>begin && at+1<wire.size() && wire[at+1]=='\n');at+=2;
  assert(at+size+2<=wire.size());data.insert(data.end(),wire.begin()+at,wire.begin()+at+size);at+=size;
  assert(wire[at]=='\r' && wire[at+1]=='\n');at+=2;
  if(!size){assert(at==wire.size());return data;}
 }
}
struct Fixture {
 std::shared_ptr<Disk> disk=std::make_shared<Disk>();
 fs::FS fs{disk};
 std::shared_ptr<VoiceCaptureUpload> capture=std::make_shared<VoiceCaptureUpload>();
 WiFiClient client;
 Fixture(){
  tick={};clockMs=100;gActiveRecordBytes=0;gActiveRecordCommittedBytes=0;gVoiceCaptureUpload=capture;
  gRecording=true;gRecordFileWriteFailed=false;gRecordInflightChunks.clear();
  disk->mutex=&capture->fileMutex;client.mutex=&capture->fileMutex;
  gActiveRecordFile=File(disk,44);
  capture->fs=&fs;capture->activeFile=&gActiveRecordFile;capture->path="/voice/fixture.wav";
  client.onWrite=[&](){
   if(capture->activeFile && *capture->activeFile)
    assert(gActiveRecordFile.cursorForTest()==disk->bytes.size() && "active w+ cursor was not restored before socket write");
   if(!capture->activeFile && !capture->stream.finished.load())assert(disk->liveReadHandles==0);
  };
 }
 ~Fixture(){tick={};disk->onFlush={};gVoiceCaptureUpload.reset();gActiveRecordFile={};}
 void append(const std::vector<uint8_t>& bytes){
  auto lock=lockVoiceCaptureFile();assert(lock.owns_lock());
  assert(gActiveRecordFile.position()==disk->bytes.size() && "sender failed to restore active w+ cursor");
  assert(gActiveRecordFile.write(bytes.data(),bytes.size())==bytes.size());
  gActiveRecordBytes+=bytes.size();gActiveRecordCommittedBytes+=bytes.size();
 }
 void publish(){
  auto lock=lockVoiceCaptureFile();const size_t old=capture->stream.published.load();
  disk->onFlush=[&,old](){assert(capture->stream.published.load()==old && "published before SD flush");};
  publishVoiceCaptureBytes();disk->onFlush={};
 }
 void release(){
  {
   auto lock=lockVoiceCaptureFile();capture->activeFile=nullptr;
   gActiveRecordFile.flush();gActiveRecordFile.close();
  }
  finishVoiceCaptureUpload(gActiveRecordBytes);
 }
};
void publicationAndLocks(){
 gVoiceCaptureUpload.reset();auto empty=lockVoiceCaptureFile();assert(!empty.owns_lock());
 publishVoiceCaptureBytes();finishVoiceCaptureUpload(100);
 Fixture f;
 {auto lock=lockVoiceCaptureFile();assert(lock.owns_lock() && !mutexFree(&f.capture->fileMutex));}
 assert(mutexFree(&f.capture->fileMutex));
 f.append(payload(4094));f.publish();
 assert(f.capture->stream.published.load()==0 && f.disk->flushes==0 && f.disk->flushed==44);
 f.append(payload(2));f.publish();
 assert(f.capture->stream.published.load()==4096 && f.disk->flushes==1 && f.disk->flushed==4140);
 f.append(payload(20));f.publish();
 assert(f.capture->stream.published.load()==4096 && f.disk->flushes==1);
 f.release();
 assert(f.capture->activeFile==nullptr && f.capture->stream.published.load()==4116 && f.capture->stream.finished.load());
 std::puts("PASS actual lock helper owns the real mutex; publication waits for flush and a 4096-byte batch; final tail is published on release");
}
void failedFlush(){
 Fixture f;f.append(payload(4096));f.disk->failFlush=true;f.publish();
 assert(f.disk->flushes==1 && f.disk->flushed==44 && f.capture->stream.published.load()==0);
 f.disk->failFlush=false;f.publish();assert(f.capture->stream.published.load()==4096);
 f.capture->stream.cancelled.store(true);const auto flushes=f.disk->flushes;
 f.append(payload(4096));f.publish();finishVoiceCaptureUpload(gActiveRecordBytes);
 assert(f.disk->flushes==flushes && f.capture->stream.published.load()==4096 && !f.capture->stream.finished.load());
 std::puts("PASS mismatched flushed file size and cancelled capture cannot publish new bytes or finish");
}
void activeThenFinalized(){
 Fixture f;const auto first=payload(8192,3),tail=payload(238,9);unsigned turns=0;
 uint32_t released=0;
 tick=[&](){
  if(++turns==1){f.append(first);f.publish();}
  else {
   assert(turns==2 && f.capture->stream.sent.load()==first.size());
   assert(f.capture->stream.firstSentMs.load()!=0 && !f.capture->stream.finished.load());
   f.append(tail);f.publish();assert(f.capture->stream.published.load()==first.size());
   released=millis();f.release();
  }
 };
 assert(streamVoiceCapture(f.client,*f.capture,headers));tick={};
 std::vector<uint8_t> expected=first;expected.insert(expected.end(),tail.begin(),tail.end());
 assert(decoded(f.client.wire)==expected);
 assert(f.capture->stream.sent.load()==expected.size() && f.capture->stream.commitAttempted.load());
 assert(f.capture->stream.firstSentMs.load()<released && f.disk->opens==1 && f.disk->closes==2);
 assert(f.disk->reads==3 && f.disk->deletedReads==0 && f.disk->bytes.size()==44+expected.size());
 assert(f.disk->liveReadHandles==0 && f.disk->maxReadHandles==1);
 assert(std::equal(expected.begin(),expected.end(),f.disk->bytes.begin()+44));
 for(size_t i=0;i<44;++i)assert(f.disk->bytes[i]==0xEE);
 assert(f.client.timeouts==std::vector<unsigned>({3,(kTurnHttpTimeoutMs+999U)/1000U}));
 std::puts("PASS actual sender reads active w+ PCM after offset44, restores cursor for append, streams before release, reopens finalized SD tail byte-exactly");
}
void finalizedAndFailures(){
 {Fixture f;const auto data=payload(9000);f.append(data);f.release();
  assert(streamVoiceCapture(f.client,*f.capture,headers) && decoded(f.client.wire)==data);
  assert(f.disk->opens==1 && f.disk->closes==2 && f.disk->reads==3);
  assert(f.disk->liveReadHandles==0 && f.disk->maxReadHandles==1);}
 {Fixture f;f.append(payload(4096));f.publish();f.disk->shortRead=true;
  assert(!streamVoiceCapture(f.client,*f.capture,headers));
  assert(!f.capture->stream.commitAttempted.load() && f.capture->stream.sent.load()==0);
  auto lock=lockVoiceCaptureFile();assert(gActiveRecordFile.position()==f.disk->bytes.size());}
 {Fixture f;f.append(payload(16));f.release();f.disk->failOpen=true;
  assert(!streamVoiceCapture(f.client,*f.capture,headers) && !f.capture->stream.commitAttempted.load());
  assert(f.disk->reads==0);}
 {Fixture f;f.append(payload(16));f.release();f.capture->fs=nullptr;
  assert(!streamVoiceCapture(f.client,*f.capture,headers) && f.disk->opens==0 && f.disk->reads==0);}
 std::puts("PASS finalized-file-only path, short read with cursor restoration, missing SD file and absent FS fail without committing");
}
void cancellation(){
 {Fixture f;f.append(payload(4096));f.publish();f.capture->stream.cancelled.store(true);f.disk->removed=true;
  assert(!streamVoiceCapture(f.client,*f.capture,headers));
  assert(f.client.wire.empty() && f.disk->reads==0 && f.disk->opens==0 && f.disk->deletedReads==0);}
 {Fixture f;f.append(payload(4096));f.publish();
  tick=[&](){assert(f.capture->stream.sent.load()==4096);f.capture->stream.cancelled.store(true);f.disk->removed=true;};
  assert(!streamVoiceCapture(f.client,*f.capture,headers));tick={};
  assert(f.disk->reads==1 && f.disk->opens==0 && f.disk->deletedReads==0 && !f.capture->stream.commitAttempted.load());}
 std::puts("PASS cancellation before upload or after an uploaded prefix never reads a removed recording and never sends the final zero chunk");
}
void finalizedHandleLifetime(){
 {Fixture f;f.append(payload(8192));f.publish();
  {
   auto lock=lockVoiceCaptureFile();f.capture->activeFile=nullptr;
   gActiveRecordFile.flush();gActiveRecordFile.close();
  }
  tick=[&](){assert(f.capture->stream.sent.load()==8192 && f.disk->liveReadHandles==0);
   f.capture->stream.cancelled.store(true);f.disk->removed=true;};
  assert(!streamVoiceCapture(f.client,*f.capture,headers));tick={};
  assert(!f.capture->stream.finished.load() && !f.capture->stream.commitAttempted.load());
  assert(f.disk->opens==2 && f.disk->closes==3 && f.disk->liveReadHandles==0 && f.disk->deletedReads==0);}
 {Fixture f;f.append(payload(9000));f.release();
  f.client.onWrite=[&](){if(f.disk->reads==2)f.capture->stream.cancelled.store(true);};
  assert(!streamVoiceCapture(f.client,*f.capture,headers));
  assert(f.disk->opens==1 && f.disk->closes==2 && f.disk->liveReadHandles==0);
  assert(!f.capture->stream.commitAttempted.load());}
 std::puts("PASS before valid release every read handle closes immediately; finalized handle is reused once and closes under its mutex on cancellation");
}
void failedRestoreStopsProducer(){
 Fixture f;const auto original=payload(8192,3);f.append(original);f.publish();
 const auto preserved=f.disk->bytes;const auto writes=f.disk->writes;
 f.disk->failRestoreOnce=true;
 assert(!streamVoiceCapture(f.client,*f.capture,headers));
 assert(f.capture->stream.storageFailed.load() && !f.capture->stream.commitAttempted.load());
 assert(gActiveRecordFile.cursorForTest()==44+4096);
 finishVoiceCaptureUpload(original.size());assert(!f.capture->stream.finished.load());
 f.capture->stream.cancelled.store(true); // Same outcome as the owning worker.
 const auto next=payload(kRecordChunkBytes,27);
 std::memcpy(gRecordChunkBuffers[0],next.data(),next.size());gRecordInflightChunks.push_back(0);
 flushCompletedRecordChunksToFile(1);
 assert(f.disk->writes==writes && f.disk->bytes==preserved);
 assert(gRecordFileWriteFailed && !gRecording && gRecordInflightChunks.empty());
 assert(gActiveRecordBytes==original.size() && gActiveRecordCommittedBytes==original.size());
 assert(mutexFree(&f.capture->fileMutex));
 std::puts("PASS actual producer refuses the next SD write after a failed read-cursor restore; original PCM and byte counters remain intact");
}
void healthyProducer(){
 Fixture f;const auto original=payload(4096,2),next=payload(kRecordChunkBytes,17);
 f.append(original);f.publish();const auto writes=f.disk->writes;
 std::memcpy(gRecordChunkBuffers[0],next.data(),next.size());gRecordInflightChunks.push_back(0);
 flushCompletedRecordChunksToFile(1);
 assert(gRecording && !gRecordFileWriteFailed && !f.capture->stream.storageFailed.load());
 assert(gActiveRecordBytes==original.size()+next.size() && gActiveRecordCommittedBytes==gActiveRecordBytes);
 assert(f.disk->writes==writes+(next.size()+kRecordWriteBytes-1)/kRecordWriteBytes);
 assert(std::equal(original.begin(),original.end(),f.disk->bytes.begin()+44));
 assert(std::equal(next.begin(),next.end(),f.disk->bytes.begin()+44+original.size()));
 std::puts("PASS the actual healthy producer still appends complete capture chunks and updates both counters");
}
int main(){
 publicationAndLocks();failedFlush();activeThenFinalized();finalizedAndFailures();cancellation();
 finalizedHandleLifetime();failedRestoreStopsProducer();healthyProducer();
 std::puts("Scope: actual integration helpers and std::mutex with controlled buffered File/FS/socket/clock; SD/TLS/hardware concurrency still require device checks.");
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sanitize", action="store_true")
    args = parser.parse_args()
    globals_text = (PARTS / "005_main.cpp.inc").read_text()
    workers = (PARTS / "065_main.cpp.inc").read_text()
    producer = (PARTS / "032_main.cpp.inc").read_text()
    constants = (PARTS / "001_main.cpp.inc").read_text()
    constant_source = []
    for name in ("kMicSampleRate", "kMaxRecordSeconds", "kMaxRecordSamples", "kTurnHttpTimeoutMs",
                 "kRecordWriteBytes", "kRecordChunkSamples", "kRecordChunkBytes", "kRecordChunkBufferCount"):
        match = re.search(rf"^constexpr[^\n]*\b{name}\b[^\n]*;", constants, re.MULTILINE)
        if not match:
            raise SystemExit(f"Missing production constant: {name}")
        constant_source.append(match[0])
    declarations = [block(globals_text, "struct VoiceCaptureUpload {") + ";"]
    for name in ("gVoiceCaptureUpload", "gActiveRecordFile", "gActiveRecordBytes", "gActiveRecordCommittedBytes",
                 "gRecordFileWriteFailed", "gRecordInflightChunks", "gRecordChunkBuffers"):
        match = re.search(rf"^[^\n;]*\b{name}\b[^\n;]*;", globals_text, re.MULTILINE)
        if not match:
            raise SystemExit(f"Missing production global: {name}")
        declarations.append(match[0])
    bodies = [block(globals_text, "std::unique_lock<std::mutex> lockVoiceCaptureFile()")]
    bodies += [block(workers, signature) for signature in (
        "bool streamVoiceCapture(", "void publishVoiceCaptureBytes()", "void finishVoiceCaptureUpload(",
    )]
    bodies += [block(producer, signature) for signature in (
        "size_t writeRecordedBytes(", "void flushCompletedRecordChunksToFile(",
    )]
    cpp_source = "\n".join([PREAMBLE, *constant_source, *declarations, *bodies, TESTS])
    flags = ["-std=c++17", "-pthread", "-Wall", "-Wextra", "-Werror"]
    if args.sanitize:
        flags += ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
    with tempfile.TemporaryDirectory(prefix="s1-capture-spool-") as directory:
        temporary = Path(directory)
        cpp, binary = temporary / "test.cpp", temporary / "test"
        cpp.write_text(cpp_source)
        subprocess.run([os.environ.get("CXX", "c++"), *flags, "-I", str(ROOT / "bots/CardputerADV/src"),
                        str(cpp), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    main()
