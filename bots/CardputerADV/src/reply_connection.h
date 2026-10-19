#pragma once
#include <cstdint>
#include <cstring>
#include <memory>

namespace reply_connection {
// A completely consumed HTTP response may hand its socket to one immediate
// TTS request at the same origin. Ownership never spans two workers.
template <typename Client> class OneShot {
 public:
  static constexpr uint32_t kMaxHoldMs = 5000;
  void clear() { client_.reset(); }
  bool empty() const { return !client_; }
  void expire(uint32_t now) {
    if (client_ && now - retainedAt_ >= kMaxHoldMs) clear();
  }
  bool retain(std::unique_ptr<Client> client, const char* host, uint16_t port, uint32_t now) {
    clear();
    if (!client || !host || !*host || std::strlen(host) >= sizeof(host_) || !client->connected()) return false;
    std::strcpy(host_, host);
    port_ = port;
    retainedAt_ = now;
    client_ = std::move(client);
    return true;
  }
  std::unique_ptr<Client> take(const char* host, uint16_t port, uint32_t now) {
    expire(now);
    if (client_ && (!host || port != port_ || std::strcmp(host, host_) != 0 || !client_->connected())) clear();
    return std::move(client_);
  }
 private:
  std::unique_ptr<Client> client_;
  char host_[254]{};
  uint16_t port_ = 0;
  uint32_t retainedAt_ = 0;
};
}  // namespace reply_connection
