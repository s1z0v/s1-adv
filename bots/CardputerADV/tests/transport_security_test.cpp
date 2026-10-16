#include "../src/transport_security.h"
#include <cassert>

int main() {
  using namespace transport_security;
  const char* origin = "https://bridge.example.com:443";
  assert(sameBridgeOrigin("https://bridge.example.com/file.bin", origin));
  assert(sameBridgeOrigin("https://BRIDGE.example.com:443/file.bin", origin));
  assert(sameBridgeOrigin("https://bridge.example.com:8443/x", "https://bridge.example.com:8443"));
  for (const char* url : {"http://bridge.example.com/x", "https://evil.example/x",
      "https://bridge.example.com.evil.example/x", "https://bridge.example.com@evil.example/x",
      "https://bridge.example.com:444/x", "https://bridge.example.com:/x", "https://bridge.example.com:65536/x",
      "https://bridge.example.com%2fevil/x", "https://bridge.example.com\\@evil/x", "//evil.example/x"}) {
    assert(!sameBridgeOrigin(url, origin));
  }
  assert(safeAssetPath("/pomodoro/audio/focus/start.wav"));
  assert(!safeAssetPath("/pomodoro/audio/../../firmware.bin"));
  assert(!safeAssetPath("/other/config.json"));
}
