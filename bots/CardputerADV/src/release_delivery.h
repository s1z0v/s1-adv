#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>

namespace release_delivery {
inline bool otaPowerAllowed(int level, bool external, unsigned minimum) {
  return external || (level >= 0 && static_cast<unsigned>(level) >= minimum);
}
constexpr size_t kChimeSamples = 1920;
constexpr uint32_t kChimeRate = 8000;
inline void makeUpdateChime(int16_t* samples) {
  // Quiet A-major chord, soft attack/release; not a square-wave alert.
  for (size_t i = 0; i < kChimeSamples; ++i) {
    const float t = static_cast<float>(i) / kChimeRate;
    const float envelope = sinf(3.14159265f * i / (kChimeSamples - 1));
    const float chord = sinf(6.2831853f * 220.0f * t) +
                        0.7f * sinf(6.2831853f * 277.1826f * t) +
                        0.5f * sinf(6.2831853f * 329.6276f * t);
    samples[i] = static_cast<int16_t>(2400.0f * envelope * envelope * chord);
  }
}
}
