#include "internet_radio_transport.h"
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <atomic>
// Upstream lieff/minimp3, CC0: vendor/minimp3.LICENSE.
// Pinned official source: https://github.com/lieff/minimp3
// Commit ea99364f61c14656440e8d77e9c233ccf3124633 (2026-10-22 retrieval).
#define MINIMP3_ONLY_MP3
#define MINIMP3_NO_SIMD
#define MINIMP3_IMPLEMENTATION
#include "vendor/minimp3.h"

namespace internet_radio { namespace detail {
static bool number(const char* s, uint32_t& n, uint32_t max) {
  if (!*s) return false;
  n = 0;
  for (; *s; ++s) {
    if (*s < '0' || *s > '9' || n > (max - unsigned(*s - '0')) / 10) return false;
    n = n * 10 + unsigned(*s - '0');
  }
  return true;
}
bool parseUrl(const char* s, Url& out) {
  if (!s || strnlen(s, kUrlSize) >= kUrlSize || strncmp(s, "http://", 7)) return false;
  Url u;
  const char* p = s + 7; const char* begin = p;
  while (*p && *p != '/' && *p != ':' && *p != '?') {
    if (!(isalnum(static_cast<unsigned char>(*p)) || *p == '.' || *p == '-')) return false;
    ++p;
  }
  size_t n = p - begin;
  if (!n || n >= sizeof(u.host)) return false;
  memcpy(u.host, begin, n); u.host[n] = 0;
  if (*p == ':') {
    const char* port = ++p; while (isdigit(static_cast<unsigned char>(*p))) ++p;
    char b[6]; n = p - port; if (!n || n >= sizeof(b)) return false;
    memcpy(b, port, n); b[n] = 0; uint32_t value;
    if (!number(b, value, 65535) || !value) return false;
    u.port = value;
  }
  if (!*p) strcpy(u.path, "/");
  else {
    if (*p != '/' || strlen(p) >= sizeof(u.path)) return false;
    for (const char* q = p; *q; ++q)
      if (static_cast<unsigned char>(*q) <= 32 || static_cast<unsigned char>(*q) >= 127 || *q == '#' || *q == '@' || *q == '\\') return false;
    strcpy(u.path, p);
  }
  out = u; return true;
}
bool publicIpv4(uint32_t ip) {
  unsigned a = ip >> 24, b = (ip >> 16) & 255, c = (ip >> 8) & 255;
  return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
    (a == 100 && b >= 64 && b <= 127) || (a == 169 && b == 254) ||
    (a == 172 && b >= 16 && b <= 31) || (a == 192 && (b == 168 || b == 0)) ||
    (a == 192 && b == 2) || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100))) ||
    (a == 203 && b == 0 && c == 113));
}
Error Headers::line(const char* s) {
  total += strlen(s) + 2;
  if (done || total > 8192 || strlen(s) > 767) return Error::Malformed;
  if (!status) {
    if (!strncmp(s, "HTTP/1.0 ", 9) || !strncmp(s, "HTTP/1.1 ", 9)) s += 9;
    else if (!strncmp(s, "ICY ", 4)) s += 4;
    else return Error::Malformed;
    if (strlen(s) < 3 || !isdigit(s[0]) || !isdigit(s[1]) || !isdigit(s[2]) || (s[3] && s[3] != ' ')) return Error::Malformed;
    status = (s[0]-'0')*100 + (s[1]-'0')*10 + s[2]-'0';
    return status >= 100 && status <= 599 ? Error::None : Error::Malformed;
  }
  if (!*s) {
    done = true;
    if (chunked && hasLength) return Error::Malformed;
    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308)
      return hasLocation ? Error::None : Error::Redirect;
    if (status != 200) return Error::Http;
    return hasType ? Error::None : Error::Unsupported;
  }
  const char* colon = strchr(s, ':');
  if (!colon || colon == s) return Error::Malformed;
  char name[128]; size_t len = colon-s;
  if (len >= sizeof(name)) return Error::Malformed;
  for (size_t i=0;i<len;++i) {
    unsigned char c = s[i]; if (!(isalnum(c) || c == '-')) return Error::Malformed;
    name[i] = tolower(c);
  }
  name[len] = 0;
  s = colon+1; while (*s == ' ' || *s == '\t') ++s;
  char value[768]; len = strlen(s); while (len && (s[len-1] == ' ' || s[len-1] == '\t')) --len;
  for (size_t i=0;i<len;++i) { unsigned char c=s[i]; if ((c < 32 && c != '\t') || c == 127) return Error::Malformed; value[i]=c; }
  value[len]=0;
  if (!strcmp(name,"location")) {
    if (hasLocation || len >= sizeof(location)) return Error::Malformed;
    hasLocation = true; strcpy(location,value);
  } else if (!strcmp(name,"content-type")) {
    if (hasType) return Error::Malformed;
    char* semi = strchr(value,';'); if (semi) *semi=0;
    for (char* p=value;*p;++p) *p=tolower(static_cast<unsigned char>(*p));
    if (status == 200 && strcmp(value,"audio/mpeg") && strcmp(value,"audio/mp3")) return Error::Unsupported;
    hasType=true;
  } else if (!strcmp(name,"transfer-encoding")) {
    if (hasTransfer || strcasecmp(value,"chunked")) return Error::Malformed;
    hasTransfer=true; chunked=true;
  } else if (!strcmp(name,"content-length")) {
    if (hasLength || !number(value,length,0x7fffffff)) return Error::Malformed;
    hasLength=true;
  } else if (!strcmp(name,"icy-metaint")) {
    if (hasMeta || !number(value,metaint,16*1024*1024) || !metaint) return Error::Malformed;
    hasMeta=true;
  } else if (!strcmp(name,"content-encoding") && strcasecmp(value,"identity")) return Error::Unsupported;
  return Error::None;
}
Body::Body(const Headers& h) : chunked_(h.chunked), bounded_(h.hasLength),
  remaining_(h.length), interval_(h.metaint), audioLeft_(h.metaint) {
  if (bounded_ && !remaining_) ended_=true;
}
int Body::entity(uint8_t b) {
  if (!interval_) return 1;
  if (metadata_) { --metadata_; if (!metadata_) audioLeft_=interval_; return 0; }
  if (audioLeft_) { --audioLeft_; return 1; }
  metadata_=unsigned(b)*16; if (!metadata_) audioLeft_=interval_; return 0;
}
int Body::feed(uint8_t b) {
  if (bad_ || ended_) { bad_=true; return -1; }
  if (!chunked_) {
    int r=entity(b); if (bounded_ && --remaining_ == 0) ended_=true; return r;
  }
  switch (phase_) {
    case Phase::Size: {
      int d = b>='0'&&b<='9' ? b-'0' : b>='a'&&b<='f' ? b-'a'+10 : b>='A'&&b<='F' ? b-'A'+10 : -1;
      if (d>=0 && digits_<8 && chunk_ <= (1024*1024-unsigned(d))/16) { chunk_=chunk_*16+d; ++digits_; return 0; }
      if (b=='\r' && digits_) { phase_=Phase::SizeLF; return 0; }
      break; // Strict subset: extensions/trailers are rejected, not misparsed.
    }
    case Phase::SizeLF: if (b=='\n') { phase_=chunk_ ? Phase::Data : Phase::EndCR; return 0; } break;
    case Phase::Data: { int r=entity(b); if (!--chunk_) phase_=Phase::DataCR; return r; }
    case Phase::DataCR: if (b=='\r') { phase_=Phase::DataLF; return 0; } break;
    case Phase::DataLF: if (b=='\n') { phase_=Phase::Size; digits_=0; return 0; } break;
    case Phase::EndCR: if (b=='\r') { phase_=Phase::EndLF; return 0; } break;
    case Phase::EndLF: if (b=='\n' && !metadata_ && (!interval_ || audioLeft_)) { ended_=true; return 0; } break;
  }
  bad_=true; return -1;
}
bool Body::complete() const {
  return !bad_ && (!chunked_ || ended_) && (!bounded_ || !remaining_) && !metadata_ && (!interval_ || audioLeft_);
}
} } // namespace internet_radio::detail

#ifndef INTERNET_RADIO_HOST_TEST
#include <Arduino.h>
#include <WiFi.h>
#include <M5Cardputer.h>
#include <esp_heap_caps.h>
#include <lwip/dns.h>
#include <lwip/tcpip.h>
#include <lwip/sockets.h>
#include <errno.h>

namespace internet_radio {
namespace {
constexpr uint8_t kChannel=7;
constexpr size_t kInput=8192;
constexpr uint32_t kIdleMs=5000, kHeaderMs=8000;
std::atomic<State> current{State::Idle};
std::atomic<Error> failure{Error::None};
std::atomic<bool> owned{false}, cancel{false};
std::atomic<uint32_t> received{0};
portMUX_TYPE gate=portMUX_INITIALIZER_UNLOCKED;
char requested[detail::kUrlSize];
// lwIP DNS callbacks may outlive a cancelled worker. Static storage deliberately
// survives it; a new lookup is refused until the previous callback completes.
std::atomic<bool> dnsPending{false}, dnsReady{false};
std::atomic<uint32_t> dnsAddress{0};
char dnsName[128];
void dnsFound(const char*, const ip_addr_t* addr, void*) {
  uint32_t v=0;
  if (addr && IP_IS_V4(addr)) v=lwip_ntohl(ip4_addr_get_u32(ip_2_ip4(addr)));
  dnsAddress.store(v); dnsReady.store(true); dnsPending.store(false);
}
void dnsBegin(void*) {
  ip_addr_t addr;
  err_t r=dns_gethostbyname(dnsName,&addr,dnsFound,nullptr);
  if (r==ERR_OK) dnsFound(nullptr,&addr,nullptr);
  else if (r!=ERR_INPROGRESS) dnsFound(nullptr,nullptr,nullptr);
}
Error resolve(const char* host, IPAddress& ip) {
  if (ip.fromString(host)) {
    uint32_t v=(uint32_t(ip[0])<<24)|(uint32_t(ip[1])<<16)|(uint32_t(ip[2])<<8)|ip[3];
    return detail::publicIpv4(v) ? Error::None : Error::PublicHttpOnly;
  }
  if (dnsPending.load()) return Error::Dns;
  strcpy(dnsName,host); dnsReady.store(false); dnsAddress.store(0); dnsPending.store(true);
  if (tcpip_callback(dnsBegin,nullptr)!=ERR_OK) { dnsPending.store(false); return Error::Dns; }
  uint32_t began=millis();
  while (!dnsReady.load() && !cancel.load() && millis()-began<4000) vTaskDelay(pdMS_TO_TICKS(10));
  if (cancel.load()) return Error::None;
  if (!dnsReady.load()) return Error::Timeout;
  uint32_t v=dnsAddress.load();
  if (!v) return Error::Dns;
  if (!detail::publicIpv4(v)) return Error::PublicHttpOnly;
  ip=IPAddress(v>>24,(v>>16)&255,(v>>8)&255,v&255); return Error::None;
}
// Buffered socket reader: no readString / unbounded blocking Stream calls.
struct Reader {
  WiFiClient& tcp; uint8_t buf[512]{}; size_t pos=0, count=0;
  uint32_t last=millis();
  int next() {
    for (;;) {
      if (cancel.load()) return -3;
      if (pos<count) return buf[pos++];
      int avail=tcp.available();
      if (avail>0) { int n=tcp.read(buf,avail>int(sizeof(buf))?sizeof(buf):avail); if(n>0) {pos=0;count=n;last=millis();continue;} }
      if (!tcp.connected() && !tcp.available()) return -1;
      if (millis()-last>=kIdleMs) return -2;
      vTaskDelay(pdMS_TO_TICKS(2));
    }
  }
};
Error readHeaders(Reader& r, detail::Headers& h) {
  char line[768]; size_t n=0; bool cr=false; uint32_t start=millis();
  while (!h.done && !cancel.load()) {
    if (millis()-start>kHeaderMs) return Error::Timeout;
    int b=r.next(); if (b<0) return b==-2 ? Error::Timeout : Error::Malformed;
    if (cr) {
      if (b!='\n') return Error::Malformed;
      line[n]=0; Error e=h.line(line); if (e!=Error::None) return e;
      n=0; cr=false;
    } else if (b=='\r') cr=true;
    else { if (b=='\n' || b==0 || n>=sizeof(line)-1) return Error::Malformed; line[n++]=char(b); }
  }
  return Error::None;
}
void setState(State s) { portENTER_CRITICAL(&gate); if (!cancel.load()) current.store(s); portEXIT_CRITICAL(&gate); }
Error sendRequest(WiFiClient& tcp, const char* data, size_t size) {
  size_t sent=0; uint32_t began=millis();
  while(sent<size && !cancel.load()) {
    int n=::send(tcp.fd(),data+sent,size-sent,MSG_DONTWAIT);
    if(n>0) sent+=n;
    else if(n==0 || (errno!=EAGAIN && errno!=EWOULDBLOCK && errno!=EINTR)) return Error::Connect;
    if(millis()-began>1000) return Error::Timeout;
    if(sent<size) vTaskDelay(pdMS_TO_TICKS(2));
  }
  return Error::None;
}
Error stream(WiFiClient& tcp, mp3dec_t* decoder, uint8_t* input, int16_t* pcm[2]) {
  detail::Url url; if (!detail::parseUrl(requested,url)) return Error::InvalidUrl;
  for (unsigned redirect=0;redirect<=3 && !cancel.load();++redirect) {
    setState(State::Connecting);
    IPAddress ip; Error e=resolve(url.host,ip); if(e!=Error::None || cancel.load()) return e;
    // Numeric connect after DNS/IP validation prevents DNS rebinding.
    tcp.setTimeout(1);
    if (!tcp.connect(ip,url.port,600)) return Error::Connect;
    char request[768]; int n=snprintf(request,sizeof(request),
      "GET %s HTTP/1.1\r\nHost: %s:%u\r\nUser-Agent: S1-ADV-Radio/1\r\nAccept: audio/mpeg\r\nAccept-Encoding: identity\r\nIcy-MetaData: 1\r\nConnection: close\r\n\r\n",url.path,url.host,url.port);
    if (n<=0 || size_t(n)>=sizeof(request)) return Error::Connect;
    e=sendRequest(tcp,request,n); if(e!=Error::None || cancel.load()) return e;
    Reader r{tcp}; detail::Headers h; e=readHeaders(r,h);
    if(e!=Error::None || cancel.load()) return e;
    if(h.status!=200) {
      tcp.stop(); if(redirect==3) return Error::Redirect;
      detail::Url next;
      if (h.location[0]=='/' && h.location[1]!='/') {
        char absolute[detail::kUrlSize]; int len=snprintf(absolute,sizeof(absolute),"http://%s:%u%s",url.host,url.port,h.location);
        if(len<=0 || size_t(len)>=sizeof(absolute) || !detail::parseUrl(absolute,next)) return Error::Redirect;
      } else if(!detail::parseUrl(h.location,next)) return Error::Redirect;
      url=next; continue;
    }
    detail::Body body(h); size_t used=0; unsigned slot=0, junk=0;
    bool played=false; uint32_t lastFrame=millis();
    mp3dec_init(decoder); setState(State::Buffering);
    while (!cancel.load()) {
      // Single producer, alternating buffers, no stop markers: M5Unified
      // documents isPlaying(channel)<2 as safe to reuse the older PCM slot.
      // Keep the next frame queued to avoid a gap at every MP3 boundary.
      uint32_t wait=millis();
      while (M5Cardputer.Speaker.isPlaying(kChannel) >= 2 && !cancel.load()) {
        if(millis()-wait>1500) return Error::Speaker;
        vTaskDelay(pdMS_TO_TICKS(2));
      }
      if(cancel.load()) break;
      uint32_t fed=0;
      while (used<kInput && !body.done() && !cancel.load()) {
        if(++fed>128*1024 || millis()-lastFrame>8000) return Error::Decode;
        int b=r.next();
        if (b<0) {
          if (b==-3) return Error::None;
          if(b==-2) return Error::Timeout;
          if(!body.complete()) return Error::Malformed;
          // Decode the remaining bytes before treating EOF as finished.
          break;
        }
        int kind=body.feed(uint8_t(b)); if(kind<0) return Error::Malformed;
        if(kind==1) {input[used++]=b; received.fetch_add(1);}
        // A useful MP3 input window; never download the full stream.
        if (used>=4096) break;
      }
      if(cancel.load()) break;
      mp3dec_frame_info_t info{};
      int samples=mp3dec_decode_frame(decoder,input,used,pcm[slot],&info);
      if(info.frame_bytes<0 || size_t(info.frame_bytes)>used) return Error::Decode;
      if(samples>0) {
        if(info.layer!=3 || (info.channels!=1 && info.channels!=2) || info.hz<8000 || info.hz>48000 || samples>1152) return Error::Decode;
        if(!M5Cardputer.Speaker.playRaw(pcm[slot],samples*info.channels,info.hz,info.channels==2,1,kChannel,false)) return Error::Speaker;
        slot^=1; played=true; junk=0; lastFrame=millis(); setState(State::Playing);
      }
      size_t consumed=info.frame_bytes;
      if(!consumed && used==kInput) consumed=used-2048;
      if(!samples) junk+=consumed;
      if(consumed) {used-=consumed;memmove(input,input+consumed,used);}
      if(junk>65536 || millis()-lastFrame>8000) return Error::Decode;
      if(body.done() || (!r.tcp.connected() && !r.tcp.available() && r.pos==r.count)) {
        if(samples && used) continue;
        if(!body.complete()) return Error::Malformed;
        return played ? Error::None : Error::Decode;
      }
      vTaskDelay(1);
    }
    return Error::None;
  }
  return Error::None;
}
void worker(void*) {
  Error e=Error::None;
  // All active allocations, TCP and decoder lifetime are worker-owned.
  auto* decoder=static_cast<mp3dec_t*>(heap_caps_malloc(sizeof(mp3dec_t),MALLOC_CAP_8BIT));
  auto* input=static_cast<uint8_t*>(heap_caps_malloc(kInput,MALLOC_CAP_8BIT));
  int16_t* pcm[2]={static_cast<int16_t*>(heap_caps_malloc(MINIMP3_MAX_SAMPLES_PER_FRAME*sizeof(int16_t),MALLOC_CAP_8BIT)),
                   static_cast<int16_t*>(heap_caps_malloc(MINIMP3_MAX_SAMPLES_PER_FRAME*sizeof(int16_t),MALLOC_CAP_8BIT))};
  if(!decoder || !input || !pcm[0] || !pcm[1]) e=Error::NoMemory;
  else { WiFiClient tcp; e=stream(tcp,decoder,input,pcm); tcp.stop(); }
  // Cancellation is nonblocking to the caller. Drain a single bounded MP3
  // frames naturally (at most two queued). If the speaker fails, retain buffers
  // and busy rather than free a possibly live pointer; never force-delete.
  current.store(State::Stopping);
  while(M5Cardputer.Speaker.isPlaying(kChannel)) vTaskDelay(pdMS_TO_TICKS(5));
  free(pcm[1]);free(pcm[0]);free(input);free(decoder);
  portENTER_CRITICAL(&gate);
  if(cancel.load()) e=Error::None;
  failure.store(e);current.store(e==Error::None?State::Idle:State::Error);
  owned.store(false);
  portEXIT_CRITICAL(&gate);
  vTaskDelete(nullptr);
}
} // anonymous
bool start(const char* url) {
  detail::Url parsed;
  if(!detail::parseUrl(url,parsed)) {
    portENTER_CRITICAL(&gate);
    if(!owned.load()) {failure.store(Error::InvalidUrl);current.store(State::Error);}
    portEXIT_CRITICAL(&gate);return false;
  }
  if(ESP.getFreeHeap()<65536 || heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)<24576) {
    portENTER_CRITICAL(&gate);
    if(!owned.load()) { failure.store(Error::NoMemory); current.store(State::Error); }
    portEXIT_CRITICAL(&gate); return false;
  }
  portENTER_CRITICAL(&gate);
  if(owned.load()) {portEXIT_CRITICAL(&gate);return false;}
  owned.store(true);cancel.store(false);failure.store(Error::None);received.store(0);
  strcpy(requested,url);current.store(State::Connecting);
  portEXIT_CRITICAL(&gate);
  // ESP-IDF task stack size is bytes. minimp3 has sizeable decode scratch.
  if(xTaskCreate(worker,"radio_stream",24576,nullptr,2,nullptr)!=pdPASS) {
    portENTER_CRITICAL(&gate);failure.store(Error::TaskFailed);current.store(State::Error);owned.store(false);portEXIT_CRITICAL(&gate);
    return false;
  }
  return true;
}
void stop() {portENTER_CRITICAL(&gate);if(owned.load()){cancel.store(true);current.store(State::Stopping);}portEXIT_CRITICAL(&gate);}
bool busy(){return owned.load();}
State state(){return current.load();}
Error error(){return failure.load();}
uint32_t bytes(){return received.load();}
const char* status() {
  switch(current.load()) {
    case State::Idle:return "Idle";case State::Connecting:return "Connecting";
    case State::Buffering:return "Buffering";case State::Playing:return "Playing";
    case State::Stopping:return "Stopping";case State::Error:break;
  }
  const char* msg=errorMessage(); return msg ? msg : "Radio error";
}
const char* statusText() { return status(); }
const char* errorMessage() {
  switch(failure.load()) {
    case Error::None:return nullptr;
    case Error::InvalidUrl:return "HTTP MP3 URL required";case Error::PublicHttpOnly:return "Public IPv4 HTTP only";
    case Error::NoMemory:return "Radio memory unavailable";case Error::TaskFailed:return "Radio worker unavailable";
    case Error::Dns:return "Radio DNS failed";case Error::Connect:return "Radio connection failed";
    case Error::Timeout:return "Radio timed out";case Error::Http:return "Radio HTTP error";
    case Error::Unsupported:return "Not an MP3 stream";case Error::Malformed:return "Malformed radio stream";
    case Error::Redirect:return "Radio redirect rejected";case Error::Decode:return "Invalid MP3 stream";
    case Error::Speaker:return "Radio speaker unavailable";default:return "Radio error";
  }
}
} // namespace internet_radio
#endif
