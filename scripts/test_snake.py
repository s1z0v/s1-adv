#!/usr/bin/env python3
"""Execute real Snake rules, app lifecycle, renderer and scrolling launcher."""
from pathlib import Path
import os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src';PARTS=SRC/'main_parts'
def function(file,signature):
 s=(PARTS/file).read_text();a=s.index(signature);i=s.index('{',a)+1;depth=1
 while depth:depth+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
def block(file,marker):
 s=(PARTS/file).read_text();a=s.index(marker);return s[a:s.index('\n};',a)+3]
STUB=r'''
#include "snake_game.h"
#include <cassert>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <set>
#include <vector>
#include <string>
#include <type_traits>
using std::min;using std::max;
struct String:std::string{using std::string::string;String(const std::string&s):std::string(s){}template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>String(T n):std::string(std::to_string(n)){}bool isEmpty()const{return empty();}};
namespace fonts{int Font0=0,Font2=2;}
constexpr uint16_t TFT_WHITE=65535,TFT_LIGHTGREY=50000;
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&248)<<8)|((g&252)<<3)|(b>>3);}
struct Canvas{const int*font=&fonts::Font0;int x=0,y=0;std::vector<String>texts;
 void bounds(int a,int b,int w,int h){assert(a>=0&&b>=0&&w>0&&h>0&&a+w<=240&&b+h<=135);}
 void fillScreen(int){texts.clear();}void fillRect(int a,int b,int w,int h,int){bounds(a,b,w,h);}
 void drawRect(int a,int b,int w,int h,int c){fillRect(a,b,w,h,c);}
 void fillRoundRect(int a,int b,int w,int h,int,int c){fillRect(a,b,w,h,c);}
 void drawRoundRect(int a,int b,int w,int h,int,int c){fillRect(a,b,w,h,c);}
 void fillCircle(int a,int b,int r,int c){fillRect(a-r,b-r,2*r+1,2*r+1,c);}
 void setFont(const int*f){font=f;}void setTextColor(int,int){}void setCursor(int a,int b){x=a;y=b;}
 int textWidth(const String&s){return int(s.size())*(font==&fonts::Font0?6:9);}
 void print(const String&s){if(s.empty())return;bounds(x,y,textWidth(s),font==&fonts::Font0?8:16);texts.push_back(s);}
}gCanvas;
String fitCurrentFontToWidth(String s,int w){while(!s.empty()&&gCanvas.textWidth(s)>w)s.pop_back();return s;}
void drawTinyFooter(int bg,int fg,const char*s,int x,int y,int w){gCanvas.setFont(&fonts::Font0);gCanvas.setTextColor(fg,bg);gCanvas.setCursor(x,y);gCanvas.print(fitCurrentFontToWidth(s,w));}
template<class T>T clampValue(T n,T lo,T hi){return min(hi,max(lo,n));}
struct Keyboard_Class{struct KeysState{bool ctrl=false,alt=false,opt=false,fn=false,enter=false;};};
uint32_t now=1000,gLastRenderMs=0,gLastUserActivityMs=0,gLastUserInputMs=77;
uint32_t millis(){return now;}uint32_t esp_random(){return 42;}
struct{int changes=0;void invalidate(){++changes;}}gUiFramePolicy;
bool gLauncherVisible=false,gChatCommandsVisible=false,gScreensaverActive=false,gScreenOffActive=false,gRecording=false,gSubmitting=false,gThinking=false,gPlaybackActive=false;
bool gVoiceNoticeVisible=false,gVoiceReplySpeechBusy=false,gVoiceCapturePreparing=false,gG0VoicePending=false,gTransferUiActive=false,gOtaApplyInProgress=false,gPendingRestart=false;
bool gInboxHttpBusy=false,gVoiceDialBusy=false,gRealtimeActive=false,gRealtimeExclusiveMode=false,gRealtimeDialBusy=false,gPendingRealtimeStart=false,gBootBackgroundActive=false,gMeshBusOwned=false;
void*gTextTurnTaskHandle=nullptr,*gCompletedTextTurn=nullptr;
std::vector<int>gPendingTextTurns;String gQueuedVoiceReplySpeech;
bool radio=false,vlc=false;bool radioBusy(){return radio;}bool vlcBusy(){return vlc;}
void renderDebugOverlay(){}void renderLauncherOverlay();
'''
TYPES=block('002_main.cpp.inc','enum class UiMode : uint8_t')
CONSTANTS='constexpr uint8_t kLauncherGroupCount=7,kLauncherMaxSubItems=9;\n'
REGISTRY='\n'.join(block('004_main.cpp.inc',m) for m in ('struct LauncherSubItem {','struct LauncherGroup {','constexpr LauncherGroup kLauncherGroups'))
TEST=r'''
using namespace snake_game;
void valid(const Game&g){assert(g.length>=4&&g.length<=kCells);std::set<int>cells;
 for(int i=0;i<g.length;++i){assert(g.body[i]<kCells&&cells.insert(g.body[i]).second);if(i)assert(abs(int(g.body[i]%kWidth)-int(g.body[i-1]%kWidth))+abs(int(g.body[i]/kWidth)-int(g.body[i-1]/kWidth))==1);}
 assert(g.best>=g.score());if(g.phase!=Phase::Won)assert(g.food<kCells&&!cells.count(g.food));else assert(g.food==kNoFood&&g.length==kCells);}
void checkRules(){
 for(uint32_t seed=0;seed<1000;++seed){Game g;g.reset(seed,0);valid(g);assert(g.phase==Phase::Ready&&g.score()==0&&g.interval()==220);assert(!g.step()&&!g.tick(100));
  g.toggle(100);assert(!g.turn(Direction::Left));assert(g.turn(Direction::Up));assert(!g.turn(Direction::Left));assert(!g.tick(319));assert(g.tick(320)&&g.direction==Direction::Up);valid(g);
 }
 // All walls, without unsigned coordinate underflow or wrapping.
 for(auto dir:{Direction::Right,Direction::Down,Direction::Left,Direction::Up}){Game g;g.reset(1,0);g.direction=g.pending=dir;g.phase=Phase::Playing;
  if(dir==Direction::Right)for(int i=0;i<4;++i)g.body[i]=27-i;
  if(dir==Direction::Left)for(int i=0;i<4;++i)g.body[i]=i;
  if(dir==Direction::Up)for(int i=0;i<4;++i)g.body[i]=i*28;
  if(dir==Direction::Down)for(int i=0;i<4;++i)g.body[i]=(11-i)*28;
  assert(g.step()&&g.phase==Phase::Lost);}
 // Tail vacates a cell on a non-eating move; non-tail collision is fatal.
 Game tail;tail.reset(1,0);tail.phase=Phase::Playing;tail.length=4;tail.body[0]=29;tail.body[1]=30;tail.body[2]=58;tail.body[3]=57;tail.food=200;tail.direction=tail.pending=Direction::Down;
 assert(tail.step()&&tail.phase==Phase::Playing&&tail.body[0]==57);valid(tail);
 tail.pending=Direction::Right;assert(tail.step()&&tail.phase==Phase::Playing);valid(tail);
 Game hit;hit.reset(1,0);hit.phase=Phase::Playing;hit.direction=hit.pending=Direction::Left;auto body=hit.body[0];assert(hit.step()&&hit.phase==Phase::Lost&&hit.body[0]==body);
 for(uint32_t start:{0u,UINT32_MAX-200u}){Game g;g.reset(1,start);g.toggle(start);assert(!g.tick(start+219));assert(g.tick(start+220));assert(g.tick(start+1000)&&g.phase==Phase::Paused);auto head=g.body[0];assert(!g.tick(start+2000));g.toggle(start+3000);assert(!g.tick(start+3219)&&g.body[0]==head);}
 // Fill every cell along an independently constructed Hamiltonian cycle.
 std::vector<int>path;for(int x=0;x<28;++x)path.push_back(x);
 for(int y=1;y<12;++y){if(y%2)for(int x=27;x>=1;--x)path.push_back(y*28+x);else for(int x=1;x<28;++x)path.push_back(y*28+x);}
 for(int y=11;y>=1;--y)path.push_back(y*28);assert(path.size()==kCells);
 Game win;win.reset(2,0);win.phase=Phase::Playing;for(int i=0;i<4;++i)win.body[i]=path[3-i];
 for(int n=4;n<kCells;++n){int from=win.body[0],to=path[n];win.food=to;win.pending=to==from+1?Direction::Right:to==from-1?Direction::Left:to>from?Direction::Down:Direction::Up;
  assert(win.step());valid(win);}
 assert(win.phase==Phase::Won&&win.best==kCells-4&&win.score()==332&&win.interval()==85);win.reset(3,1);assert(win.best==332&&win.score()==0);
 // Random games compared step-by-step with an independent list/coordinate oracle.
 uint32_t random=123;int steps=0;
 for(int round=0;round<3000;++round){Game g;g.reset(round+1,0);g.phase=Phase::Playing;
  for(int t=0;t<200&&g.phase==Phase::Playing;++t){random=random*1664525u+1013904223u;g.turn(Direction((random>>24)%4));
   if(t%5==0){int h=g.body[0],x=h%28,y=h/28;auto d=g.pending;int x2=x+(d==Direction::Right)-(d==Direction::Left),y2=y+(d==Direction::Down)-(d==Direction::Up);
    if(x2>=0&&y2>=0&&x2<28&&y2<12){int dest=y2*28+x2;if(!g.occupied(dest,g.length))g.food=dest;}}
   std::vector<int>expected(g.body,g.body+g.length);int x=expected[0]%28,y=expected[0]/28;auto d=g.pending;
   x+=(d==Direction::Right)-(d==Direction::Left);y+=(d==Direction::Down)-(d==Direction::Up);int dest=y*28+x;bool grow=dest==g.food;
   bool collision=x<0||y<0||x>=28||y>=12;for(size_t i=0;i<expected.size()-(grow?0:1);++i)collision|=expected[i]==dest;
   auto oldFood=g.food;assert(g.step());++steps;
   if(collision)assert(g.phase==Phase::Lost);else{if(!grow)expected.pop_back();expected.insert(expected.begin(),dest);assert(expected.size()==g.length);for(size_t i=0;i<expected.size();++i)assert(expected[i]==g.body[i]);if(!grow)assert(g.food==oldFood);valid(g);}
  }
 }
 assert(steps>30000);printf("PASS real Snake rules: %d independent-oracle moves, 1000 seeds, walls/self/tail, food/growth, full 336-cell win, scores/speed/pause/wrap\n",steps);
}
void checkApp(){Keyboard_Class::KeysState keys;gUiMode=UiMode::Snake;beginSnake();assert(gSnake.initialized&&gSnake.phase==Phase::Ready);
 handleSnakeKey(' ',keys);assert(gSnake.phase==Phase::Playing);auto h=gSnake.body[0];now+=220;serviceSnake();assert(gSnake.body[0]!=h&&gLastUserActivityMs==now&&gLastUserInputMs==77);
 handleSnakeKey('p',keys);assert(gSnake.phase==Phase::Paused);handleSnakeKey('p',keys);assert(gSnake.phase==Phase::Playing);
 for(bool*p:{&gLauncherVisible,&gChatCommandsVisible,&gScreensaverActive,&gScreenOffActive,&gRecording,&gSubmitting,&gThinking,&gPlaybackActive,&gVoiceNoticeVisible,&gVoiceReplySpeechBusy,&gVoiceCapturePreparing,&gG0VoicePending,&gTransferUiActive,&gOtaApplyInProgress,&gPendingRestart,&gInboxHttpBusy,&gVoiceDialBusy,&gRealtimeActive,&gRealtimeExclusiveMode,&gRealtimeDialBusy,&gPendingRealtimeStart,&gBootBackgroundActive,&gMeshBusOwned,&radio,&vlc}){
  gSnake.reset(3,now);gSnake.toggle(now);*p=true;auto head=gSnake.body[0];now+=250;serviceSnake();assert(gSnake.phase==Phase::Paused&&gSnake.body[0]==head);handleSnakeKey('p',keys);assert(gSnake.phase==Phase::Paused);*p=false;now+=250;serviceSnake();assert(gSnake.phase==Phase::Paused);handleSnakeKey('\n',keys);assert(gSnake.phase==Phase::Playing);
 }
 for(auto p:{&gTextTurnTaskHandle,&gCompletedTextTurn}){*p=reinterpret_cast<void*>(1);serviceSnake();assert(gSnake.phase==Phase::Paused);*p=nullptr;handleSnakeKey('p',keys);}
 gPendingTextTurns.push_back(1);serviceSnake();assert(gSnake.phase==Phase::Paused);gPendingTextTurns.clear();handleSnakeKey('p',keys);
 gQueuedVoiceReplySpeech="voice";serviceSnake();assert(gSnake.phase==Phase::Paused);gQueuedVoiceReplySpeech="";handleSnakeKey('p',keys);
 gUiMode=UiMode::Home;serviceSnake();assert(gSnake.phase==Phase::Paused);gUiMode=UiMode::Snake;handleSnakeKey('n',keys);assert(gSnake.phase==Phase::Ready);
 for(bool*p:{&keys.ctrl,&keys.alt,&keys.opt}){*p=true;handleSnakeKey('\n',keys);assert(gSnake.phase==Phase::Ready);*p=false;}
 keys.fn=true;handleSnakeKey('w',keys);assert(gSnake.pending==Direction::Up);keys.fn=false;
 handleSnakeKey('W',keys);assert(gSnake.pending==Direction::Up);handleSnakeKey('\n',keys);assert(gSnake.phase==Phase::Playing);
 handleSnakeKey(' ',keys);assert(gSnake.phase==Phase::Paused);handleSnakeKey(' ',keys);assert(gSnake.phase==Phase::Playing);
 gSnake.phase=Phase::Lost;keys.enter=true;handleSnakeKey('\n',keys);assert(gSnake.phase==Phase::Playing&&gSnake.score()==0);keys.enter=false;
 for(auto phase:{Phase::Ready,Phase::Playing,Phase::Paused,Phase::Lost,Phase::Won})for(auto direction:{Direction::Up,Direction::Down,Direction::Left,Direction::Right}){
  gSnake.phase=phase;gSnake.direction=direction;gSnake.best=332;renderSnakeUi();assert(std::find(gCanvas.texts.begin(),gCanvas.texts.end(),"SNAKE")!=gCanvas.texts.end());}
 // Every cell is rendered in bounds even with the board completely full.
 gSnake.length=kCells;gSnake.food=kNoFood;gSnake.phase=Phase::Won;for(int i=0;i<kCells;++i)gSnake.body[i]=i;renderSnakeUi();
 // Nine-entry games group must scroll; no prior app is removed or relocated.
 const auto&group=kLauncherGroups[4];assert(group.count==9&&group.items[7].mode==UiMode::PocketSynth&&group.items[8].mode==UiMode::Snake);
 for(int selected=0;selected<9;++selected){gLauncherVisible=true;gLauncherSelection=4;gLauncherSubSelection=selected;gCanvas.fillScreen(0);renderLauncherOverlay();assert(std::find(gCanvas.texts.begin(),gCanvas.texts.end(),group.items[selected].label)!=gCanvas.texts.end());}
 puts("PASS actual Snake app/renderer: controls, pause-on-voice/menu/OTA/exit, no auto-resume, full 240x135 board and all 9 scrolling launcher selections");
}
int main(){checkRules();checkApp();}
'''
with tempfile.TemporaryDirectory(prefix='snake-') as tmp:
 p=Path(tmp);code=STUB+TYPES+'\n'+CONSTANTS+REGISTRY+'\nUiMode gUiMode=UiMode::Home;int gLauncherSelection=4,gLauncherSubSelection=0;\n'+function('052_main.cpp.inc','void renderLauncherOverlay()')+'\n'+(PARTS/'074_main.cpp.inc').read_text()+TEST
 (p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=50)
for file,text in [('022_main.cpp.inc','mode == "snake"'),('024_main.cpp.inc','mode == UiMode::Snake) beginSnake();'),('024_main.cpp.inc','gUiMode == UiMode::Snake) pauseSnake();'),('048_main.cpp.inc','handleSnakeKey(key, keys)'),('049_main.cpp.inc','gUiMode == UiMode::Snake && (upDown'),('049_main.cpp.inc','gUiMode == UiMode::Snake && !gLauncherVisible && spaceDown'),('061_main.cpp.inc','renderSnakeUi();'),('061_main.cpp.inc','serviceSnake();'),('061_main.cpp.inc','if (gRealtimeExclusiveMode) pauseSnake();'),('063_main.cpp.inc','case UiMode::Snake:')]:assert text in (PARTS/file).read_text(),(file,text)
assert 'main_parts/074_main.cpp.inc' in (SRC/'main.cpp').read_text()
