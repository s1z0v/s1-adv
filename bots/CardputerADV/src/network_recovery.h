#pragma once
#include <cstdint>

namespace network_recovery {
// One reassociation after a failed transport streak. A successful application
// exchange rearms it; a server outage cannot cause an endless reconnect loop.
class Policy {
 public:
  static constexpr uint32_t kGraceMs = 1000;
  static constexpr uint32_t kCooldownMs = 60000;
  void failure(uint32_t now) {
    if (failures_ == 0) firstFailure_ = now;
    if (failures_ < 3) ++failures_;
  }
  void streamLost(uint32_t now) {
    failure(now);
    failures_ = 3;
  }
  void success() { failures_ = 0; spent_ = false; }
  bool takeReconnect(uint32_t now, bool idle, bool associated) {
    if (!idle || !associated || spent_ || failures_ < 3 ||
        now - firstFailure_ < kGraceMs ||
        (attempted_ && now - lastAttempt_ < kCooldownMs)) return false;
    spent_ = attempted_ = true;
    lastAttempt_ = now;
    return true;
  }
 private:
  uint32_t firstFailure_ = 0, lastAttempt_ = 0;
  uint8_t failures_ = 0;
  bool spent_ = false, attempted_ = false;
};
}  // namespace network_recovery
