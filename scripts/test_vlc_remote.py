#!/usr/bin/env python3
"""Sanitized production HTTP framing, JSON parsing and command checks."""
from pathlib import Path
import os, subprocess, tempfile
ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'bots/CardputerADV/src'
JSON=ROOT/'bots/CardputerADV/.pio/libdeps/cardputer_adv/ArduinoJson/src'
CODE=r'''
#include "vlc_remote.h"
#include <cassert>
#include <cstring>
#include <string>
#include <memory>
#include <random>
using namespace vlc_remote;
const char* json=R"({"state":"playing","time":42,"length":150,"volume":256,"information":{"category":{"meta":{"title":"Example track"}}},"ignored":[1,2,3]})";
std::unique_ptr<Response> read(const std::string& wire){
 auto r=std::make_unique<Response>();for(unsigned char c:wire)if(!r->feed(c))break;return r;
}
int main(){
 for(auto ip:{0x0a010203u,0xac100102u,0xac1f0102u,0xc0a86eaeu})assert(privateIpv4(ip));
 for(auto ip:{0x08080808u,0x7f000001u,0xa9fe0102u,0xe0010101u,0x00000000u,0xc0a801ffu,0xc0a80100u,0xac200102u})assert(!privateIpv4(ip));
 Config c;strcpy(c.host,"vlc-test.local");strcpy(c.password,"fixture-only");assert(configured(c));
 strcpy(c.host,"https://vlc-test.local");assert(!configured(c));strcpy(c.host,"vlc-test.local");c.port=0;assert(!configured(c));
 assert(!strcmp(path(Command::Toggle),"/requests/status.json?command=pl_pause"));
 assert(strstr(path(Command::VolumeUp),"%2B13"));assert(strstr(path(Command::Forward),"%2B10"));
 for(int i=0;i<=int(Command::Back);++i){auto p=path(Command(i));assert(p && !strchr(p,' ') && !strchr(p,'\r') && !strchr(p,'\n') && !strstr(p,"password"));}
 assert(!path(Command(255)));
 for(auto version:{"HTTP/1.0","HTTP/1.1"}){
  auto r=read(std::string(version)+" 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "+std::to_string(strlen(json))+"\r\n\r\n"+json);
  assert(r->done&&r->finish());Snapshot s;assert(parseStatus(r->body,s)&&s.connected&&s.seconds==42&&s.length==150&&s.volume==256&&!strcmp(s.title,"Example track"));
 }
 auto r=read(std::string("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n")+json);assert(r->finish());
 // macOS VLC 3.0.24 status.json is JSON served as text/plain.
 r=read(std::string("HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ")+std::to_string(strlen(json))+"\r\n\r\n"+json);
 assert(r->finish());Snapshot plain;assert(parseStatus(r->body,plain)&&plain.connected);
 char size[20];sprintf(size,"%zx",strlen(json));
 r=read(std::string("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n")+size+"\r\n"+json+"\r\n0\r\n\r\n");assert(r->finish());
 for(int code:{401,403,404,302,500}){r=read("HTTP/1.1 "+std::to_string(code)+" Error\r\n\r\n");assert(!r->finish()&&r->status==code&&r->error==(code==401?Error::Auth:Error::Http));}
 for(auto header:{"Content-Length: 12289\r\n","Content-Length: -1\r\n","Content-Length: 9\r\nContent-Length: 9\r\n","Content-Length: 9\r\nTransfer-Encoding: chunked\r\n","Content-Encoding: gzip\r\n","Transfer-Encoding: unknown\r\n"}){
  r=read(std::string("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n")+header+"\r\n{}");assert(!r->finish());
 }
 for(auto wire:{"HTTP/1.1 200 OK\n\n{}","garbage\r\n\r\n{}","HTTP/1.1 200 OK\r\n\r\n{}","HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n{}","HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{}","HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx"}){
  r=read(wire);assert(!r->finish());
 }
 r=read(std::string("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n")+std::string(12289,'x'));assert(!r->finish()&&r->error==Error::TooLarge);
 Snapshot initial;initial.seconds=99;
 for(auto body:{"{}","null","[]","{","{\"state\":\"unknown\",\"time\":0,\"length\":0,\"volume\":256}","{\"state\":\"playing\",\"time\":-1,\"length\":3,\"volume\":2}","{\"state\":\"playing\",\"time\":0,\"length\":3,\"volume\":1025}"}){
  auto before=initial;assert(!parseStatus(body,initial)&&initial.seconds==before.seconds&&!initial.connected);
 }
 for(auto state:{"playing","paused","stopped"}){
  auto body=std::string("{\"state\":\"")+state+"\",\"time\":0,\"length\":0,\"volume\":0}";
  Snapshot s;assert(parseStatus(body.c_str(),s)&&!strcmp(s.title,"VLC on Mac"));
 }
 std::mt19937 random(42);
 for(int i=0;i<3000;++i){Response fuzz;for(unsigned j=0;j<1000&&!fuzz.done&&fuzz.error==Error::None;++j)fuzz.feed(random()%256);fuzz.finish();}
 puts("PASS actual VLC HTTP/JSON: status, 401, errors, chunked/length/EOF framing, caps, malformed/fuzz, LAN-only addresses and encoded controls (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='vlc-core-') as tmp:
 p=Path(tmp);(p/'test.cpp').write_text(CODE)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-DVLC_REMOTE_HOST_TEST','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),'-I'+str(JSON),str(p/'test.cpp'),str(SRC/'vlc_remote.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=30)
