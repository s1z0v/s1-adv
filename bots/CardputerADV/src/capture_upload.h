#pragma once
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <new>

namespace capture_upload {
struct State {
  std::atomic<size_t> published{0}, sent{0};
  std::atomic<bool> finished{false}, cancelled{false}, commitAttempted{false};
  std::atomic<bool> responseAvailable{false};
  std::atomic<bool> storageFailed{false};
  std::atomic<uint32_t> firstSentMs{0};
};

// The producer publishes only flushed PCM bytes. Reader copies a committed
// range under its file lock; no filesystem lock is held across a socket write.
// Only the explicit, validated button release sets finished. A failed or
// cancelled recording must never emit the HTTP message's final zero chunk.
template <typename Client, typename Reader, typename Wait, typename Clock>
bool sendBody(Client& client, State& state, Reader read, Wait wait, Clock now,
              size_t maxBytes, uint32_t timeoutMs) {
  constexpr size_t kChunk = 4096;
  std::unique_ptr<uint8_t[]> buffer(new (std::nothrow) uint8_t[kChunk]);
  if (!buffer) return false;
  const uint32_t started = now();
  auto alive = [&] {
    if (client.available() > 0) state.responseAvailable.store(true);
    return !state.cancelled.load() && client.connected() &&
           !state.responseAvailable.load() && now() - started < timeoutMs;
  };
  auto write = [&](const uint8_t* bytes, size_t size) {
    size_t offset = 0;
    while (offset < size && alive()) {
      const size_t n = client.write(bytes + offset, size - offset);
      if (!n || n > size - offset) return false;
      offset += n;
    }
    return offset == size && !state.cancelled.load();
  };
  while (alive()) {
    // Reading finished first prevents a release racing an old length snapshot
    // from terminating the request before its final PCM bytes are sent.
    const bool complete = state.finished.load();
    const size_t length = state.published.load();
    const size_t offset = state.sent.load();
    if (length > maxBytes || length < offset) return false;
    if (length > offset) {
      const size_t count = std::min(kChunk, length - offset);
      if ((count & 1U) || read(offset, buffer.get(), count) != count) return false;
      char header[24];
      const int n = std::snprintf(header, sizeof(header), "%x\r\n", static_cast<unsigned>(count));
      if (!write(reinterpret_cast<const uint8_t*>(header), n) ||
          !write(buffer.get(), count) ||
          !write(reinterpret_cast<const uint8_t*>("\r\n"), 2)) return false;
      if (!state.firstSentMs.load()) state.firstSentMs.store(now());
      state.sent.store(offset + count);
    } else if (complete) {
      if (!length || (length & 1U)) return false;
      state.commitAttempted.store(true);
      return write(reinterpret_cast<const uint8_t*>("0\r\n\r\n"), 5);
    } else wait();
  }
  return false;
}
}  // namespace capture_upload
