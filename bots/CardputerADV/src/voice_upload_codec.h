#pragma once
#include <cstdint>
#include <cstddef>
#include <cstring>

// 24 kHz PCM16 -> 16 kHz logarithmic PCM. Two area-weighted samples
// replace each three source samples; mu-law keeps quiet speech useful.
namespace voice_upload {
constexpr uint32_t sampleRate = 16000;
constexpr size_t headerBytes = 58;
inline uint8_t mulaw(int32_t pcm) {
  const uint8_t sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  if (pcm > 32635) pcm = 32635;
  pcm += 132;
  unsigned exponent = 7;
  for (int32_t mask = 0x4000; exponent && !(pcm & mask); mask >>= 1) --exponent;
  return static_cast<uint8_t>(~(sign | (exponent << 4) | ((pcm >> (exponent + 3)) & 15)));
}
inline size_t encodedBytes(size_t pcmBytes) { return ((pcmBytes / 2) * 2 + 2) / 3; }
inline void put16(uint8_t* p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
inline void put32(uint8_t* p, uint32_t v) { put16(p, v); put16(p + 2, v >> 16); }
inline void header(uint8_t* p, uint32_t samples) {
  std::memset(p, 0, headerBytes);
  std::memcpy(p, "RIFF", 4); put32(p + 4, 50 + samples + (samples & 1));
  std::memcpy(p + 8, "WAVEfmt ", 8); put32(p + 16, 18);
  put16(p + 20, 7); put16(p + 22, 1); put32(p + 24, sampleRate);
  put32(p + 28, sampleRate); put16(p + 32, 1); put16(p + 34, 8);
  std::memcpy(p + 38, "fact", 4); put32(p + 42, 4); put32(p + 46, samples);
  std::memcpy(p + 50, "data", 4); put32(p + 54, samples);
}
inline int32_t sample(const uint8_t* p) { return static_cast<int16_t>(uint16_t(p[0]) | uint16_t(p[1]) << 8); }
// All non-final chunks must contain a multiple of three PCM samples.
inline size_t encode(const uint8_t* in, size_t bytes, uint8_t* out) {
  size_t pos = 0, n = 0;
  for (; pos + 6 <= bytes; pos += 6) {
    const int32_t a = sample(in + pos), b = sample(in + pos + 2), c = sample(in + pos + 4);
    out[n++] = mulaw((2 * a + b) / 3);
    out[n++] = mulaw((b + 2 * c) / 3);
  }
  if (pos + 2 <= bytes) out[n++] = mulaw(sample(in + pos));
  if (pos + 4 <= bytes) out[n++] = mulaw(sample(in + pos + 2));
  return n;
}
}
