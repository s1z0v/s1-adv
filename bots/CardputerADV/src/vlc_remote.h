#pragma once
#include <cstdint>

namespace vlc_remote {
enum class Command : uint8_t { Status, Toggle, Stop, Next, Previous, VolumeUp, VolumeDown, Forward, Back };
enum class Error : uint8_t { None, NotConfigured, NoWifi, NoHost, Connect, Timeout, Auth, Http, Invalid, TooLarge, Cancelled, Memory };
struct Config { char host[128]={}, fallback[16]={}, username[1]={}, password[129]={}; uint16_t port=8080; };
struct Snapshot {
  bool connected=false;
  Error error=Error::None;
  int http=0, seconds=0, length=0, volume=0;
  char playback[12]={}, title[96]={}, route[16]={};
  uint32_t revision=0;
};
Config defaults();
bool configured(const Config& config);
bool start(const Config& config, Command command, bool discover=false);
void cancel();
bool busy();
Snapshot snapshot();
const char* message(Error error);
const char* path(Command command);
bool privateIpv4(uint32_t ip);
// Strict HTTP framing, bounded headers/body; portable for host regression.
struct Response {
  static constexpr unsigned kBodyLimit=12288;
  char body[kBodyLimit+1]={};
  char line[512]={};
  unsigned used=0, lineUsed=0, headerBytes=0, remaining=0, chunk=0, digits=0;
  int status=0, phase=0;
  bool headers=false, hasLength=false, chunked=false, hasType=false, done=false;
  Error error=Error::None;
  bool feed(uint8_t byte);
  bool finish();
};
bool parseStatus(const char* body, Snapshot& result);
} // namespace vlc_remote
