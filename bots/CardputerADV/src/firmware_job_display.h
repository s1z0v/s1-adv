#pragma once
#include <cstdint>

namespace firmware_job_display {
enum class State { Idle, Building, Ready, Attention, Failed, Stalled, Unconfirmed };
inline const char* label(State state, bool updateReady, uint32_t sinceSuccessMs, bool linkFailed = false) {
  if (state == State::Building && (!linkFailed || sinceSuccessMs <= 90000U)) return "BUILDING";
  if (updateReady) return "NEW UPDATE";
  // A job receipt/progress problem is distinct from a missed status poll.
  if (linkFailed && sinceSuccessMs > 90000U && (state == State::Building ||
      state == State::Stalled || state == State::Unconfirmed)) return "CHECK LINK";
  if (state == State::Failed) return "BUILD ERROR";
  if (state == State::Unconfirmed) return "UNCONFIRMED";
  if (state == State::Stalled) return "NO PROGRESS";
  if (state == State::Attention) return "CHECK CHAT";
  return "READY";
}
}
