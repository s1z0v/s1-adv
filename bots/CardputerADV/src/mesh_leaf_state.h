#pragma once
#include <array>
#include <cstdint>
#include <cstring>

// Fixed bounds: remote packets cannot grow the node list, history or composer.
namespace s1_mesh {
constexpr size_t kNodes = 16, kMessages = 8, kTextBytes = 200;
inline size_t copyText(char* out, size_t capacity, const uint8_t* in, size_t length) {
  if (!capacity) return 0;
  size_t used = 0;
  for (size_t i = 0; i < length && used + 1 < capacity;) {
    const uint8_t c = in[i];
    if (c < 32 || c == 127) { out[used++] = ' '; ++i; continue; }
    if (c < 128) { out[used++] = char(c); ++i; continue; }
    size_t n = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    bool valid = n && i + n <= length;
    for (size_t j = 1; valid && j < n; ++j) valid = (in[i+j] & 0xc0) == 0x80;
    if (valid && n >= 3) valid = !(c == 0xe0 && in[i+1] < 0xa0) && !(c == 0xed && in[i+1] >= 0xa0);
    if (valid && n == 4) valid = !(c == 0xf0 && in[i+1] < 0x90) && !(c == 0xf4 && in[i+1] >= 0x90);
    if (!valid) { out[used++] = '?'; ++i; continue; }
    if (used + n >= capacity) break;
    memcpy(out + used, in + i, n); used += n; i += n;
  }
  out[used] = 0;
  return used;
}
struct Node {
  uint32_t id = 0, seen = 0;
  int16_t rssi = 0;
  char name[41] = {};
};
struct Message {
  uint32_t from = 0, id = 0;
  bool outgoing = false;
  char text[kTextBytes+1] = {};
};
struct State {
  std::array<Node,kNodes> nodes{};
  std::array<Message,kMessages> messages{};
  size_t nodeCount = 0, messageCount = 0;
  bool nodeView = false;
  bool detailView = false;
  size_t nodePage = 0, historyOffset = 0;
  char input[kTextBytes+1] = {};
  Node* hear(uint32_t id, uint32_t now, int16_t rssi) {
    if (!id || id == UINT32_MAX) return nullptr;
    size_t slot = nodeCount;
    for (size_t i=0;i<nodeCount;++i) if(nodes[i].id==id) { slot=i; break; }
    if (slot == nodeCount && nodeCount == kNodes) {
      slot=0;
      for(size_t i=1;i<kNodes;++i) if(uint32_t(now-nodes[i].seen)>uint32_t(now-nodes[slot].seen)) slot=i;
    }
    if (slot == nodeCount) ++nodeCount;
    if(nodes[slot].id!=id) nodes[slot]=Node{};
    nodes[slot].id=id;nodes[slot].seen=now;nodes[slot].rssi=rssi;
    return &nodes[slot];
  }
  void message(uint32_t from, uint32_t id, bool outgoing, const uint8_t* data, size_t size) {
    for(size_t i=0;i<messageCount;++i) if(messages[i].from==from && messages[i].id==id) return;
    if(messageCount==kMessages) {
      for(size_t i=1;i<kMessages;++i) messages[i-1]=messages[i];
      --messageCount;
    }
    auto& m=messages[messageCount++];m=Message{};m.from=from;m.id=id;m.outgoing=outgoing;
    copyText(m.text,sizeof(m.text),data,size);
  }
  bool append(const char* text) {
    const size_t a=strlen(input),b=strlen(text);
    if(a+b>kTextBytes)return false;
    memcpy(input+a,text,b+1);return true;
  }
  void erase() {
    size_t n=strlen(input);if(!n)return;
    --n;while(n && (uint8_t(input[n])&0xc0)==0x80)--n;input[n]=0;
  }
};
} // namespace s1_mesh
