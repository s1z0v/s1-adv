#!/usr/bin/env python3
"""Exhaustive Chess Mind logic and independently checked composed mates."""
from pathlib import Path
import os,subprocess,tempfile,json
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src'
CODE=r'''
#include "chess_mind.h"
#include <cassert>
#include <cstring>
#include <cstdio>
#include <cstdint>
#include <string>
using namespace chess_mind;
int main(int argc,char** argv){
 if(argc==2&&std::string(argv[1])=="--puzzles"){
  for(const auto&m:kMates){char a[3],b[3];name(m.from,a);name(m.to,b);printf("%s|%s%s|%s\n",m.fen,a,b,m.san);}return 0;
 }
 if(argc==2&&std::string(argv[1])=="--geometry"){
  for(int p:{chess_demo::Knight,chess_demo::Bishop,chess_demo::Rook,chess_demo::Queen,chess_demo::King})for(int f=0;f<64;++f){
   uint64_t mask=0;for(int t=0;t<64;++t)if(reaches(p,f,t))mask|=uint64_t(1)<<t;
   printf("%d %d %llu\n",p,f,static_cast<unsigned long long>(mask));
  }return 0;
 }
 assert(!light(0)&&light(1)&&!light(63));
 for(int s=0;s<64;++s){char text[3];name(s,text);assert(text[0]=='a'+s%8&&text[1]=='1'+s/8&&!text[2]);}
 for(int p=0;p<8;++p)for(int f:{-100,-1,64,100})for(int t=0;t<64;++t)assert(!reaches(p,f,t)&&!reaches(p,t,f));
 for(const auto& m:kMates){
  chess_demo::Position p;p.castle=0;p.ep=-1;p.turn=1;assert(placement(m.fen,p.board));
  assert(!p.inCheck(1)&&!p.inCheck(-1));assert(p.legalMoves().contains(m.from,m.to));p.apply({m.from,m.to});
  assert(p.turn==-1&&p.inCheck(-1)&&p.legalMoves().count==0);
 }
 int8_t board[64];for(auto bad:{"","8","8/8/8/8/8/8/8/9","8/8/8/8/8/8/8/7X","8/8/8/8/8/8/8/8/8"})assert(!placement(bad,board));
 uint64_t squares=0;Session coverage;coverage.begin(0,1);coverage.nextKind=0;coverage.nextSquare=0;
 for(int i=0;i<64;++i){coverage.next(i*100);assert(coverage.question.kind==Kind::Square);assert(!(squares&(uint64_t(1)<<coverage.question.to)));squares|=uint64_t(1)<<coverage.question.to;coverage.nextKind=0;}
 assert(squares==UINT64_MAX);
 int types[5]={},pieces[7]={},yes=0,no=0,puzzles[4]={};
 for(uint32_t seed=0;seed<500;++seed){Session s;s.begin(UINT32_MAX-12000,seed);
  for(int i=0;i<200;++i){
   const auto&q=s.question;++types[int(q.kind)];assert(q.from<64&&q.to<64);
   assert(strlen(q.tag)<=19&&strlen(q.line1)<=19&&strlen(q.line2)<=19&&strlen(q.answer)<=19&&strlen(q.hint)<=19);
   for(auto p:q.board)assert(p>=-6&&p<=6);
   switch(q.kind){
    case Kind::Square:{char a[3];name(q.to,a);assert(!strcmp(q.answer,a));break;}
    case Kind::Color:assert(!strcmp(q.answer,light(q.to)?"LIGHT":"DARK"));break;
    case Kind::Reach:assert(q.yes==reaches(q.piece,q.from,q.to)&&q.board[q.from]==q.piece);++pieces[q.piece];q.yes?++yes:++no;break;
    case Kind::Reverse:{
     int correct=0;for(int j=0;j<3;++j){assert(q.options[j]<64&&q.options[j]!=q.to);correct+=reaches(chess_demo::Knight,q.options[j],q.to);for(int k=0;k<j;++k)assert(q.options[j]!=q.options[k]);}
     assert(correct==1&&q.correct<3&&q.options[q.correct]==q.from&&q.board[q.to]==chess_demo::Knight);break;
    }
    case Kind::Mate:assert(q.mate<kMateCount&&q.from==kMates[q.mate].from&&q.to==kMates[q.mate].to);++puzzles[q.mate];break;
   }
   s.next(uint32_t(i*200));
  }
 }
 for(int n:types)assert(n>1000);for(int p=2;p<=6;++p)assert(pieces[p]>1000);for(int n:puzzles)assert(n>1000);assert(yes>4000&&no>4000);
 for(uint32_t start:{0u,UINT32_MAX-10000u,UINT32_MAX-25000u}){
  Session s;s.begin(start,42);assert(!s.revealed&&s.remaining(start)==24);auto serial=s.serial;
  s.tick(start+23999);assert(!s.revealed&&s.remaining(start+23999)==1);
  s.tick(start+24000);assert(s.revealed&&s.serial==serial&&s.remaining(start+24000)==8);
  s.tick(start+31999);assert(s.revealed);s.tick(start+32000);assert(!s.revealed&&s.serial==serial+1);
  s.advance(start+33000);assert(s.revealed);s.advance(start+34000);assert(!s.revealed&&s.serial==serial+2);
  s.tick(start+300000);assert(s.revealed&&s.remaining(start+300000)==8); // no flickering catch-up loop
 }
 puts("PASS Chess Mind: 100000 generated prompts, full square coverage, exact reach/reverse answers, composed legal mates, safe buffers and wrap-safe 24s/8s timing (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='chess-mind-') as tmp:
 p=Path(tmp);(p/'test.cpp').write_text(CODE)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=40)
 try:import chess
 except ImportError:raise SystemExit('Install the pinned test-only oracle: chess==1.11.2') from None
 for row in subprocess.check_output([str(p/'test'),'--puzzles'],text=True).splitlines():
  fen,uci,san=row.split('|');board=chess.Board(fen);move=chess.Move.from_uci(uci)
  assert board.is_valid() and not board.is_check() and move in board.legal_moves
  assert board.san(move)==san
  board.push(move);assert board.is_checkmate()
 for row in subprocess.check_output([str(p/'test'),'--geometry'],text=True).splitlines():
  piece,square,mask=map(int,row.split());board=chess.Board(None);board.set_piece_at(square,chess.Piece(piece,chess.WHITE))
  assert int(board.attacks(square))==mask
 print('PASS independent python-chess oracle: all 4 composed mating moves and every empty-board attack square for knight/bishop/rook/queen/king')
