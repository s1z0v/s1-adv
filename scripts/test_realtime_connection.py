#!/usr/bin/env python3
"""Compile the real incremental reader and test main-loop socket ownership."""
from pathlib import Path
import os, subprocess, tempfile

root=Path(__file__).resolve().parents[1]
parts=root/'bots/CardputerADV/src/main_parts'
def function(signature,file='064_main.cpp.inc'):
    text=(parts/file).read_text()
    start=text.index(signature); opening=text.index('{',start); end=opening+1; depth=1
    while depth:
        depth+=(text[end]=='{')-(text[end]=='}');end+=1
    return text[start:end]

with tempfile.TemporaryDirectory(prefix='s1-realtime-') as directory:
    out=Path(directory)
    (out/'WiFiClientSecure.h').write_text(r'''
#pragma once
#include <string>
#include <deque>
#include <cstdint>
using String=std::string;
inline uint32_t clockMs=0;
inline uint32_t millis(){return clockMs;}
inline uint32_t esp_random(){return 42;}
inline unsigned destroyed=0,disconnected=0,baseLoops=0;
inline unsigned unexpectedDial=0;
inline unsigned perFrameMs=0;
class WiFiClient {
 public:
  virtual ~WiFiClient()=default;
  virtual uint8_t connected(){return 0;}
  virtual int available(){return 0;}
  virtual int read(){return -1;}
  virtual int read(uint8_t*,size_t){return -1;}
  virtual int peek(){return -1;}
  virtual size_t write(const uint8_t*,size_t){return 0;}
  virtual size_t write(uint8_t){return 0;}
  virtual void flush(){}
  virtual void stop(){}
};
class WiFiClientSecure:public WiFiClient {
 public:
  bool online=true;std::deque<char> input;unsigned timeoutSeconds=0;
  ~WiFiClientSecure(){++destroyed;}
  uint8_t connected(){return online;}
  int available(){return input.size();}
  int read(){if(input.empty())return -1;uint8_t c=input.front();input.pop_front();return c;}
  int read(uint8_t* p,size_t n){size_t i=0;while(i<n&&!input.empty()){p[i++]=input.front();input.pop_front();}return i;}
  void setTimeout(unsigned seconds){timeoutSeconds=seconds;}
  size_t write(const uint8_t*,size_t n){return n;}
  void stop(){online=false;}
  void feed(const char* s){while(*s)input.push_back(*s++);}
};
''')
    (out/'WebSocketsClient.h').write_text(r'''
#pragma once
#include "WiFiClientSecure.h"
#include <vector>
constexpr unsigned WEBSOCKETS_TCP_TIMEOUT=5000;
constexpr size_t WEBSOCKETS_MAX_DATA_SIZE=15*1024;
enum Status {WSC_NOT_CONNECTED,WSC_HEADER,WSC_CONNECTED};
inline std::vector<String> lines;
class WebSocketsClient {
 protected:
  struct Client {
   WiFiClientSecure* ssl=nullptr;WiFiClient* tcp=nullptr;String cKey;Status status=WSC_NOT_CONNECTED;bool isSSL=true;
   struct {unsigned opCode=2;size_t payloadLen=1448;} cWsHeaderDecode;
   unsigned cWsRXsize=4,pongTimeoutCount=0;
  } _client;
  uint32_t _lastHeaderSent=0;
  String base64_encode(uint8_t*,size_t){return "nonce";}
  void clientDisconnect(Client* c,const char*){++disconnected;delete c->ssl;c->tcp=nullptr;c->ssl=nullptr;c->status=WSC_NOT_CONNECTED;}
  void handleHeader(Client* c,String* line){lines.push_back(*line);if(line->empty())c->status=WSC_CONNECTED;}
  void handleClientData(){++baseLoops;while(_client.tcp&&_client.tcp->available())_client.tcp->read();clockMs+=perFrameMs;}
  void handleHBPing(){}
  void handleHBTimeout(Client*){}
 public:
  virtual ~WebSocketsClient()=default;
  void loop(){++unexpectedDial;}
  void disconnect(){if(_client.tcp)clientDisconnect(&_client,"stop");}
};
''')
    source=f'#include "{root}/bots/CardputerADV/src/realtime_socket.h"\n'
    source+=r'''
#include <cassert>
int main(){
 RealtimeSocket socket;
 assert(socket.receiveOpcode()==2 && socket.receiveLength()==1448);
 assert(socket.receiveHeaderBytes()==4 && socket.heartbeatTimeouts()==0);
 socket.pollConnected();assert(baseLoops==0);
 auto* tls=new WiFiClientSecure();socket.adopt(tls,"nonce");
 assert(tls->timeoutSeconds==5);
 tls->feed("HTTP/1.1 101 Switch");socket.pollConnected();
 assert(lines.empty() && baseLoops==0);
 tls->feed("ing Protocols\r\nUpgrade: websocket\r\n\r\n");
 socket.pollConnected();assert(lines.size()==3);
 assert(lines[0]=="HTTP/1.1 101 Switching Protocols" && lines.back().empty());
 socket.pollConnected();assert(baseLoops==1);
 const char* frame="\x81\x03" "123";
 for(int i=0;i<10;++i)tls->feed(frame);
 socket.pollConnected();assert(baseLoops==9 && tls->available()==10);
 tls->input.clear();for(int i=0;i<3;++i)tls->feed(frame);
 perFrameMs=2;unsigned before=baseLoops;
 socket.pollConnected();assert(baseLoops==before+2 && tls->available()==5);
 perFrameMs=0;tls->input.clear();unsigned closedLoops=baseLoops;
 socket.disconnect();assert(destroyed==1 && disconnected==1);
 socket.pollConnected();assert(baseLoops==closedLoops);clockMs=0;
 auto* stale=new WiFiClientSecure();socket.adopt(stale,"nonce");
 clockMs=8001;socket.pollConnected();assert(disconnected==2 && destroyed==2);
 auto* lost=new WiFiClientSecure();socket.adopt(lost,"nonce");
 lost->online=false;socket.pollConnected();assert(disconnected==3 && destroyed==3);
 auto* partial=new WiFiClientSecure();socket.adopt(partial,"nonce");
 partial->feed("HTTP/1.1 101 Switching Protocols\r\n\r\n");socket.pollConnected();
 partial->feed("\x82\x04" "ab");socket.pollConnected();
 assert(disconnected==3);clockMs+=5001;socket.pollConnected();
 assert(disconnected==4 && destroyed==4);
 // Disconnect during a partial frame deletes only the TLS owner; the view is
 // a member, and another poll must never dereference that deleted socket.
 auto* cancelled=new WiFiClientSecure();socket.adopt(cancelled,"nonce");
 cancelled->feed("HTTP/1.1 101 Switching Protocols\r\n\r\n");socket.pollConnected();
 cancelled->feed("\x82\x04" "a");socket.pollConnected();socket.disconnect();
 socket.pollConnected();assert(disconnected==5 && destroyed==5);
 // Test the production facade, including a fully buffered frame at EOF.
 auto* eof=new WiFiClientSecure();WiFiClientSecure* owner=eof;
 RealtimeFrameClient view;view.bind(&owner);eof->feed(frame);
 assert(view.pump(clockMs));eof->online=false;
 assert(view.connected() && view.available()==5 && view.peek()==0x81);
 uint8_t wire[5];assert(view.read(wire,5)==5 && wire[4]=='3');
 assert(!view.connected() && view.available()==0);
 delete owner;owner=nullptr;assert(!view.connected());
 assert(unexpectedDial==0);
}
'''
    cpp=out/'reader.cpp';cpp.write_text(source)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-I',str(out),str(cpp),'-o',str(out/'reader')],check=True)
    subprocess.run([str(out/'reader')],check=True)
    source=r'''
#include <memory>
#include <string>
#include <cassert>
struct String:std::string {using std::string::string;String(const std::string& s):std::string(s){};bool isEmpty()const{return empty();}};
int destroyed=0,adopted=0,failed=0;
struct Tls {~Tls(){++destroyed;}};
struct RealtimeDialResult {std::unique_ptr<Tls> socket;String key,error;unsigned generation=0;};
RealtimeDialResult* gRealtimeDialResult=nullptr;
bool gRealtimeDialAllocationFailed=false,gRealtimeDialBusy=true,gRealtimeActive=true;
bool gRealtimeDialCanvasReleased=true;
int restored=0;
void restoreUiCanvasAfterNetwork(){++restored;}
unsigned freeHeap=105944,largestBlock=94196;
struct {unsigned getFreeHeap(){return freeHeap;}} ESP;
constexpr int MALLOC_CAP_8BIT=0;
unsigned heap_caps_get_largest_free_block(int){return largestBlock;}
unsigned gRealtimeDialGeneration=3;
int gRealtimeDialMux;
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
void failRealtimeSession(const String&){++failed;}
void logf(const char*,...){}
struct {std::unique_ptr<Tls> owned;void adopt(Tls* socket,const String&){owned.reset(socket);++adopted;}} gRealtimeWs;
'''
    source+=function('bool tlsHandshakeNeedsCanvas()','006_main.cpp.inc')
    source+=function('void serviceRealtimeDialCompletion()')
    source+=r'''
RealtimeDialResult* result(unsigned generation){auto* r=new RealtimeDialResult();r->generation=generation;r->socket.reset(new Tls());return r;}
int main(){
 assert(!tlsHandshakeNeedsCanvas());
 // Exact observed post-Realtime failure: plenty of total free SRAM but no
 // large enough contiguous block for the TLS record/certificate allocations.
 freeHeap=104376;largestBlock=20468;assert(tlsHandshakeNeedsCanvas());
 freeHeap=70000;largestBlock=60000;assert(tlsHandshakeNeedsCanvas());
 freeHeap=105944;largestBlock=94196;assert(!tlsHandshakeNeedsCanvas());
 gRealtimeDialResult=result(2);serviceRealtimeDialCompletion();
 assert(!gRealtimeDialBusy && destroyed==1 && adopted==0);
 assert(restored==1 && !gRealtimeDialCanvasReleased);
 gRealtimeDialBusy=true;gRealtimeDialResult=result(3);gRealtimeActive=false;
 serviceRealtimeDialCompletion();assert(destroyed==2 && adopted==0);
 gRealtimeActive=true;gRealtimeDialResult=result(3);serviceRealtimeDialCompletion();
 assert(adopted==1 && gRealtimeWs.owned && failed==0);
 gRealtimeDialResult=result(3);gRealtimeDialResult->error="TLS failure";
 serviceRealtimeDialCompletion();assert(failed==1 && destroyed==3);
 gRealtimeDialBusy=true;gRealtimeDialAllocationFailed=true;
 gRealtimeDialCanvasReleased=true;
 serviceRealtimeDialCompletion();assert(!gRealtimeDialBusy && failed==2);
 assert(restored==2 && !gRealtimeDialCanvasReleased);
}
'''
    cpp=out/'handoff.cpp';cpp.write_text(source)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(cpp),'-o',str(out/'handoff')],check=True)
    subprocess.run([str(out/'handoff')],check=True)
worker=function('RealtimeDialResult* performRealtimeDial(')
for banned in ['setUiMode','setStatus','logf(','vTaskDelete','gCanvas','gRealtimeWs.']:
    assert banned not in worker,banned
assert 'setCACert(kTlsRootCaPem)' in worker and 'setInsecure' not in worker
start=(parts/'042_main.cpp.inc').read_text().split('void startRealtimeSession(bool startAfterReady)')[1].split('void startRealtimeRecording()')[0]
assert 'cancelVoicePreconnect();' in start
assert all(flag in start.split('gPendingRealtimeStart = true;')[0] for flag in ['gVoiceDialBusy','gVoiceReplySpeechBusy'])
assert start.index('render();') < start.index('beginRealtimeDial()')
begin=function('bool beginRealtimeDial()')
assert begin.index('releaseUiCanvasForNetwork("realtime TLS")') < begin.index('xTaskCreate(')
assert 'restoreUiCanvasAfterNetwork()' in begin
callback=(parts/'042_main.cpp.inc').read_text().split('if (type == "speech.stopped")')[1].split('if (type == "realtime.thinking")')[0]
assert 'gRealtimeVadStopPending = true' in callback and 'stopRealtimeRecordingForVad()' not in callback
service=(parts/'043_main.cpp.inc').read_text()
assert service.index('gRealtimeWs.pollConnected()') < service.index('stopRealtimeRecordingForVad()') < service.index('serviceRealtimeRecording(true)')
print('PASS actual Realtime reader: partial headers, timeout, disconnect; cancelled/failed/successful socket ownership; verified TLS worker')
