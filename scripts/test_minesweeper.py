#!/usr/bin/env python3
"""Exercise production Minesweeper rules, controls, timer and renderer on host."""
from pathlib import Path
import os
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
src=root/'bots/CardputerADV/src'
parts=src/'main_parts'
app=(parts/'069_main.cpp.inc').read_text()
for file,text in [
    ('004_main.cpp.inc','{"Minesweeper", UiMode::Minesweeper}'),
    ('022_main.cpp.inc','mode == "minesweeper" || mode == "mines"'),
    ('024_main.cpp.inc','mode == UiMode::Minesweeper) beginMinesweeper();'),
    ('048_main.cpp.inc','handleMinesweeperKey(key, keys)'),
    ('049_main.cpp.inc','gUiMode == UiMode::Minesweeper && (upDown || downDown || leftDown || rightDown)'),
    ('061_main.cpp.inc','renderMinesweeperUi();'),
    ('061_main.cpp.inc','serviceMinesweeper();'),
    ('063_main.cpp.inc','case UiMode::Minesweeper:')]:
    assert text in (parts/file).read_text(),(file,text)
assert 'main_parts/069_main.cpp.inc' in (src/'main.cpp').read_text()
code=r'''
#include "minesweeper.h"
#include <cassert>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <type_traits>
#include <vector>
#include <set>
#include <iostream>
struct String:std::string {
 using std::string::string;String(std::string s):std::string(s){}String(char c):std::string(1,c){}
 template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>String(T n):std::string(std::to_string(n)){}
};
namespace fonts{const int Font0=0,Font2=2;}
constexpr uint16_t TFT_WHITE=0xffff;
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);}
struct Rect{int x,y,w,h;};
struct Canvas{
 const int*font=&fonts::Font0;int x=0,y=0;std::vector<Rect>text;
 void bounds(int xx,int yy,int w,int h){assert(xx>=0&&yy>=0&&w>0&&h>0&&xx+w<=240&&yy+h<=135);}
 void fillScreen(uint16_t){text.clear();}
 void fillRect(int xx,int yy,int w,int h,uint16_t){bounds(xx,yy,w,h);}
 void drawRect(int xx,int yy,int w,int h,uint16_t c){fillRect(xx,yy,w,h,c);}
 void drawLine(int x1,int y1,int x2,int y2,uint16_t){bounds(std::min(x1,x2),std::min(y1,y2),abs(x1-x2)+1,abs(y1-y2)+1);}
 void drawPixel(int xx,int yy,uint16_t){bounds(xx,yy,1,1);}
 void fillCircle(int xx,int yy,int r,uint16_t){bounds(xx-r,yy-r,2*r+1,2*r+1);}
 void fillTriangle(int x1,int y1,int x2,int y2,int x3,int y3,uint16_t){for(auto p:{std::pair<int,int>{x1,y1},{x2,y2},{x3,y3}})bounds(p.first,p.second,1,1);}
 void setFont(const int*f){font=f;}void setTextColor(uint16_t,uint16_t){}
 void setCursor(int xx,int yy){x=xx;y=yy;}
 int textWidth(const String&s){return int(s.size())*(font==&fonts::Font0?6:10);}
 void print(const String&s){Rect r{x,y,textWidth(s),font==&fonts::Font0?8:16};bounds(x,y,r.w,r.h);assert(y+r.h<=129&&x+r.w<=234);
  for(auto p:text)assert(x+r.w<=p.x||p.x+p.w<=x||y+r.h<=p.y||p.y+p.h<=y);text.push_back(r);}
}gCanvas;
struct Keyboard_Class{struct KeysState{bool ctrl=false,alt=false,opt=false,del=false,enter=false;};};
enum class UiMode{Home,Minesweeper};UiMode gUiMode=UiMode::Minesweeper;
uint32_t nowMs=1000,gLastRenderMs=999,seed=12345;
uint32_t millis(){return nowMs;}uint32_t esp_random(){return ++seed;}
struct{int changes=0;void invalidate(){++changes;}}gUiFramePolicy;
void renderLauncherOverlay(){}void renderDebugOverlay(){}
''' + app + r'''
using namespace minesweeper;
int adjacent(const Game&g,int s){int n=0;for(int j=0;j<81;++j)if(j!=s&&abs(j%9-s%9)<=1&&abs(j/9-s/9)<=1&&g.cells[j].mine)++n;return n;}
void verify(const Game&g){
 int mines=0,flags=0,opened=0;
 for(int s=0;s<81;++s){mines+=g.cells[s].mine;flags+=g.cells[s].flagged;opened+=g.cells[s].opened&&!g.cells[s].mine;
  if(g.phase!=Phase::Ready)assert(g.cells[s].adjacent==adjacent(g,s));
  assert(!(g.cells[s].flagged&&g.cells[s].opened));
 }
 assert(flags==g.flags&&opened==g.opened);assert(mines==(g.phase==Phase::Ready?0:10));
 if(g.phase==Phase::Won)assert(g.opened==71&&g.flags==10);
 if(g.phase==Phase::Lost)assert(valid(g.detonated)&&g.cells[g.detonated].mine);
}
std::set<int> floodOracle(const Game&g,int first){
 std::set<int> result;std::vector<int>queue{first};result.insert(first);
 for(size_t i=0;i<queue.size();++i){int s=queue[i];if(adjacent(g,s))continue;
  for(int j=0;j<81;++j)if(abs(j%9-s%9)<=1&&abs(j/9-s/9)<=1&&!g.cells[j].mine&&!g.cells[j].flagged&&result.insert(j).second)queue.push_back(j);
 }return result;
}
void fixture(Game&g){g.reset(5);g.cells[0].mine=true;for(int s=72;s<81;++s)g.cells[s].mine=true;g.countNeighbors();g.phase=Phase::Playing;g.startedMs=1000;}
void key(char k){Keyboard_Class::KeysState keys;assert(handleMinesweeperKey(k,keys));}
int main(){
 static_assert(sizeof(Game)<512,"small fixed state");Game g;
 // All 81 first picks across 100 deterministic seeds: exact unique mines,
 // safe 3x3, independently counted neighbors and independently expanded region.
 std::set<std::string> layouts;
 for(uint32_t seed=0;seed<100;++seed)for(int first=0;first<81;++first){
  g.reset(seed);assert(g.reveal(first,1000));assert(g.cells[first].adjacent==0&&g.phase!=Phase::Lost);verify(g);
  for(int s=0;s<81;++s)if(abs(s%9-first%9)<=1&&abs(s/9-first/9)<=1)assert(!g.cells[s].mine);
  auto expected=floodOracle(g,first);for(int s=0;s<81;++s)assert(g.cells[s].opened==(expected.count(s)>0));
  if(first==40){std::string layout;for(auto c:g.cells)layout+=c.mine?'1':'0';layouts.insert(layout);}
 }
 assert(layouts.size()>90);
 Game same;g.reset(42);same.reset(42);g.reveal(40,1);same.reveal(40,1);
 for(int s=0;s<81;++s)assert(g.cells[s].mine==same.cells[s].mine);
 // No first click is consumed by a flag, invalid index or reopened tile.
 g.reset(2);assert(g.toggleFlag(40)&&!g.reveal(40,5000)&&g.phase==Phase::Ready&&g.seconds(90000)==0);verify(g);
 assert(g.toggleFlag(40));assert(!g.reveal(-1,1)&&!g.reveal(81,1)&&!g.toggleFlag(-1)&&!g.toggleFlag(300));
 for(int s=0;s<81;++s)assert(g.toggleFlag(s));assert(g.flags==81);verify(g);
 for(int s=0;s<81;++s)assert(g.toggleFlag(s));assert(g.flags==0);
 g.toggleFlag(0);g.reveal(40,1000);assert(g.cells[0].flagged&&!g.cells[0].opened);verify(g);
 assert(!g.toggleFlag(40));assert(!g.reveal(40,2000));
 // Winning clears exactly all safe cells and freezes time/flags; loss stops
 // immediately and never admits new flags/reveals or turns a mine into safety.
 for(int s=0;s<81&&g.phase==Phase::Playing;++s)if(!g.cells[s].mine){if(g.cells[s].flagged)g.toggleFlag(s);g.reveal(s,5000);}
 assert(g.phase==Phase::Won&&g.seconds(90000)==4);verify(g);
 assert(!g.reveal(0,100000)&&!g.toggleFlag(0));
 g.reset(3);g.reveal(40,1000);int mine=-1;for(int s=0;s<81;++s)if(g.cells[s].mine){mine=s;break;}
 assert(g.reveal(mine,8000)&&g.phase==Phase::Lost&&g.seconds(100000)==7);verify(g);
 assert(!g.toggleFlag(10)&&!g.reveal(20,100001));
 // Chording uses the number of adjacent flags, not whether those flags are
 // right. A wrong flag can therefore lose, as in classic Minesweeper.
 fixture(g);g.reveal(10,1000);assert(g.cells[10].adjacent==1&&!g.reveal(10,2000));
 g.toggleFlag(0);const int before=g.opened;assert(g.reveal(10,3000)&&g.opened>before&&g.phase!=Phase::Lost);verify(g);
 fixture(g);g.reveal(10,1000);g.toggleFlag(9);assert(g.reveal(10,3000)&&g.phase==Phase::Lost&&g.detonated==0);verify(g);
 // Clock starts at first reveal, wraps uint32 safely, and caps at 999 seconds.
 g.reset(4);g.reveal(40,0xffffff00U);assert(g.seconds(uint32_t(0xffffff00U+4321U))==4);
 assert(g.seconds(uint32_t(0xffffff00U+1000000U))==999);
 // Actual app input/mode/timer invalidation and fresh randomized new game.
 beginMinesweeper();assert(gMinesweeper.phase==Phase::Ready);key('f');assert(gMinesweeper.flags==1);key('\n');assert(gMinesweeper.phase==Phase::Ready);
 key('\b');key('\n');assert(gMinesweeper.phase==Phase::Playing&&gMinesweeper.cells[40].opened);
 for(int i=0;i<20;++i)key('w');assert(gMinesweeper.cursor/9==0);
 for(int i=0;i<20;++i)key('a');assert(gMinesweeper.cursor%9==0);
 for(int i=0;i<20;++i)key('d');assert(gMinesweeper.cursor%9==8);
 key('n');assert(gMinesweeper.phase==Phase::Ready&&gMinesweeper.flags==0&&gMinesweeper.cursor==40);
 key('\n');gMinesweeperLastSecond=0;int changes=gUiFramePolicy.changes;nowMs+=1500;serviceMinesweeper();assert(gUiFramePolicy.changes==changes+1);
 changes=gUiFramePolicy.changes;serviceMinesweeper();assert(gUiFramePolicy.changes==changes);
 gUiMode=UiMode::Home;nowMs+=3000;serviceMinesweeper();assert(gUiFramePolicy.changes==changes);gUiMode=UiMode::Minesweeper;
 // Every cursor, number 1..8, flag, wrong flag, detonated/revealed mine,
 // terminal state, and extreme counter/time text stays bounded/non-overlapping.
 for(int state=0;state<5;++state){
  gMinesweeper.reset(44);
  if(state==0)for(int s=0;s<81;++s)gMinesweeper.toggleFlag(s);
  if(state==1){gMinesweeper.reveal(40,1000);for(int s=0;s<81;++s)if(gMinesweeper.cells[s].mine){gMinesweeper.reveal(s,2000);break;}}
  if(state>=2){gMinesweeper.reveal(40,1000);for(int s=0;s<81;++s)if(!gMinesweeper.cells[s].mine)gMinesweeper.reveal(s,2000);}
  if(state==3){for(auto&c:gMinesweeper.cells){c.mine=false;c.flagged=false;c.opened=true;c.adjacent=8;}gMinesweeper.phase=Phase::Playing;}
  if(state==4){gMinesweeper.phase=Phase::Lost;gMinesweeper.cells[0].mine=false;gMinesweeper.cells[0].opened=false;gMinesweeper.cells[0].flagged=true;}
  nowMs=1000000;
  for(int cursor=0;cursor<81;++cursor){gMinesweeper.cursor=cursor;renderMinesweeperUi();}
 }
 gMinesweeper.phase=Phase::Playing;
 for(int number=1;number<=8;++number){for(auto&c:gMinesweeper.cells){c.mine=false;c.flagged=false;c.opened=true;c.adjacent=number;}
  for(int cursor=0;cursor<81;++cursor){gMinesweeper.cursor=cursor;renderMinesweeperUi();}}
 // 300 random action traces include flags, reveal/chord, boundaries and terminal
 // no-ops; all representation invariants are checked after every operation.
 uint32_t rng=123;
 for(int game=0;game<300;++game){g.reset(game);for(int action=0;action<200;++action){rng=1664525U*rng+1013904223U;int s=rng%81;
  if(rng&0x100)g.toggleFlag(s);else g.reveal(s,action*1000U);verify(g);
 }}
 std::cout<<"PASS Minesweeper: 8100 safe openings, independent counts/flood oracle, flags/chording/win/loss/wrap, production controls/timer/UI and 300 random games\n";
}
'''
with tempfile.TemporaryDirectory(prefix='s1-mines-') as directory:
    p=Path(directory);(p/'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I',str(src),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
    subprocess.run([str(p/'test')],check=True,timeout=90)
