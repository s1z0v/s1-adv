#pragma once
#include <cstdint>
#include <string>

namespace sd_file_manager {
constexpr unsigned kMaxEntries = 128;
constexpr unsigned kMaxPath = 240;
inline bool validPath(const std::string& path) {
  if (path.empty() || path.size() > kMaxPath || path[0] != '/') return false;
  if (path == "/") return true;
  if (path.back() == '/') return false;
  size_t start = 1;
  while (start < path.size()) {
    size_t end = path.find('/', start);
    if (end == std::string::npos) end = path.size();
    auto name = path.substr(start, end - start);
    if (name.empty() || name == "." || name == "..") return false;
    for (unsigned char c : name) if (c < 32 || c == 127 || c == '\\' || c == ':') return false;
    start = end + 1;
  }
  return true;
}
inline bool directChild(const std::string& parent, const std::string& path) {
  if (!validPath(parent) || !validPath(path) || path == "/") return false;
  const std::string prefix = parent == "/" ? "/" : parent + "/";
  return path.compare(0, prefix.size(), prefix) == 0 &&
         path.find('/', prefix.size()) == std::string::npos;
}
struct DeletePrompt {
  std::string path;
  uint64_t size = 0;
  void cancel() { path.clear(); size = 0; }
  bool pending() const { return !path.empty(); }
  bool arm(const std::string& parent, const std::string& selected, uint64_t bytes, bool directory) {
    cancel();
    if (directory || !directChild(parent, selected)) return false;
    path = selected; size = bytes; return true;
  }
  bool confirm(char key, const std::string& parent, const std::string& current,
               uint64_t bytes, bool directory, bool busy) {
    bool allowed = key == 'y' && pending() && !busy && !directory &&
        current == path && bytes == size && directChild(parent, current);
    cancel();
    return allowed;
  }
};
}
