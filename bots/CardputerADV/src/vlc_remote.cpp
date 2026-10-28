#include "vlc_remote.h"
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <cctype>
#include <algorithm>
#include <initializer_list>
#include <ArduinoJson.h>

namespace vlc_remote {
const char* path(Command c) {
  switch(c) {
    case Command::Status: return "/requests/status.json";
    case Command::Toggle: return "/requests/status.json?command=pl_pause";
    case Command::Stop: return "/requests/status.json?command=pl_stop";
    case Command::Next: return "/requests/status.json?command=pl_next";
    case Command::Previous: return "/requests/status.json?command=pl_previous";
    case Command::VolumeUp: return "/requests/status.json?command=volume&val=%2B13";
    case Command::VolumeDown: return "/requests/status.json?command=volume&val=-13";
    case Command::Forward: return "/requests/status.json?command=seek&val=%2B10";
    case Command::Back: return "/requests/status.json?command=seek&val=-10";
  }
  return nullptr;
}
bool privateIpv4(uint32_t n) {
  unsigned a=n>>24,b=(n>>16)&255,d=n&255;
  return d!=0 && d!=255 && (a==10 || (a==172 && b>=16 && b<=31) || (a==192 && b==168));
}
bool configured(const Config& c) {
  if (!c.port || !c.password[0] || c.username[0]) return false;
  const auto n=strnlen(c.host,sizeof(c.host));
  if (n<7 || n>=sizeof(c.host) || strcmp(c.host+n-6,".local")) return false;
  for(size_t i=0;i<n;++i) if(!isalnum(static_cast<unsigned char>(c.host[i])) && c.host[i]!='.' && c.host[i]!='-') return false;
  return strnlen(c.password,sizeof(c.password))<sizeof(c.password) &&
         strnlen(c.fallback,sizeof(c.fallback))<sizeof(c.fallback);
}
const char* message(Error e) {
  switch(e) {
    case Error::None: return "Connected";
    case Error::NotConfigured: return "VLC not provisioned";
    case Error::NoWifi: return "Wi-Fi required";
    case Error::NoHost: return "Mac not found; R retry";
    case Error::Connect: return "VLC unavailable; R retry";
    case Error::Timeout: return "Timeout; R check status";
    case Error::Auth: return "HTTP 401: VLC password";
    case Error::Http: return "VLC HTTP error; R retry";
    case Error::Invalid: return "Invalid VLC response";
    case Error::TooLarge: return "VLC response too large";
    case Error::Cancelled: return "Disconnected";
    case Error::Memory: return "Busy / low memory";
  }
  return "VLC error";
}
namespace {
bool number(const char* s,unsigned& out,unsigned max) {
  if(!*s)return false;out=0;
  for(;*s;++s){if(*s<'0'||*s>'9'||out>(max-unsigned(*s-'0'))/10)return false;out=out*10+unsigned(*s-'0');}
  return out<=max;
}
}
bool Response::feed(uint8_t b) {
  if(error!=Error::None || done)return false;
  auto fail=[&](Error e){error=e;return false;};
  if(!headers) {
    if(++headerBytes>2048 || b==0)return fail(Error::Invalid);
    if(b!='\n') {if(lineUsed+1>=sizeof(line))return fail(Error::Invalid);line[lineUsed++]=char(b);return true;}
    if(!lineUsed || line[lineUsed-1]!='\r')return fail(Error::Invalid);
    line[--lineUsed]=0;
    if(!status) {
      if(strncmp(line,"HTTP/1.0 ",9) && strncmp(line,"HTTP/1.1 ",9))return fail(Error::Invalid);
      if(strlen(line)<12 || !isdigit(line[9]) || !isdigit(line[10]) || !isdigit(line[11]) || (line[12] && line[12]!=' '))return fail(Error::Invalid);
      status=(line[9]-'0')*100+(line[10]-'0')*10+line[11]-'0';
      if(status!=200) {error=status==401?Error::Auth:Error::Http;done=true;return false;}
    } else if(!lineUsed) {
      if(!hasType || (hasLength && chunked))return fail(Error::Invalid);
      headers=true;if(hasLength && !remaining)done=true;
    } else {
      char* colon=strchr(line,':');if(!colon)return fail(Error::Invalid);*colon=0;
      char* v=colon+1;while(*v==' '||*v=='\t')++v;
      if(!strcasecmp(line,"Content-Length")) {
        if(hasLength || !number(v,remaining,kBodyLimit))return fail(Error::TooLarge);hasLength=true;
      } else if(!strcasecmp(line,"Transfer-Encoding")) {
        if(chunked || strcasecmp(v,"chunked"))return fail(Error::Invalid);chunked=true;
      } else if(!strcasecmp(line,"Content-Type")) {
        char* semi=strchr(v,';');if(semi)*semi=0;
        // VLC 3.0.24 on macOS serves status.json as text/plain; JSON is validated below.
        if(hasType || (strcasecmp(v,"application/json") && strcasecmp(v,"text/plain")))return fail(Error::Invalid);hasType=true;
      } else if(!strcasecmp(line,"Content-Encoding") && strcasecmp(v,"identity")) return fail(Error::Invalid);
    }
    lineUsed=0;return true;
  }
  bool append=!chunked;
  if(chunked) {
    switch(phase) {
      case 0: {
        int d=b>='0'&&b<='9'?b-'0':b>='a'&&b<='f'?b-'a'+10:b>='A'&&b<='F'?b-'A'+10:-1;
        if(d>=0 && digits<6 && chunk<=(kBodyLimit-unsigned(d))/16){chunk=chunk*16+d;++digits;return true;}
        if(b=='\r' && digits){phase=1;return true;}return fail(Error::Invalid);
      }
      case 1: if(b!='\n')return fail(Error::Invalid);phase=chunk?2:5;return true;
      case 2: append=true;if(!--chunk)phase=3;break;
      case 3: if(b!='\r')return fail(Error::Invalid);phase=4;return true;
      case 4: if(b!='\n')return fail(Error::Invalid);phase=0;digits=0;return true;
      case 5: if(b!='\r')return fail(Error::Invalid);phase=6;return true;
      case 6: if(b!='\n')return fail(Error::Invalid);done=true;return true;
      default: return fail(Error::Invalid);
    }
  }
  if(append) {
    if(used>=kBodyLimit)return fail(Error::TooLarge);
    body[used++]=char(b);body[used]=0;
    if(hasLength && !--remaining)done=true;
  }
  return true;
}
bool Response::finish() {
  if(error!=Error::None)return false;
  if(!headers || !used || (chunked && !done) || (hasLength && remaining)) {error=Error::Invalid;return false;}
  done=true;return true;
}
bool parseStatus(const char* body,Snapshot& result) {
  StaticJsonDocument<384> filter;
  for(const char* k:{"state","time","length","volume"})filter[k]=true;
  filter["information"]["category"]["meta"]["title"]=true;
  filter["information"]["category"]["meta"]["filename"]=true;
  DynamicJsonDocument doc(3072);
  if(deserializeJson(doc,body,DeserializationOption::Filter(filter),DeserializationOption::NestingLimit(12)))return false;
  const char* state=doc["state"]|"";
  if(strcmp(state,"playing") && strcmp(state,"paused") && strcmp(state,"stopped"))return false;
  for(const char* k:{"time","length","volume"})if(!doc[k].is<int>() || doc[k].as<int>()<0)return false;
  if(doc["volume"].as<int>()>1024)return false;
  Snapshot next=result;
  snprintf(next.playback,sizeof(next.playback),"%s",state);
  next.seconds=doc["time"];next.length=doc["length"];next.volume=doc["volume"];
  const auto meta=doc["information"]["category"]["meta"];
  const char* title=meta["title"]|meta["filename"].as<const char*>();
  snprintf(next.title,sizeof(next.title),"%s",title?title:"VLC on Mac");
  for(char* p=next.title;*p;++p)if(static_cast<unsigned char>(*p)<32)*p=' ';
  next.connected=true;next.error=Error::None;result=next;return true;
}
} // namespace vlc_remote

#ifndef VLC_REMOTE_HOST_TEST
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <ESPmDNS.h>
#include <base64.h>
#include <lwip/sockets.h>
#include <atomic>
#include <mutex>
#include <memory>
#include <new>
#include <cerrno>
#ifdef S1_ADV_VLC_PROVISIONED
#include <s1_vlc_private.h>
#endif
namespace vlc_remote { namespace {
std::atomic<bool> owned{false}, cancelled{false};
std::mutex mutex;
Snapshot current;
struct Endpoint { IPAddress ip; uint16_t port=0; const char* route=""; };
Endpoint cached;
bool mdnsReady=false;
struct Work {Config config;Command command;bool discover;};
uint32_t numeric(IPAddress ip){return uint32_t(ip[0])<<24|uint32_t(ip[1])<<16|uint32_t(ip[2])<<8|ip[3];}
bool safe(IPAddress ip) {
  auto addr=numeric(ip),local=numeric(WiFi.localIP()),mask=numeric(WiFi.subnetMask());
  return privateIpv4(addr) && mask && ((addr&mask)==(local&mask)) &&
         (addr&~mask)!=0 && (addr&~mask)!=~mask && addr!=local;
}
bool same(Endpoint a,Endpoint b){return a.ip==b.ip && a.port==b.port;}
bool hostMatches(String a,const char* expected) {
  a.toLowerCase();String b(expected);b.toLowerCase();
  if(a.endsWith(".local"))a.remove(a.length()-6);
  if(b.endsWith(".local"))b.remove(b.length()-6);
  return a==b;
}
Error request(const Config& config,Endpoint endpoint,Command command,Snapshot& result) {
  if(cancelled)return Error::Cancelled;
  if(!safe(endpoint.ip) || !endpoint.port)return Error::NoHost;
  WiFiClient client;
  const uint32_t began=millis();
  if(!client.connect(endpoint.ip,endpoint.port,800))return Error::Connect;
  // Build only a header, never a credential-bearing URL or diagnostic.
  const String auth=base64::encode(String(":")+config.password);
  String wire=String("GET ")+path(command)+" HTTP/1.0\r\nHost: "+endpoint.ip.toString()+":"+String(endpoint.port)+
    "\r\nAuthorization: Basic "+auth+"\r\nAccept: application/json\r\nConnection: close\r\n\r\n";
  size_t sent=0;
  while(sent<wire.length()) {
    if(cancelled){client.stop();return Error::Cancelled;}
    if(millis()-began>2300){client.stop();return Error::Timeout;}
    int n=::send(client.fd(),wire.c_str()+sent,wire.length()-sent,MSG_DONTWAIT);
    if(n>0)sent+=n;
    else if(n<0 && errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR){client.stop();return Error::Connect;}
    else vTaskDelay(pdMS_TO_TICKS(5));
  }
  wire=""; // Never retain a request header in a result/UI/log.
  std::unique_ptr<Response> response(new(std::nothrow) Response);
  if(!response){client.stop();return Error::Memory;}
  while(!response->done && response->error==Error::None) {
    if(cancelled){client.stop();return Error::Cancelled;}
    if(millis()-began>2300){client.stop();return Error::Timeout;}
    int available=client.available();
    if(available>0) {
      uint8_t bytes[256];int n=client.read(bytes,std::min(available,int(sizeof(bytes))));
      for(int i=0;i<n;++i)if(!response->feed(bytes[i]))break;
    } else if(!client.connected())break;
    else vTaskDelay(pdMS_TO_TICKS(5));
  }
  client.stop();result.http=response->status;
  if(!response->finish())return response->error;
  if(!parseStatus(response->body,result))return Error::Invalid;
  snprintf(result.route,sizeof(result.route),"%s",endpoint.route);
  return Error::None;
}
void worker(void* arg) {
  std::unique_ptr<Work> work(static_cast<Work*>(arg));
  Snapshot result;Endpoint selected;
  Error error=Error::NoHost;
  if(WiFi.status()!=WL_CONNECTED)error=Error::NoWifi;
  else if(work->discover) {
    // Discovery is read-only. Only a successful status request arms controls.
    // Never deliver a non-idempotent command to multiple candidates.
    Endpoint candidates[6];unsigned count=0;
    auto add=[&](IPAddress ip,uint16_t port,const char* route){
      Endpoint e{ip,port,route};if(!safe(ip)||!port)return;
      for(unsigned i=0;i<count;++i)if(same(candidates[i],e))return;
      if(count<6)candidates[count++]=e;
    };
    if(!mdnsReady)mdnsReady=MDNS.begin("s1-adv-vlc-remote");
    if(mdnsReady && !cancelled) {
      const int found=MDNS.queryService("vlc-http","tcp"); // SDK bound: 3000 ms.
      for(int i=0;i<found && count<4;++i)
        if(hostMatches(MDNS.hostname(i),work->config.host))add(MDNS.IP(i),MDNS.port(i),"Bonjour");
    }
    // Resolve/try fallbacks lazily, preserving the required preference order.
    auto probe=[&](){
      for(unsigned i=0;i<count && !cancelled;++i) {
        result=Snapshot{};error=request(work->config,candidates[i],Command::Status,result);
        if(error==Error::None){selected=candidates[i];return true;}
        if(error==Error::Auth || error==Error::Cancelled)return true;
      }
      return false;
    };
    bool terminal=probe();
    if(!terminal && mdnsReady && !cancelled) {
      String hostname(work->config.host);hostname.remove(hostname.length()-6);
      count=0;add(MDNS.queryHost(hostname,1000),work->config.port,"Hostname");terminal=probe();
    }
    if(!terminal && !cancelled) {
      IPAddress ip;count=0;
      if(ip.fromString(work->config.fallback))add(ip,work->config.port,"LAN fallback");
      probe();
    }
  } else {
    {std::lock_guard<std::mutex> lock(mutex);selected=cached;}
    error=request(work->config,selected,work->command,result);
  }
  if(cancelled)error=Error::Cancelled;
  result.error=error;result.connected=error==Error::None;
  {
    std::lock_guard<std::mutex> lock(mutex);
    result.revision=current.revision+1;current=result;
    cached=error==Error::None?selected:Endpoint{};
  }
  work.reset();owned=false;vTaskDelete(nullptr);
}
} // namespace
Config defaults() {
  Config c;
#ifdef S1_ADV_VLC_PROVISIONED
  snprintf(c.host,sizeof(c.host),"%s",kVlc_host);
  snprintf(c.fallback,sizeof(c.fallback),"%s",kVlc_fallback_ip);
  snprintf(c.password,sizeof(c.password),"%s",kVlc_password);
  c.port=kVlc_port;
#endif
  return c;
}
bool busy(){return owned.load();}
void cancel(){cancelled=true;}
Snapshot snapshot(){std::lock_guard<std::mutex> lock(mutex);return current;}
bool start(const Config& config,Command command,bool discover) {
  bool expected=false;
  if(!owned.compare_exchange_strong(expected,true))return false;
  Error error=Error::None;
  if(!configured(config))error=Error::NotConfigured;
  else if(WiFi.status()!=WL_CONNECTED)error=Error::NoWifi;
  else if(!path(command) || (discover && command!=Command::Status))error=Error::Invalid;
  else if(!discover && !snapshot().connected)error=Error::NoHost;
  if(error==Error::None && ESP.getFreeHeap()<50000)error=Error::Memory;
  if(error==Error::None) {
    auto work=new(std::nothrow) Work{config,command,discover};cancelled=false;
    if(work && xTaskCreate(worker,"vlc_remote",6144,work,1,nullptr)==pdPASS)return true;
    delete work;error=Error::Memory;
  }
  {std::lock_guard<std::mutex> lock(mutex);current.connected=false;current.error=error;++current.revision;}
  owned=false;return false;
}
} // namespace vlc_remote
#endif
