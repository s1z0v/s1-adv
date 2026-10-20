#!/usr/bin/env python3
"""Compile/run actual offline chess rules, app handlers, CPU slices and renderer."""
from pathlib import Path
import os
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
src = root / 'bots/CardputerADV/src'
app = (src / 'main_parts/066_main.cpp.inc').read_text()
assert 'case UiMode::Chess:' in (src / 'main_parts/061_main.cpp.inc').read_text()
assert 'serviceChessDemo();' in (src / 'main_parts/061_main.cpp.inc').read_text()
assert '{"Chess", UiMode::Chess}' in (src / 'main_parts/004_main.cpp.inc').read_text()
assert 'mode == "chess"' in (src / 'main_parts/022_main.cpp.inc').read_text()
assert 'handleChessDemoKey(key, keys)' in (src / 'main_parts/048_main.cpp.inc').read_text()
assert "handleTypingKey(upDown ? 'w' : downDown ? 's' : leftDown ? 'a' : 'd', keys)" in (src / 'main_parts/049_main.cpp.inc').read_text()
assert 'case UiMode::Chess:' in (src / 'main_parts/063_main.cpp.inc').read_text()
code = r'''
#include "chess_demo.h"
#include <cassert>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <type_traits>
#include <vector>
#include <iostream>
struct String : std::string {
 using std::string::string; String(std::string s):std::string(s){}
 String(char c):std::string(1,c){}
 template<class T, typename=std::enable_if_t<std::is_integral_v<T>>>
 String(T n):std::string(std::to_string(n)){}
};
namespace fonts {const int Font0=0,Font2=2;}
constexpr uint16_t TFT_WHITE=0xffff;
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);}
struct Rect{int x,y,w,h;};
struct Canvas {
 const int*font=&fonts::Font0; int x=0,y=0;std::vector<Rect>text;
 void bounds(int xx,int yy,int w,int h){assert(xx>=0&&yy>=0&&w>0&&h>0&&xx+w<=240&&yy+h<=135);}
 void fillScreen(uint16_t){text.clear();}
 void fillRect(int xx,int yy,int w,int h,uint16_t){bounds(xx,yy,w,h);}
 void drawRect(int xx,int yy,int w,int h,uint16_t c){fillRect(xx,yy,w,h,c);}
 void fillRoundRect(int xx,int yy,int w,int h,int,uint16_t c){fillRect(xx,yy,w,h,c);}
 void fillCircle(int xx,int yy,int r,uint16_t){bounds(xx-r,yy-r,2*r+1,2*r+1);}
 void setFont(const int*f){font=f;}
 void setTextColor(uint16_t,uint16_t){}
 void setCursor(int xx,int yy){x=xx;y=yy;}
 int textWidth(const String&s){return int(s.size())*(font==&fonts::Font0?6:10);}
 void print(const String&s){
  Rect r{x,y,textWidth(s),font==&fonts::Font0?8:16};bounds(x,y,r.w,r.h);assert(y+r.h<=129);
  for(auto t:text)assert(x+r.w<=t.x||t.x+t.w<=x||y+r.h<=t.y||t.y+t.h<=y);
  text.push_back(r);
 }
}gCanvas;
String fitCurrentFontToWidth(const String&s,int width){return s.substr(0,width/(gCanvas.font==&fonts::Font0?6:10));}
struct Keyboard_Class {struct KeysState {bool ctrl=false,alt=false,opt=false,del=false,enter=false;};};
enum class UiMode {Home,Chess};UiMode gUiMode=UiMode::Chess;
bool gLauncherVisible=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false,gRealtimeActive=false,gBlockingInputPumpActive=false;
uint32_t nowMs=1000,gLastRenderMs=999;
uint32_t millis(){return nowMs;}
struct {int changes=0;void invalidate(){++changes;}}gUiFramePolicy;
void renderLauncherOverlay(){}void renderDebugOverlay(){}
''' + app + r'''
using namespace chess_demo;
int sq(const char*s){return (s[1]-'1')*8+s[0]-'a';}
Move move(const char*s){return {uint8_t(sq(s)),uint8_t(sq(s+2))};}
void play(Position&p,const char*s){const auto m=move(s);assert(p.legalMoves().contains(m.from,m.to));p.apply(m);}
void fen(Position&p,const char*s){
 p=Position{};p.castle=0;int f=0,r=7;
 while(*s!=' '){char c=*s++;if(c=='/'){--r;f=0;continue;}if(c>='1'&&c<='8'){f+=c-'0';continue;}
  int type=0;switch(tolower(c)){case 'p':type=Pawn;break;case 'n':type=Knight;break;case 'b':type=Bishop;break;case 'r':type=Rook;break;case 'q':type=Queen;break;case 'k':type=King;break;default:assert(false);}
  p.board[r*8+f++]=islower(c)?-type:type;
 }
 ++s;p.turn=*s=='w'?1:-1;s+=2;
 while(*s!=' '){switch(*s++){case 'K':p.castle|=1;break;case 'Q':p.castle|=2;break;case 'k':p.castle|=4;break;case 'q':p.castle|=8;break;}}
 ++s;if(*s!='-')p.ep=sq(s);
}
uint64_t perft(const Position&p,int depth){
 if(!depth)return 1;auto list=p.legalMoves();if(depth==1)return list.count;uint64_t nodes=0;
 for(int i=0;i<list.count;++i){Position next=p;next.apply(list.moves[i]);nodes+=perft(next,depth-1);}return nodes;
}
void key(char k){Keyboard_Class::KeysState keys;assert(handleChessDemoKey(k,keys));}
int main(){
 static_assert(sizeof(Game)<1024,"demo runtime must stay small");
 Position p;p.reset();assert(perft(p,1)==20);assert(perft(p,2)==400);assert(perft(p,3)==8902);assert(perft(p,4)==197281);
 fen(p,"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -");
 assert(perft(p,1)==48);assert(perft(p,2)==2039);assert(perft(p,3)==97862);
 // En passant is legal after the double step, expires, and cannot expose a king.
 p.reset();play(p,"e2e4");play(p,"a7a6");play(p,"e4e5");play(p,"d7d5");
 assert(p.ep==sq("d6"));play(p,"e5d6");assert(p.board[sq("d5")]==0&&p.board[sq("d6")]==Pawn);
 fen(p,"4k3/8/8/r4pPK/8/8/8/8 w - f6");assert(!p.legalMoves().contains(sq("g5"),sq("f6")));
 // King-side and queen-side castling, transit checks and irreversible rights.
 fen(p,"r3k2r/8/8/8/8/8/8/R3K2R w KQkq -");
 assert(p.legalMoves().contains(4,6)&&p.legalMoves().contains(4,2));play(p,"e1g1");assert(p.board[5]==Rook&&p.board[7]==0&&(p.castle&3)==0);
 play(p,"e8c8");assert(p.board[59]==-Rook&&p.board[56]==0&&(p.castle&12)==0);
 fen(p,"4kr2/8/8/8/8/8/8/4K2R w K -");assert(!p.legalMoves().contains(4,6));
 fen(p,"4k3/8/8/8/8/8/8/4K2R w K -");play(p,"h1h2");play(p,"e8e7");play(p,"h2h1");assert((p.castle&1)==0);
 fen(p,"4k3/8/8/8/8/8/1b6/R3K3 b Q -");play(p,"b2a1");assert((p.castle&2)==0);
 // Queen-only promotion, pinned pieces, king adjacency and forbidden king capture.
 fen(p,"4k3/P7/8/8/8/8/8/4K3 w - -");play(p,"a7a8");assert(p.board[56]==Queen);
 fen(p,"k3r3/8/8/8/8/8/4R3/4K3 w - -");assert(!p.legalMoves().contains(sq("e2"),sq("d2")));
 fen(p,"8/8/8/8/8/4k3/8/4K3 w - -");assert(!p.legalMoves().contains(4,12));
 fen(p,"4k3/4Q3/8/8/8/8/8/4K3 w - -");assert(!p.legalMoves().contains(52,60));
 p.reset();play(p,"f2f3");play(p,"e7e5");play(p,"g2g4");play(p,"d8h4");assert(result(p,p.legalMoves())==Result::BlackWins);
 fen(p,"k7/8/1QK5/8/8/8/8/8 b - -");assert(result(p,p.legalMoves())==Result::Stalemate);
 // Actual app: cursor, select/reselect, illegal moves, cancellation, new game.
 beginChessDemo();assert(gChess.position.turn==1&&gChess.cursor==12);key('\n');assert(gChess.selected==12);
 key('a');key('\n');assert(gChess.selected==11);key('\b');assert(gChess.selected==-1);
 key('d');key('\n');key('w');key('w');key('\n');assert(gChess.position.board[28]==Pawn&&gChess.position.turn==-1);
 const Position before=gChess.position;
 nowMs+=1000;gLauncherVisible=true;serviceChessDemo();assert(gChessAiIndex==0);gLauncherVisible=false;
 gRecording=true;serviceChessDemo();assert(gChessAiIndex==0);gRecording=false;
 gUiMode=UiMode::Home;serviceChessDemo();assert(gChessAiIndex==0);gUiMode=UiMode::Chess;
 serviceChessDemo();assert(gChessAiIndex<=4&&gChessAiIndex>0);
 for(int i=0;i<100&&gChess.position.turn==-1;++i)serviceChessDemo();
 assert(gChess.position.turn==1&&gChess.plies==2&&before.legalMoves().contains(gChess.last.from,gChess.last.to));
 key('n');assert(gChess.plies==0&&gChess.position.turn==1&&gChess.selected==-1);
 key('\n');key('w');key('a');key('\n');assert(gChess.selected==12&&gChess.plies==0);key('\b');
 for(int i=0;i<20;++i)key('a');assert(gChess.cursor%8==0);
 for(int i=0;i<20;++i)key('w');assert(gChess.cursor/8==7);
 // Every cursor/selection, playing/CPU/mate/stalemate render stays in bounds.
 for(int state=0;state<4;++state){
  gChess.reset();
  if(state==1){gChess.play(12,28);gChess.selected=-1;}
  if(state==2)gChess.outcome=Result::BlackWins;
  if(state==3)gChess.outcome=Result::Stalemate;
  for(int cursor=0;cursor<64;++cursor){gChess.cursor=cursor;gChess.selected=state==0?12:-1;renderChessDemoUi();}
 }
 // Bounded deterministic CPU self-play always stays legal and retains both kings.
 p.reset();
 for(int ply=0;ply<160;++ply){auto legal=p.legalMoves();if(!legal.count)break;int best=-32767,index=0;
  for(int i=0;i<legal.count;++i){int score=moveScore(p,legal.moves[i]);if(score>best){best=score;index=i;}}
  int side=p.turn;p.apply(legal.moves[index]);assert(!p.inCheck(side));
  int kings=0;for(int piece:p.board)if(absPiece(piece)==King)++kings;assert(kings==2);
 }
 std::cout<<"PASS chess: perft 197281/97862, castling/EP/promotion/check/mate/stalemate, app controls, sliced CPU and all board UI states\n";
}
'''
with tempfile.TemporaryDirectory(prefix='s1-chess-') as directory:
    p=Path(directory)
    (p/'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX','c++'), '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-misleading-indentation', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(src), str(p/'test.cpp'), '-o', str(p/'test')], check=True)
    subprocess.run([str(p/'test')], check=True, timeout=60)
