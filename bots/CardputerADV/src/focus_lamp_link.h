#pragma once
#include <cstdint>
namespace focus_lamp {
enum class Phase : uint8_t { Idle, Focus, Break };
// Existing lamp presets remain intact. Navigate with bounded, acknowledged
// next/previous controls; opcode 6 in stock GL2 aliases preset and weekday.
struct Link {
  bool active=false, suspended=false, waiting=false, restoring=false;
  int current=-1, original=-1, target=-1, expected=-1;
  uint32_t sentAt=0, lastCommand=0;
  Phase phase=Phase::Idle;
  void allow() { suspended=false; }
  void cancel() { active=false; waiting=false; restoring=false; suspended=true; }
  void observe(int preset,uint32_t now) {
    if(!active) {current=preset;return;}
    if(waiting) {
      if(preset==expected){current=preset;waiting=false;}
      else if(preset!=current || now-sentAt>2500U) cancel();
    } else if(preset!=current) cancel(); // An owner adjustment wins.
    if(active && restoring && !waiting && current==target){active=false;restoring=false;}
  }
  void setPhase(Phase next,bool enabled,int focus,int rest,bool online,uint32_t now) {
    (void)now;
    if(!enabled) next=Phase::Idle;
    if(next==phase && !(next==Phase::Focus && !active && !suspended))return;
    phase=next;
    if(next==Phase::Focus && enabled && !active && !online){suspended=true;return;}
    if(active && next==Phase::Idle){target=original;restoring=true;return;}
    if(!active && next==Phase::Focus && enabled && !suspended && online && current>=0 && focus>=0 && rest>=0){
      original=current;active=true;restoring=false;
    }
    if(active && next!=Phase::Idle){target=next==Phase::Focus?focus:rest;restoring=false;}
  }
  int command(uint32_t now,bool online,bool busy) {
    if(!active)return -1;
    if(!online || (waiting && now-sentAt>2500U)){cancel();return -1;}
    if(waiting || busy || now-lastCommand<520U || current==target)return -1;
    expected=current+(target>current?1:-1);waiting=true;sentAt=now;lastCommand=now;
    return target>current?5:4;
  }
};
} // namespace focus_lamp
