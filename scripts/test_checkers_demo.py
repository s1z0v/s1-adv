#!/usr/bin/env python3
"""Run the actual checkers rules, CPU/input handlers and renderer with sanitizers."""
from pathlib import Path
import os
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
src=root/'bots/CardputerADV/src'
parts=src/'main_parts'
app=(parts/'067_main.cpp.inc').read_text()
for file, text in [
    ('004_main.cpp.inc','{"Checkers", UiMode::Checkers}'),
    ('022_main.cpp.inc','mode == "checkers" || mode == "draughts"'),
    ('024_main.cpp.inc','mode == UiMode::Checkers) beginCheckersDemo();'),
    ('048_main.cpp.inc','handleCheckersDemoKey(key, keys)'),
    ('049_main.cpp.inc','gUiMode == UiMode::Chess || gUiMode == UiMode::Checkers'),
    ('061_main.cpp.inc','renderCheckersDemoUi();'),
    ('061_main.cpp.inc','serviceCheckersDemo();'),
    ('063_main.cpp.inc','case UiMode::Checkers:')]:
    assert text in (parts/file).read_text(), (file,text)
assert 'main_parts/067_main.cpp.inc' in (src/'main.cpp').read_text()
code=r'''
#include "checkers_demo.h"
#include <cassert>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <type_traits>
#include <vector>
#include <iostream>
struct String:std::string {
 using std::string::string;String(std::string s):std::string(s){}String(char c):std::string(1,c){}
 template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>String(T n):std::string(std::to_string(n)){}
};
namespace fonts {const int Font0=0,Font2=2;}
constexpr uint16_t TFT_WHITE=0xffff;
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);}
struct Rect{int x,y,w,h;};
struct Canvas {
 const int*font=&fonts::Font0;int x=0,y=0;std::vector<Rect>text;
 void bounds(int xx,int yy,int w,int h){assert(xx>=0&&yy>=0&&w>0&&h>0&&xx+w<=240&&yy+h<=135);}
 void fillScreen(uint16_t){text.clear();}
 void fillRect(int xx,int yy,int w,int h,uint16_t){bounds(xx,yy,w,h);}
 void drawRect(int xx,int yy,int w,int h,uint16_t c){fillRect(xx,yy,w,h,c);}
 void fillCircle(int xx,int yy,int r,uint16_t){bounds(xx-r,yy-r,2*r+1,2*r+1);}
 void drawCircle(int xx,int yy,int r,uint16_t c){fillCircle(xx,yy,r,c);}
 void setFont(const int*f){font=f;}void setTextColor(uint16_t,uint16_t){}
 void setCursor(int xx,int yy){x=xx;y=yy;}
 int textWidth(const String&s){return int(s.size())*(font==&fonts::Font0?6:10);}
 void print(const String&s){
  Rect r{x,y,textWidth(s),font==&fonts::Font0?8:16};bounds(x,y,r.w,r.h);assert(y+r.h<=129);
  for(auto t:text)assert(x+r.w<=t.x||t.x+t.w<=x||y+r.h<=t.y||t.y+t.h<=y);text.push_back(r);
 }
}gCanvas;
String fitCurrentFontToWidth(const String&s,int w){return s.substr(0,w/(gCanvas.font==&fonts::Font0?6:10));}
struct Keyboard_Class{struct KeysState{bool ctrl=false,alt=false,opt=false,del=false,enter=false;};};
enum class UiMode{Home,Checkers};UiMode gUiMode=UiMode::Checkers;
bool gLauncherVisible=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false,gRealtimeActive=false,gBlockingInputPumpActive=false;
uint32_t nowMs=1000,gLastRenderMs=999;uint32_t millis(){return nowMs;}
struct{int changes=0;void invalidate(){++changes;}}gUiFramePolicy;
void renderLauncherOverlay(){}void renderDebugOverlay(){}
''' + app + r'''
using namespace checkers_demo;
int sq(const char*s){return (s[1]-'1')*8+s[0]-'a';}
void empty(Game&g,int turn=1){g=Game{};g.turn=turn;g.started=true;}
void play(Game&g,const char*from,const char*to){assert(g.play(sq(from),sq(to)));}
int count(const Game&g){int n=0;for(int p:g.board)if(p)++n;return n;}
// Independent exhaustive from/to oracle, rather than reusing addMoves().
MoveList reference(const Game&g){
 MoveList steps,jumps;
 for(int from=0;from<64;++from)for(int to=0;to<64;++to){
  const int p=g.board[from],r=from/8,f=from%8,nr=to/8,nf=to%8;
  if(!p||sideOf(p)!=g.turn||g.board[to]||(r+f)%2||(nr+nf)%2)continue;
  if(g.forced>=0&&from!=g.forced)continue;
  const int dr=nr-r,df=nf-f;
  if(magnitude(p)==1&&dr*g.turn<=0)continue;
  if(magnitude(dr)==1&&magnitude(df)==1&&g.forced<0)steps.add(from,to);
  if(magnitude(dr)==2&&magnitude(df)==2&&sideOf(g.board[((r+nr)/2)*8+(f+nf)/2])==-g.turn)jumps.add(from,to);
 }
 return jumps.count||g.forced>=0?jumps:steps;
}
void verify(const Game&g){
 const auto ref=reference(g);assert(g.legal.count==ref.count);
 for(int i=0;i<ref.count;++i)assert(g.legal.contains(ref.moves[i].from,ref.moves[i].to));
 for(int s=0;s<64;++s)if(g.board[s]){assert(dark(s%8,s/8));assert(magnitude(g.board[s])<=2);}
 if(g.forced>=0){assert(g.legal.count&&g.captureRequired());for(int i=0;i<g.legal.count;++i)assert(g.legal.moves[i].from==g.forced);}
}
uint64_t perft(const Game&g,int depth){if(!depth)return 1;uint64_t n=0;for(int i=0;i<g.legal.count;++i){auto m=g.legal.moves[i];Game next=g;assert(next.play(m.from,m.to));n+=perft(next,depth-1);}return n;}
void key(char k){Keyboard_Class::KeysState keys;assert(handleCheckersDemoKey(k,keys));}
int main(){
 static_assert(sizeof(Game)<1024,"small fixed checkers state");
 Game g;g.reset();assert(count(g)==24&&g.turn==1&&g.legal.count==7);verify(g);
 assert(perft(g,1)==7&&perft(g,2)==49&&perft(g,3)==302&&perft(g,4)==1469);
 assert(!g.play(-1,0)&&!g.play(64,500)&&!g.play(sq("c3"),sq("c4")));
 // Mandatory capture overrides every quiet move; same piece must finish a chain.
 empty(g);g.board[sq("c3")]=1;g.board[sq("a3")]=1;g.board[sq("d4")]=-1;g.board[sq("f6")]=-1;g.board[sq("h8")]=-1;g.refresh();
 assert(g.captureRequired()&&g.legal.count==1&&!g.play(sq("a3"),sq("b4")));verify(g);
 play(g,"c3","e5");assert(g.turn==1&&g.forced==sq("e5")&&g.selected==sq("e5")&&g.turns==0&&g.board[sq("d4")]==0);
 assert(!g.play(sq("a3"),sq("b4")));verify(g);
 play(g,"e5","g7");assert(g.turn==-1&&g.forced==-1&&g.turns==1&&g.board[sq("f6")]==0);verify(g);
 // Men cannot move/capture backwards; kings can, but cannot fly.
 empty(g);g.board[sq("e5")]=1;g.board[sq("d4")]=-1;g.refresh();assert(!g.legal.contains(sq("e5"),sq("c3")));
 g.board[sq("e5")]=2;g.refresh();assert(g.legal.contains(sq("e5"),sq("c3")));play(g,"e5","c3");assert(g.board[sq("d4")]==0);
 empty(g);g.board[sq("c3")]=2;g.board[sq("h8")]=-2;g.refresh();assert(g.legal.count==4&&!g.legal.contains(sq("c3"),sq("f6")));
 // Crowning ends the move, even if the new king would have another jump.
 empty(g);g.board[sq("b6")]=1;g.board[sq("c7")]=-1;g.board[sq("e7")]=-1;g.refresh();play(g,"b6","d8");
 assert(g.board[sq("d8")]==2&&g.turn==-1&&g.forced==-1);verify(g);
 empty(g,-1);g.board[sq("g3")]=-1;g.board[sq("f2")]=1;g.board[sq("d2")]=1;g.refresh();play(g,"g3","e1");
 assert(g.board[sq("e1")]==-2&&g.turn==1&&g.forced==-1);verify(g);
 // Either capture branch is legal; no maximum-capture rule is imposed.
 empty(g);g.board[sq("c3")]=1;g.board[sq("b4")]=-1;g.board[sq("d4")]=-1;g.refresh();assert(g.legal.count==2);verify(g);
 // Last capture and blocked/no-piece turns finish, without accepting more moves.
 empty(g);g.board[sq("c3")]=1;g.board[sq("d4")]=-1;g.refresh();play(g,"c3","e5");assert(g.outcome==Result::RedWins&&!g.play(sq("e5"),sq("f6")));
 empty(g);g.board[sq("a7")]=1;g.board[sq("b8")]=-1;g.refresh();assert(g.outcome==Result::BlackWins);
 empty(g,-1);g.board[sq("a1")]=2;g.refresh();assert(g.outcome==Result::RedWins);
 // Actual app controls, illegal light-square target, cancel/reselect and reset.
 beginCheckersDemo();assert(gCheckers.cursor==sq("c3"));key('\n');assert(gCheckers.selected==sq("c3"));key('w');key('\n');assert(gCheckers.turns==0);
 key('a');key('\n');assert(gCheckers.turn==-1&&gCheckers.turns==1);key('n');assert(gCheckers.turns==0&&gCheckers.turn==1);
 key('\n');key('\b');assert(gCheckers.selected==-1);
 // Actual CPU pause gates and bounded candidate batches.
 play(gCheckers,"c3","b4");checkersDemoResetAi();nowMs+=1000;
 for(bool*busy:{&gLauncherVisible,&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gRealtimeActive,&gBlockingInputPumpActive}){
  *busy=true;serviceCheckersDemo();assert(gCheckersAiIndex==0);*busy=false;
 }
 gUiMode=UiMode::Home;serviceCheckersDemo();assert(gCheckersAiIndex==0);gUiMode=UiMode::Checkers;
 serviceCheckersDemo();assert(gCheckersAiIndex<=4&&gCheckersAiIndex>0);
 for(int i=0;i<100&&gCheckers.turn==-1;++i){nowMs+=250;serviceCheckersDemo();}
 assert(gCheckers.turn==1&&gCheckers.turns==2);verify(gCheckers);
 // Human cannot cancel/switch a forced continuation; CPU plays both legs.
 empty(gCheckers);gCheckers.board[sq("c3")]=1;gCheckers.board[sq("a3")]=1;gCheckers.board[sq("d4")]=-1;gCheckers.board[sq("f6")]=-1;gCheckers.refresh();
 play(gCheckers,"c3","e5");key('\b');assert(gCheckers.selected==sq("e5"));gCheckers.cursor=sq("a3");key('\n');assert(gCheckers.selected==sq("e5"));
 empty(gCheckers,-1);gCheckers.board[sq("g7")]=-1;gCheckers.board[sq("f6")]=1;gCheckers.board[sq("d4")]=1;gCheckers.board[sq("h2")]=1;gCheckers.refresh();checkersDemoResetAi();
 nowMs+=250;serviceCheckersDemo();assert(gCheckers.forced==sq("e5")&&gCheckers.turn==-1);
 nowMs+=250;serviceCheckersDemo();assert(gCheckers.board[sq("c3")]==-1&&gCheckers.turn==1&&gCheckers.turns==1);verify(gCheckers);
 // Every cursor plus king/check/capture/forced/result display states fits.
 for(int state=0;state<6;++state){
  gCheckers.reset();
  if(state==1){gCheckers.board[sq("c3")]=2;gCheckers.board[sq("f6")]=-2;gCheckers.refresh();}
  if(state==2){empty(gCheckers);gCheckers.board[sq("c3")]=1;gCheckers.board[sq("d4")]=-1;gCheckers.board[sq("f6")]=-1;gCheckers.refresh();play(gCheckers,"c3","e5");}
  if(state==3)gCheckers.outcome=Result::RedWins;
  if(state==4)gCheckers.outcome=Result::BlackWins;
  if(state==5){play(gCheckers,"c3","b4");}
  for(int cursor=0;cursor<64;++cursor){gCheckers.cursor=cursor;renderCheckersDemoUi();}
 }
 // 40 deterministic legal games: oracle agreement, jump accounting, ownership,
 // dark-square invariants and termination safety over up to 16000 legs.
 uint32_t seed=1234567;
 for(int game=0;game<40;++game){g.reset();
  for(int leg=0;leg<400&&g.outcome==Result::Playing;++leg){verify(g);seed=1664525U*seed+1013904223U;
   const int index=seed%g.legal.count;const auto m=g.legal.moves[index];const int before=count(g),side=g.turn;
   const bool jump=magnitude(int(m.to)/8-int(m.from)/8)==2;const int beforeTurns=g.turns;
   assert(moveScore(g,m)>-32767);assert(g.play(m.from,m.to));assert(count(g)==before-(jump?1:0));
   assert(g.turn==side?(g.forced>=0&&g.turns==beforeTurns):(g.forced<0&&g.turns==beforeTurns+1));
  }verify(g);
 }
 std::cout<<"PASS checkers: opening perft 7/49/302/1469, independent legal-move oracle, captures/chains/kings/crowning/wins, controls/CPU slices/UI bounds and 40 games\n";
}
'''
with tempfile.TemporaryDirectory(prefix='s1-checkers-') as directory:
    p=Path(directory);(p/'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O2','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I',str(src),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
    subprocess.run([str(p/'test')],check=True,timeout=60)
