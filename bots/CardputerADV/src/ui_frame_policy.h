#pragma once
#include <cstdint>
namespace ui_frame {
struct Policy {
  bool valid=false;
  uint32_t lastScene=0;
  bool needsFullFrame(bool sprite,uint32_t scene,bool input) const {
    return sprite || !valid || scene!=lastScene || input;
  }
  void invalidate(){valid=false;}
  void presented(uint32_t scene){valid=true;lastScene=scene;}
};
} // namespace ui_frame
