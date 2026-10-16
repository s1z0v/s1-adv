#pragma once
#include <string_view>

namespace transport_security {
struct Origin {
  std::string_view host;
  unsigned port = 443;
  bool valid = false;
};

inline Origin httpsOrigin(std::string_view url) {
  Origin result;
  if (url.substr(0, 8) != "https://") return result;
  auto end = url.find_first_of("/?#", 8);
  auto authority = url.substr(8, end == std::string_view::npos ? end : end - 8);
  if (authority.empty() || authority.find_first_of("@\\\r\n\t %") != std::string_view::npos) return result;
  auto colon = authority.rfind(':');
  if (colon != std::string_view::npos) {
    auto port = authority.substr(colon + 1);
    if (port.empty() || port.size() > 5) return result;
    result.port = 0;
    for (char ch : port) {
      if (ch < '0' || ch > '9') return result;
      result.port = result.port * 10 + static_cast<unsigned>(ch - '0');
    }
    if (result.port == 0 || result.port > 65535) return result;
    authority = authority.substr(0, colon);
  }
  if (authority.empty()) return result;
  for (char ch : authority) {
    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
          (ch >= '0' && ch <= '9') || ch == '.' || ch == '-')) return result;
  }
  result.host = authority;
  result.valid = true;
  return result;
}

inline bool sameBridgeOrigin(std::string_view url, std::string_view configuredOrigin) {
  const auto a = httpsOrigin(url), b = httpsOrigin(configuredOrigin);
  if (!a.valid || !b.valid || a.port != b.port || a.host.size() != b.host.size()) return false;
  for (size_t i = 0; i < a.host.size(); ++i) {
    auto lower = [](char ch) { return ch >= 'A' && ch <= 'Z' ? ch + ('a' - 'A') : ch; };
    if (lower(a.host[i]) != lower(b.host[i])) return false;
  }
  return true;
}

inline bool safeAssetPath(std::string_view path) {
  return path.substr(0, 16) == "/pomodoro/audio/" && path.find("..") == std::string_view::npos &&
         path.find_first_of("\\\r\n") == std::string_view::npos;
}
}  // namespace transport_security
