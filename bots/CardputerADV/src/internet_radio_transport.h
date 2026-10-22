#pragma once
#include <stddef.h>
#include <stdint.h>

namespace internet_radio {
enum class State : uint8_t { Idle, Connecting, Buffering, Playing, Stopping, Error };
enum class Error : uint8_t {
  None, InvalidUrl, PublicHttpOnly, NoMemory, TaskFailed, Dns, Connect,
  Timeout, Http, Unsupported, Malformed, Redirect, Decode, Speaker
};
// Sole producer on virtual speaker channel 7. Integration must reserve that
// channel and must not globally stop/end the speaker until busy() is false.
// start copies URL (max 511 bytes), returns false if busy or invalid URL.
// stop is cancellation only; poll busy() before switching stations/audio modes.
bool start(const char* url);
void stop();
bool busy();
State state();
Error error();
const char* status();  // Immutable literals; no shared String access.
const char* statusText();  // UI alias of status(); immutable short status/error.
const char* errorMessage();  // nullptr when Error::None; immutable error text.
uint32_t bytes();     // Decoded transport audio bytes (wraps at UINT32_MAX).

// Portable production parsers, also exercised by host tests. No allocation.
namespace detail {
constexpr size_t kUrlSize = 512;
struct Url { char host[128]{}; char path[384]{}; uint16_t port = 80; };
bool parseUrl(const char*, Url&);
bool publicIpv4(uint32_t hostOrder);
struct Headers {
  unsigned status = 0, total = 0;
  uint32_t metaint = 0, length = 0;
  bool chunked = false, hasLength = false, hasType = false;
  bool hasTransfer = false, hasMeta = false, hasLocation = false, done = false;
  char location[kUrlSize]{};
  Error line(const char*);  // Lines exclude CRLF; empty line finalizes.
};
class Body {
 public:
  explicit Body(const Headers&);
  // Feed exactly once per wire byte: 1=audio, 0=framing/metadata, -1=error.
  int feed(uint8_t byte);
  bool done() const { return ended_; }
  bool complete() const; // EOF is legal only outside chunk/meta framing.
 private:
  int entity(uint8_t);
  enum class Phase : uint8_t { Size, SizeLF, Data, DataCR, DataLF, EndCR, EndLF };
  Phase phase_ = Phase::Size;
  bool chunked_, bounded_, ended_ = false, bad_ = false;
  uint32_t remaining_, chunk_ = 0, interval_, audioLeft_, metadata_ = 0;
  uint8_t digits_ = 0;
};
}  // namespace detail
}  // namespace internet_radio
