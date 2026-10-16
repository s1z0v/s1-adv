#include "../src/mic_input_meter.h"
#include <cassert>
#include <cstdio>
#include <vector>

struct Rect { int x,y,w,h,color; };
struct Canvas {
  std::vector<Rect> rects;
  void fillRoundRect(int x,int y,int w,int h,int,int color) {
    assert(x>=0 && y>=0 && x+w<=240 && y+h<=135);
    rects.push_back({x,y,w,h,color});
  }
};
int main() {
  mic_input_meter::State state;
  assert(state.visibleLevel(true,0)==0);
  state.update(255,1000);
  assert(state.visibleLevel(true,1000)>=191);
  assert(state.visibleLevel(false,1001)==0);
  assert(state.visibleLevel(true,1250)>0);
  assert(state.visibleLevel(true,1251)==0);
  state.reset();
  assert(state.visibleLevel(true,1300)==0);
  state.update(255,0xfffffff0U);
  assert(state.visibleLevel(true,0x10U)>0); // millis wrap
  assert(state.visibleLevel(true,0x100U)==0);
  for(unsigned i=0;i<40;++i)state.update(0,2000+i*30);
  assert(state.level==0);
  unsigned checks=0;
  for(unsigned level=0;level<256;++level) {
    Canvas c;
    mic_input_meter::draw(c,121,77,96,level,1,2,3);
    const int filled=level*96/255;
    assert(c.rects.size()==(filled?4:2));
    if(filled) {
      assert(c.rects[1].w==filled && c.rects[3].w==filled);
      assert(c.rects[1].y==77 && c.rects[3].y==89);
    }
    for(unsigned age: {0U,30U,250U,251U,10000U}) {
      state.reset();state.update(level,1000);
      assert(state.visibleLevel(false,1000+age)==0);
      if(age>250) assert(state.visibleLevel(true,1000+age)==0);
      ++checks;
    }
  }
  std::printf("PASS mic meter: 256 paired-width/bounds cases, %u age/mode cases, state=%zu bytes\n",checks,sizeof(state));
}
