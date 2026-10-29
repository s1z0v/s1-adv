#pragma once
// Offline, bounded mental chess prompts. No engine/network work in the UI.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "chess_demo.h"

namespace chess_mind {
enum class Kind : uint8_t { Square, Color, Reach, Reverse, Mate };
constexpr uint32_t kQuestionMs=24000, kAnswerMs=8000;
constexpr uint8_t kKinds=5;
struct Mate {
  const char* fen;
  uint8_t from,to;
  const char* san;
};
// Hand-composed positions, White to move; each displayed move is legal mate.
// Multiple mates may exist: show ONE solution, never claim unique best play.
constexpr Mate kMates[] = {
  {"6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1",0,56,"Ra8#"},
  {"7k/5K2/6Q1/8/8/8/8/8 w - - 0 1",46,54,"Qg7#"},
  {"k7/pp6/8/8/8/8/8/6KR w - - 0 1",7,63,"Rh8#"},
  {"6rk/4N1pr/8/8/8/8/8/6K1 w - - 0 1",52,46,"Ng6#"},
};
constexpr uint8_t kMateCount=sizeof(kMates)/sizeof(kMates[0]);
inline int magnitude(int n){return n<0?-n:n;}
inline bool light(uint8_t square){return ((square%8+square/8)&1)!=0;}
inline void name(uint8_t square,char* out){out[0]=char('a'+square%8);out[1]=char('1'+square/8);out[2]=0;}
inline const char* pieceName(int p) {
  switch(p){case chess_demo::Knight:return "Knight";case chess_demo::Bishop:return "Bishop";
    case chess_demo::Rook:return "Rook";case chess_demo::Queen:return "Queen";default:return "King";}
}
inline bool reaches(int piece,int from,int to) {
  if(from<0||from>=64||to<0||to>=64||from==to)return false;
  int df=magnitude(from%8-to%8),dr=magnitude(from/8-to/8);
  switch(piece) {
    case chess_demo::Knight:return (df==1&&dr==2)||(df==2&&dr==1);
    case chess_demo::Bishop:return df==dr;
    case chess_demo::Rook:return df==0||dr==0;
    case chess_demo::Queen:return df==dr||df==0||dr==0;
    case chess_demo::King:return df<=1&&dr<=1;
    default:return false; // Pawns/castling/blockers intentionally not modelled.
  }
}
inline bool placement(const char* fen,int8_t* board) {
  memset(board,0,64);int rank=7,file=0;
  for(const char* p=fen;*p&&*p!=' ';++p) {
    char c=*p;
    if(c=='/'){if(file!=8||rank==0)return false;--rank;file=0;continue;}
    if(c>='1'&&c<='8'){file+=c-'0';if(file>8)return false;continue;}
    const char* codes="PNBRQKpnbrqk";const char* found=strchr(codes,c);
    if(!found||file>=8)return false;
    int n=int(found-codes);board[rank*8+file++]=int8_t(n<6?n+1:-(n-5));
  }
  return rank==0&&file==8;
}
struct Question {
  Kind kind=Kind::Square;
  uint8_t from=0,to=0,options[3]={},correct=0,mate=0;
  int8_t piece=chess_demo::Knight,board[64]={};
  bool yes=false;
  char tag[24]={},line1[32]={},line2[32]={},answer[32]={},hint[32]={};
};
struct Session {
  Question question;
  uint32_t rng=1,phaseStarted=0,serial=0;
  uint8_t nextKind=0,nextSquare=0,nextMate=0;
  bool started=false,revealed=false;
  uint32_t random(){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return rng;}
  void begin(uint32_t now,uint32_t seed) {
    rng=seed?seed:0x416dc531;nextKind=random()%kKinds;nextSquare=random()%64;
    nextMate=random()%kMateCount;serial=0;started=true;next(now);
  }
  void next(uint32_t now) {
    question=Question{};auto& q=question;
    q.kind=Kind(nextKind);nextKind=(nextKind+1)%kKinds;
    q.to=random()%64;char a[3],b[3];
    switch(q.kind) {
      case Kind::Square:
        q.to=nextSquare;nextSquare=(nextSquare+37)%64;
        strcpy(q.tag,"COORDINATES");strcpy(q.line1,"Name this square");strcpy(q.line2,"White at bottom");
        name(q.to,q.answer);snprintf(q.hint,sizeof(q.hint),"file %c / rank %c",q.answer[0],q.answer[1]);break;
      case Kind::Color:
        strcpy(q.tag,"SQUARE COLOR");name(q.to,a);snprintf(q.line1,sizeof(q.line1),"%s: light or dark?",a);
        strcpy(q.line2,"Picture it first");strcpy(q.answer,light(q.to)?"LIGHT":"DARK");strcpy(q.hint,"a1 is always dark");break;
      case Kind::Reach: {
        const int8_t pieces[]={chess_demo::Knight,chess_demo::Bishop,chess_demo::Rook,chess_demo::Queen,chess_demo::King};
        q.piece=pieces[random()%5];q.from=random()%64;bool wanted=(random()&1)!=0;
        uint8_t targets[64];uint8_t count=0;
        for(uint8_t s=0;s<64;++s)if(s!=q.from && reaches(q.piece,q.from,s)==wanted)targets[count++]=s;
        q.to=targets[random()%count];q.yes=reaches(q.piece,q.from,q.to);q.board[q.from]=q.piece;
        strcpy(q.tag,"ONE-MOVE TEST");name(q.from,a);name(q.to,b);
        snprintf(q.line1,sizeof(q.line1),"%s %s -> %s",pieceName(q.piece),a,b);
        strcpy(q.line2,"On an empty board");strcpy(q.answer,q.yes?"YES - legal":"NO - not legal");
        strcpy(q.hint,q.piece==chess_demo::Knight?"Knight: 2 + 1":q.piece==chess_demo::Bishop?"Bishop: diagonal":q.piece==chess_demo::Rook?"Rook: straight":q.piece==chess_demo::Queen?"Queen: lines/rays":"King: one square");break;
      }
      case Kind::Reverse: {
        uint8_t legal[8],wrong[64];uint8_t n=0,m=0;
        for(uint8_t s=0;s<64;++s)if(reaches(chess_demo::Knight,s,q.to))legal[n++]=s;else if(s!=q.to)wrong[m++]=s;
        q.from=legal[random()%n];q.correct=random()%3;q.options[q.correct]=q.from;
        uint8_t first=random()%m,second=(first+1+random()%(m-1))%m;
        uint8_t at=0;
        for(uint8_t i=0;i<3;++i)if(i!=q.correct)q.options[i]=wrong[at++?second:first];
        q.board[q.to]=chess_demo::Knight;strcpy(q.tag,"REVERSE KNIGHT");name(q.to,a);
        snprintf(q.line1,sizeof(q.line1),"Arrives on %s",a);strcpy(q.line2,"Choose start A/B/C");name(q.from,b);
        snprintf(q.answer,sizeof(q.answer),"%c: %s",char('A'+q.correct),b);strcpy(q.hint,"Knight: 2 + 1");break;
      }
      case Kind::Mate: {
        q.mate=nextMate;nextMate=(nextMate+1)%kMateCount;const auto& mate=kMates[q.mate];
        placement(mate.fen,q.board);q.from=mate.from;q.to=mate.to;
        strcpy(q.tag,"MATE IN ONE");strcpy(q.line1,"White to move");strcpy(q.line2,"Find a mating move");
        snprintf(q.answer,sizeof(q.answer),"%s",mate.san);name(q.from,a);name(q.to,b);
        snprintf(q.hint,sizeof(q.hint),"One mate: %s-%s",a,b);break;
      }
    }
    phaseStarted=now;revealed=false;++serial;
  }
  void reveal(uint32_t now){if(!revealed){revealed=true;phaseStarted=now;}}
  void advance(uint32_t now){if(revealed)next(now);else reveal(now);}
  void tick(uint32_t now) {
    if(!started)return;
    if(!revealed && now-phaseStarted>=kQuestionMs)reveal(now);
    else if(revealed && now-phaseStarted>=kAnswerMs)next(now);
  }
  uint32_t remaining(uint32_t now)const {
    const uint32_t duration=revealed?kAnswerMs:kQuestionMs,elapsed=now-phaseStarted;
    return elapsed>=duration?0:(duration-elapsed+999)/1000;
  }
};
} // namespace chess_mind
