#!/usr/bin/env python3
"""Compile the real incremental reader and test main-loop socket ownership."""
from pathlib import Path
import os, subprocess, tempfile

root=Path(__file__).resolve().parents[1]
parts=root/'bots/CardputerADV/src/main_parts'
def function(signature):
    text=(parts/'064_main.cpp.inc').read_text()
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
class WiFiClientSecure {
 public:
  bool online=true;std::deque<char> input;
  ~WiFiClientSecure(){++destroyed;}
  bool connected(){return online;}
  int available(){return input.size();}
  int read(){if(input.empty())return -1;char c=input.front();input.pop_front();return c;}
  void setTimeout(unsigned){}
  void feed(const char* s){while(*s)input.push_back(*s++);}
};
''')
    (out/'WebSocketsClient.h').write_text(r'''
#pragma once
#include "WiFiClientSecure.h"
#include <vector>
constexpr unsigned WEBSOCKETS_TCP_TIMEOUT=5000;
enum Status {WSC_NOT_CONNECTED,WSC_HEADER,WSC_CONNECTED};
inline std::vector<String> lines;
class WebSocketsClient {
 protected:
  struct Client {WiFiClientSecure* ssl=nullptr;WiFiClientSecure* tcp=nullptr;String cKey;Status status=WSC_NOT_CONNECTED;} _client;
  uint32_t _lastHeaderSent=0;
  String base64_encode(uint8_t*,size_t){return "nonce";}
  void clientDisconnect(Client* c,const char*){++disconnected;delete c->tcp;c->tcp=nullptr;c->ssl=nullptr;c->status=WSC_NOT_CONNECTED;}
  void handleHeader(Client* c,String* line){lines.push_back(*line);if(line->empty())c->status=WSC_CONNECTED;}
 public:
  void loop(){++baseLoops;}
  void disconnect(){if(_client.tcp)clientDisconnect(&_client,"stop");}
};
''')
    source=f'#include "{root}/bots/CardputerADV/src/realtime_socket.h"\n'
    source+=r'''
#include <cassert>
int main(){
 RealtimeSocket socket;
 socket.pollConnected();assert(baseLoops==0);
 auto* tls=new WiFiClientSecure();socket.adopt(tls,"nonce");
 tls->feed("HTTP/1.1 101 Switch");socket.pollConnected();
 assert(lines.empty() && baseLoops==0);
 tls->feed("ing Protocols\r\nUpgrade: websocket\r\n\r\n");
 socket.pollConnected();assert(lines.size()==3);
 assert(lines[0]=="HTTP/1.1 101 Switching Protocols" && lines.back().empty());
 socket.pollConnected();assert(baseLoops==1);
 socket.disconnect();assert(destroyed==1 && disconnected==1);
 socket.pollConnected();assert(baseLoops==1);
 auto* stale=new WiFiClientSecure();socket.adopt(stale,"nonce");
 clockMs=8001;socket.pollConnected();assert(disconnected==2 && destroyed==2);
 auto* lost=new WiFiClientSecure();socket.adopt(lost,"nonce");
 lost->online=false;socket.pollConnected();assert(disconnected==3 && destroyed==3);
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
unsigned gRealtimeDialGeneration=3;
int gRealtimeDialMux;
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
void failRealtimeSession(const String&){++failed;}
void logf(const char*,...){}
struct {std::unique_ptr<Tls> owned;void adopt(Tls* socket,const String&){owned.reset(socket);++adopted;}} gRealtimeWs;
'''
    source+=function('void serviceRealtimeDialCompletion()')
    source+=r'''
RealtimeDialResult* result(unsigned generation){auto* r=new RealtimeDialResult();r->generation=generation;r->socket.reset(new Tls());return r;}
int main(){
 gRealtimeDialResult=result(2);serviceRealtimeDialCompletion();
 assert(!gRealtimeDialBusy && destroyed==1 && adopted==0);
 gRealtimeDialBusy=true;gRealtimeDialResult=result(3);gRealtimeActive=false;
 serviceRealtimeDialCompletion();assert(destroyed==2 && adopted==0);
 gRealtimeActive=true;gRealtimeDialResult=result(3);serviceRealtimeDialCompletion();
 assert(adopted==1 && gRealtimeWs.owned && failed==0);
 gRealtimeDialResult=result(3);gRealtimeDialResult->error="TLS failure";
 serviceRealtimeDialCompletion();assert(failed==1 && destroyed==3);
 gRealtimeDialBusy=true;gRealtimeDialAllocationFailed=true;
 serviceRealtimeDialCompletion();assert(!gRealtimeDialBusy && failed==2);
}
'''
    cpp=out/'handoff.cpp';cpp.write_text(source)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(cpp),'-o',str(out/'handoff')],check=True)
    subprocess.run([str(out/'handoff')],check=True)
worker=function('RealtimeDialResult* performRealtimeDial(')
for banned in ['setUiMode','setStatus','logf(','vTaskDelete','gCanvas','gRealtimeWs.']:
    assert banned not in worker,banned
assert 'setCACert(kTlsRootCaPem)' in worker and 'setInsecure' not in worker
print('PASS actual Realtime reader: partial headers, timeout, disconnect; cancelled/failed/successful socket ownership; verified TLS worker')
