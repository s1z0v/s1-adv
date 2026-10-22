#!/usr/bin/env python3
"""Compile production HTTP/ICY parsers and pinned MP3 decoder under ASan/UBSan."""
from pathlib import Path
import os,subprocess,tempfile
root=Path(__file__).resolve().parents[1];src=root/'bots/CardputerADV/src'
code=r'''
#include "internet_radio_transport.h"
#define MINIMP3_ONLY_MP3
#define MINIMP3_NO_SIMD
#include "vendor/minimp3.h"
#include <cassert>
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>
#include <fstream>
#include <iterator>
#include <cstring>
using namespace internet_radio;using namespace internet_radio::detail;
Headers header(const std::vector<std::string>&lines){Headers h;for(auto&s:lines)assert(h.line(s.c_str())==Error::None);return h;}
std::string parse(const std::string&wire,const Headers&h){Body body(h);std::string audio;for(unsigned char c:wire){int r=body.feed(c);assert(r>=0);if(r)audio+=char(c);}assert(body.complete());return audio;}
std::string chunk(const std::string&entity,size_t size){std::string out;for(size_t p=0;p<entity.size();p+=size){auto s=entity.substr(p,size);char hex[20];snprintf(hex,sizeof(hex),"%zx\r\n",s.size());out+=hex;out+=s;out+="\r\n";}return out+"0\r\n\r\n";}
int main(int argc,char**argv){
 assert(argc==3);Url u;
 assert(parseUrl("http://ice2.somafm.com/a?b=1",u)&&std::string(u.host)=="ice2.somafm.com"&&std::string(u.path)=="/a?b=1"&&u.port==80);
 assert(parseUrl("http://example.org:8000/stream",u)&&u.port==8000);
 for(auto s:{"https://example.com/x","http://u:p@example.com/x","http://example.com:0/x","http://example.com:65536/x","http://[::1]/x","http://a/evil\r\nHost:x","http://a/x#y","http://a/x y","http:///x","http://a/x\\y"})assert(!parseUrl(s,u));
 assert(publicIpv4(0x08080808)&&publicIpv4(0x5db8d822));
 for(uint32_t ip:{0U,0x7f000001U,0x0a000001U,0xc0a80101U,0xac100001U,0xa9fe0101U,0xe0000001U,0x64400001U,0xc6336401U})assert(!publicIpv4(ip));
 auto h=header({"HTTP/1.1 200 OK","Content-Type: audio/mpeg",""});
 assert(parse("audio123",h)=="audio123");
 auto c=header({"ICY 200 OK","Content-Type: audio/mpeg","Transfer-Encoding: chunked",""});
 for(unsigned n=1;n<100;++n)assert(parse(chunk("abcdefghijklmno",n),c)=="abcdefghijklmno");
 // Metadata length and content may cross any TCP/chunk boundary. Produce
 // exact audio and never leak arbitrary station metadata into decoder bytes.
 auto m=header({"HTTP/1.0 200 OK","Content-Type: audio/mpeg","icy-metaint: 3",""});
 std::string entity="abc";entity+=char(1);entity+="StreamTitle=xxxx";assert(entity.size()==20);entity+="def";entity+=char(0);entity+="gh";
 assert(parse(entity,m)=="abcdefgh");
 auto cm=header({"HTTP/1.1 200 OK","Content-Type: audio/mpeg","Transfer-Encoding: chunked","icy-metaint: 3",""});
 for(unsigned n=1;n<40;++n)assert(parse(chunk(entity,n),cm)=="abcdefgh");
 Headers length=header({"HTTP/1.1 200 OK","Content-Type: audio/mp3","Content-Length: 3",""});
 Body bounded(length);assert(bounded.feed('a')==1&&!bounded.complete());assert(bounded.feed('b')==1);assert(bounded.feed('c')==1&&bounded.complete()&&bounded.done());assert(bounded.feed('d')<0);
 for(auto lines:std::vector<std::vector<std::string>>{{"HTTP/1.1 200 OK","Content-Type: text/html"},{"HTTP/1.1 200 OK","Content-Type: audio/aac"},{"HTTP/1.1 200 OK","Content-Type: audio/mpeg","Transfer-Encoding: gzip"},{"HTTP/1.1 200 OK","Content-Type: audio/mpeg","Content-Length: -1"},{"HTTP/1.1 200 OK","Content-Type: audio/mpeg","icy-metaint: 0"},{"HTTP/1.1 200 OK","Content-Type: audio/mpeg","Content-Length: 1","Transfer-Encoding: chunked",""},{"HTTP/1.1 200 OK",""},{"HTTP/1.1 403 Nope",""}}){
  Headers bad;Error e=Error::None;for(auto&s:lines){e=bad.line(s.c_str());if(e!=Error::None)break;}assert(e!=Error::None);
 }
 // Redirects can legitimately return HTML; no HTML is decoded. The worker
 // validates each next URL and destination's public IP before reconnecting.
 auto redirect=header({"HTTP/1.1 302 Found","Content-Type: text/html","Location: http://example.org/radio",""});assert(redirect.status==302);
 for(auto wire:{"X\r\n","1;extension=x\r\na\r\n0\r\n\r\n","1\rXa","1000001\r\n"}){Body b(c);bool bad=false;for(unsigned char ch:std::string(wire))if(b.feed(ch)<0){bad=true;break;}assert(bad);}
 Body incomplete(c);for(unsigned char ch:std::string("3\r\nab"))assert(incomplete.feed(ch)>=0);assert(!incomplete.complete());
 Body metadata(m);for(unsigned char ch:std::string("abc\1xx",6))assert(metadata.feed(ch)>=0);assert(!metadata.complete());
 // Malformed byte-level payload fuzz cannot escape bounded parser state.
 uint32_t random=49;for(int test=0;test<20000;++test){Body b(test&1?cm:c);for(int i=0;i<500;++i){random=random*1664525U+1013904223U;if(b.feed(random>>24)<0||b.done())break;}}
 // Actual pinned decoder, not a decoder stub, on generated mono/stereo MP3.
 for(int file=1;file<argc;++file){std::ifstream in(argv[file],std::ios::binary);std::vector<uint8_t>data((std::istreambuf_iterator<char>(in)),{});assert(data.size()>2000);
  mp3dec_t decoder;mp3dec_init(&decoder);size_t pos=0,frames=0;long long energy=0;int16_t pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];
  while(pos<data.size()){mp3dec_frame_info_t info{};int n=mp3dec_decode_frame(&decoder,data.data()+pos,int(data.size()-pos),pcm,&info);
   assert(info.frame_bytes>=0&&pos+size_t(info.frame_bytes)<=data.size());if(!info.frame_bytes)break;pos+=info.frame_bytes;
   if(n){assert(info.layer==3&&info.hz==44100&&info.channels==file&&n<=1152);++frames;for(int i=0;i<n*info.channels;++i)energy+=pcm[i]<0?-int(pcm[i]):pcm[i];}
  }assert(frames>30&&energy>10000);
 }
 puts("PASS actual radio URL/public-IP/HTTP/chunked/ICY parsers, malformed input and 20000 fuzz cases; pinned MP3 decoder mono/stereo fixtures (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='s1-radio-transport-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 for channels in [1,2]:
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1.2:sample_rate=44100','-ac',str(channels),'-c:a','libmp3lame','-b:a','128k',str(p/f'{channels}.mp3')],check=True)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-g','-Wall','-Wextra','-Werror','-DINTERNET_RADIO_HOST_TEST','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I'+str(src),str(p/'test.cpp'),str(src/'internet_radio_transport.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test'),str(p/'1.mp3'),str(p/'2.mp3')],check=True,timeout=60)
