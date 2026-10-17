#pragma once
#include <cstdio>
#include <cstddef>

namespace clock_display {
inline const char* period(unsigned hour) { return hour % 24 < 12 ? "AM" : "PM"; }
inline void format(char* out, size_t capacity, unsigned hour, unsigned minute,
                   bool twelveHour, bool suffix = false) {
  hour %= 24; minute %= 60;
  if (twelveHour) {
    const unsigned displayHour = hour % 12 ? hour % 12 : 12;
    if (suffix) std::snprintf(out, capacity, "%u:%02u %s", displayHour, minute, period(hour));
    else std::snprintf(out, capacity, "%u:%02u", displayHour, minute);
  } else {
    std::snprintf(out, capacity, "%02u:%02u", hour, minute);
  }
}
}
