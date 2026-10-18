#pragma once
#include <cstdint>

namespace firmware_job_display {
enum class State { Idle, Building, Ready, Attention, Failed, Stalled };
inline const char* label(State state, bool updateReady, uint32_t sinceSyncMs) {
  if (state == State::Building && sinceSyncMs <= 90000U) return "BUILDING";
  if (updateReady) return "NEW UPDATE";
  if (state == State::Building) return "CHECK LINK";
  if (state == State::Failed) return "BUILD ERROR";
  if (state == State::Stalled) return "CHECK LINK";
  if (state == State::Attention) return "CHECK CHAT";
  return "READY";
}
}
