#pragma once
#include <cstdint>
namespace focus_lamp {
enum class Phase : uint8_t { Idle, Focus, Break };
// Internal action, NOT a GL2 control opcode. The adapter sends an unchanged
// preset bank with only its selected index changed. Stock control opcode 6
// aliases preset and weekday and must never be used for this action.
constexpr int kSelectPresetBank = 256;
struct Link {
  bool active=false, suspended=false, waiting=false, restoring=false;
  int current=-1, original=-1, target=-1, expected=-1;
  uint8_t powerOnRemaining=0;
  uint32_t sentAt=0, lastCommand=0;
  Phase phase=Phase::Idle;
  void allow() { suspended=false; }
  void cancel() { active=false; waiting=false; restoring=false; powerOnRemaining=0; suspended=true; }
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
    if(next==phase && !(next!=Phase::Idle && !active && !suspended))return;
    phase=next;
    if(next!=Phase::Idle && enabled && !active && !online){suspended=true;return;}
    if(active && next==Phase::Idle){powerOnRemaining=0;target=original;restoring=true;return;}
    if(!active && next!=Phase::Idle && enabled && !suspended && online && current>=0 && focus>=0 && rest>=0){
      original=current;active=true;restoring=false;
    }
    if(active && next!=Phase::Idle){
      target=next==Phase::Focus?focus:rest;restoring=false;
      // Stock GL2 ignores preset controls while off. ON is idempotent;
      // repeat it once to tolerate a dropped UDP packet, before selection.
      powerOnRemaining=2;
    }
  }
  int command(uint32_t now,bool online,bool busy) {
    if(!active)return -1;
    if(!online || (waiting && now-sentAt>2500U)){cancel();return -1;}
    if(waiting || busy || now-lastCommand<520U)return -1;
    if(powerOnRemaining){--powerOnRemaining;lastCommand=now;return 1;}
    if(current==target)return -1;
    expected=target;waiting=true;sentAt=now;lastCommand=now;
    return kSelectPresetBank;
  }
};
} // namespace focus_lamp
