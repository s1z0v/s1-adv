#pragma once
#include <cstdint>

namespace firmware_job_display {
enum class State { Idle, Building, Ready, Attention, Failed, Stalled };
inline const char* label(State state, bool updateReady, uint32_t sinceSyncMs) {
  if (state == State::Building) return sinceSyncMs > 90000U ? "CHECK LINK" : "BUILDING";
  if (state == State::Failed) return "BUILD ERROR";
  if (state == State::Attention || state == State::Stalled) return "CHECK CHAT";
  return updateReady ? "NEW UPDATE" : "READY";
}
}
