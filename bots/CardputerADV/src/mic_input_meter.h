#pragma once
#include <stdint.h>

namespace mic_input_meter {
struct State {
  uint32_t updatedMs = 0;
  uint8_t level = 0;
  bool seen = false;
  void reset() { updatedMs = 0; level = 0; seen = false; }
  void update(uint8_t measured, uint32_t now) {
    // UI-only fast attack/soft release. Never alter PCM or microphone gain.
    level = measured >= level ? static_cast<uint8_t>((level + measured * 3U + 3U) / 4U)
                              : static_cast<uint8_t>((level * 3U + measured) / 4U);
    updatedMs = now;
    seen = true;
  }
  uint8_t visibleLevel(bool recording, uint32_t now) const {
    return recording && seen && now - updatedMs <= 250U ? level : 0;
  }
};
inline uint16_t widthForLevel(uint8_t level, uint16_t width) {
  return static_cast<uint16_t>((static_cast<uint32_t>(level) * width) / 255U);
}
template <typename Canvas>
void draw(Canvas& canvas, int16_t x, int16_t y, uint16_t width, uint8_t level,
          uint16_t track, uint16_t top, uint16_t bottom) {
  const uint16_t filled = widthForLevel(level, width);
  for (uint8_t row = 0; row < 2; ++row) {
    canvas.fillRoundRect(x, y + row * 12, width, 6, 2, track);
    if (filled) canvas.fillRoundRect(x, y + row * 12, filled, 6, 2, row ? bottom : top);
  }
}
}  // namespace mic_input_meter
