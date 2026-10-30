#pragma once
#include <cstdint>
#include "pocket_synth.h"

// One bounded producer for the ADV's existing M5 speaker task. The UI publishes
// immutable controls; it never renders or rewrites PCM the speaker is reading.
namespace synth_audio {
constexpr uint8_t kChannel=6;
constexpr uint32_t kBlockSamples=512;
constexpr uint32_t kStackBytes=4096;
constexpr uint32_t kPriority=3;
struct Control {
  uint32_t mask=0;
  uint8_t octave=3,gain=65;
  pocket_synth::Patch patch=pocket_synth::Patch::Piano;
  bool sustain=false;
};
struct Status {
  bool running=false,draining=false,fault=false;
  uint8_t voices=0;
  uint32_t blocks=0,starvations=0;
};
bool start(const Control& control);
void update(const Control& control);
// Fail closed: false means the producer or its channel has not released yet.
// Callers must not reconfigure the shared speaker/microphone on false.
bool stop(uint32_t timeoutMs=100);
Status status();
bool busy();
} // namespace synth_audio
