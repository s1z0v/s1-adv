#pragma once
// Fixed-size classic Snake. No allocation, assets, audio, SD or device calls.
#include <cstdint>
namespace snake_game {
constexpr uint16_t kWidth=28,kHeight=12,kCells=kWidth*kHeight,kStartLength=4;
constexpr uint16_t kNoFood=kCells;
enum class Phase:uint8_t{Ready,Playing,Paused,Lost,Won};
enum class Direction:uint8_t{Right,Down,Left,Up};
struct Game {
  uint16_t body[kCells]={},length=0,food=kNoFood,best=0;
  Direction direction=Direction::Right,pending=Direction::Right;
  Phase phase=Phase::Ready;bool initialized=false,turnQueued=false;
  uint32_t rng=1,lastStep=0;
  uint16_t score()const{return length>=kStartLength?length-kStartLength:0;}
  uint16_t interval()const{const int speed=220-int(score()/3)*10;return uint16_t(speed<85?85:speed);}
  uint32_t random(){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return rng;}
  bool occupied(uint16_t cell,uint16_t count)const{for(uint16_t i=0;i<count;++i)if(body[i]==cell)return true;return false;}
  void placeFood(){
    if(length==kCells){food=kNoFood;phase=Phase::Won;return;}
    uint16_t skip=uint16_t(random()%(kCells-length));
    for(uint16_t cell=0;cell<kCells;++cell)if(!occupied(cell,length)){
      if(skip==0){food=cell;return;}--skip;
    }
  }
  void reset(uint32_t seed,uint32_t now){
    initialized=true;rng=seed?seed:1;length=kStartLength;direction=pending=Direction::Right;
    phase=Phase::Ready;turnQueued=false;lastStep=now;
    const uint16_t head=(kHeight/2)*kWidth+kWidth/2;
    for(uint16_t i=0;i<length;++i)body[i]=head-i;
    placeFood();
  }
  void pause(){if(phase==Phase::Playing)phase=Phase::Paused;}
  void toggle(uint32_t now){
    if(phase==Phase::Ready||phase==Phase::Paused){phase=Phase::Playing;lastStep=now;}
    else pause();
  }
  bool turn(Direction next){
    if(phase==Phase::Lost||phase==Phase::Won||turnQueued||unsigned(next)>3)return false;
    if(next==direction||((unsigned(next)+2)%4)==unsigned(direction))return false;
    pending=next;turnQueued=true;return true;
  }
  bool step(){
    if(phase!=Phase::Playing)return false;
    direction=pending;turnQueued=false;
    const int x=body[0]%kWidth,y=body[0]/kWidth;
    const int nx=x+(direction==Direction::Right)-(direction==Direction::Left);
    const int ny=y+(direction==Direction::Down)-(direction==Direction::Up);
    if(nx<0||ny<0||nx>=kWidth||ny>=kHeight){phase=Phase::Lost;return true;}
    const uint16_t next=uint16_t(ny*kWidth+nx);const bool grow=next==food;
    // A non-growing move may enter the cell that the tail vacates this tick.
    if(occupied(next,uint16_t(length-(grow?0:1)))){phase=Phase::Lost;return true;}
    if(grow)++length;
    for(uint16_t i=length-1;i>0;--i)body[i]=body[i-1];body[0]=next;
    if(score()>best)best=score();
    if(grow)placeFood();
    return true;
  }
  bool tick(uint32_t now){
    if(phase!=Phase::Playing)return false;
    const uint32_t elapsed=now-lastStep;
    // Do not fast-forward into death after a long network/UI suspension.
    if(elapsed>700){pause();lastStep=now;return true;}
    if(elapsed<interval())return false;
    lastStep=now;return step();
  }
};
static_assert(sizeof(Game)<720,"Snake runtime must remain bounded");
} // namespace snake_game
