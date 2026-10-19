#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <new>

namespace realtime_transport {

// The WebSockets library's readCb waits for an entire frame. Keep incomplete
// wire frames private so that its unchanged parser only ever reads memory.
class FrameGate {
 public:
  static constexpr size_t kInlineCapacity = 2048;
  static constexpr size_t kMaxPayload = 15 * 1024;
  enum class Error { None, InvalidHeader, Oversize, OutOfMemory };
  FrameGate() = default;
  FrameGate(const FrameGate&) = delete;
  FrameGate& operator=(const FrameGate&) = delete;

  void reset() {
    overflow_.reset();
    size_ = position_ = 0;
    target_ = 2;
    lengthKnown_ = false;
    error_ = Error::None;
  }
  size_t wanted() const { return error_ == Error::None ? target_ - size_ : 0; }
  size_t buffered() const { return size_; }
  Error error() const { return error_; }
  bool ready() const { return error_ == Error::None && lengthKnown_ && size_ == target_; }
  size_t available() const { return ready() ? size_ - position_ : 0; }
  int peek() const { return available() ? data()[position_] : -1; }

  size_t append(const uint8_t* source, size_t count) {
    if (!source || !count || !wanted()) return 0;
    const size_t take = count < wanted() ? count : wanted();
    std::memcpy(data() + size_, source, take);
    size_ += take;
    if (size_ == target_ && !lengthKnown_) decodeLength();
    return take;
  }
  int read(uint8_t* destination, size_t count) {
    if (!available()) return -1;
    if (!count) return 0;
    if (!destination) return -1;
    const size_t take = count < available() ? count : available();
    std::memcpy(destination, data() + position_, take);
    position_ += take;
    if (position_ == size_) reset();
    return static_cast<int>(take);
  }

 private:
  uint8_t inline_[kInlineCapacity];
  std::unique_ptr<uint8_t[]> overflow_;
  size_t size_ = 0, position_ = 0, target_ = 2;
  bool lengthKnown_ = false;
  Error error_ = Error::None;
  uint8_t* data() { return overflow_ ? overflow_.get() : inline_; }
  const uint8_t* data() const { return overflow_ ? overflow_.get() : inline_; }

  void decodeLength() {
    const uint8_t* header = data();
    const uint8_t opcode = header[0] & 15;
    const uint8_t marker = header[1] & 127;
    const bool control = opcode >= 8;
    if ((header[0] & 0x70) || (header[1] & 0x80) ||
        !(opcode == 0 || opcode == 1 || opcode == 2 ||
          opcode == 8 || opcode == 9 || opcode == 10) ||
        (control && (!(header[0] & 0x80) || marker > 125))) {
      error_ = Error::InvalidHeader;
      return;
    }
    const size_t headerSize = marker < 126 ? 2 : (marker == 126 ? 4 : 10);
    if (size_ < headerSize) { target_ = headerSize; return; }
    uint64_t payload = marker;
    if (marker >= 126) {
      payload = 0;
      for (size_t i = 2; i < headerSize; ++i) payload = (payload << 8) | header[i];
      if ((marker == 126 && payload < 126) ||
          (marker == 127 && payload < 65536)) {
        error_ = Error::InvalidHeader;
        return;
      }
    }
    if (payload > kMaxPayload) { error_ = Error::Oversize; return; }
    if (opcode == 8 && payload == 1) { error_ = Error::InvalidHeader; return; }
    target_ = headerSize + static_cast<size_t>(payload);
    if (target_ > kInlineCapacity) {
      std::unique_ptr<uint8_t[]> larger(new (std::nothrow) uint8_t[target_]);
      if (!larger) { error_ = Error::OutOfMemory; return; }
      std::memcpy(larger.get(), inline_, size_);
      overflow_ = std::move(larger);
    }
    lengthKnown_ = true;
  }
};
} // namespace realtime_transport
