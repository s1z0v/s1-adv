#!/usr/bin/env python3
"""Exercise actual NES rendering, keys, SD reads and fault handling on the host."""
import os, pathlib, subprocess, tempfile

root=pathlib.Path(__file__).resolve().parents[1]
source=(root/'bots/CardputerADV/src/main_parts/064_main.cpp.inc').read_text()
def function(signature):
    start=source.index(signature);brace=source.index('{',start);depth=1;end=brace+1
    while depth:
        depth+=(source[end]=='{')-(source[end]=='}');end+=1
    return source[start:end]

code=r'''
#include <algorithm>
#include <cassert>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <vector>
#include "nes_view.h"
using std::max;using std::min;
namespace lgfx {struct rgb565_t {uint16_t raw=0;};}
struct Keys {std::vector<char> word;std::vector<uint8_t> hid_keys;bool enter=false,space=false;} gKeyboardState;
bool hasHidKey(const Keys& k,uint8_t code){return std::find(k.hid_keys.begin(),k.hid_keys.end(),code)!=k.hid_keys.end();}
constexpr uint8_t kHidKeyEscape=0x29;constexpr int TFT_BLACK=0,kNesAudioChannel=7;
bool gNesRunning=true,gNesEnterHeld=false,gNesEscapeHeld=false,gNesViewHeld=false;
bool gNesWide=false,gNesFaulted=false,gNesMenuDirty=false;
uint8_t gNesStartFrames=0,gNesInjectedPad=0,gNesAudioSlot=0;
uint16_t gNesInjectedFrames=0;int gNesSelection=0;
uint32_t gNesNextFrameUs=0,gNesFrameNumber=0,gNesNavMs=0;
int16_t gNesAudio[3][368];lgfx::rgb565_t gNesScanline[240];
std::vector<int> gNesGames(3);int stopped=0,started=0,errors=0,drawRows=0,frames=0,audioStops=0;
uint8_t lastPad=0;bool ioOk=true;
uint8_t rowData[256];uint16_t palette[]={0xf800,0x07e0,0x001f};
struct Display {
 void startWrite(){drawRows=0;}void endWrite(){assert(drawRows==135);}
 void fillScreen(int){}
 void pushImage(int x,int y,int w,int h,const lgfx::rgb565_t* pixels){
  assert(x==nes_view::left(gNesWide)&&w==nes_view::width(gNesWide)&&h==1&&y==drawRows++);
  for(int col=0;col<w;++col)assert(pixels[col].raw==palette[nes_view::sourceX(col,gNesWide)%3]);
 }
 void pushImage(int,int,int,int,const uint16_t*)=delete;
};
struct Speaker {int isPlaying(int){return 0;}void stop(int){++audioStops;}
 bool playRaw(int16_t*,int,int,bool,int,int,bool){return true;}};
struct {struct Display Display;struct Speaker Speaker;} M5Cardputer;
const uint8_t* s1_nes_row(int y){assert(y>=0&&y<240);return rowData;}
uint16_t s1_nes_color(uint8_t c){return palette[c%3];}
bool s1_nes_io_ok(){return ioOk;}
void s1_nes_frame(uint8_t pad,bool,int16_t*,int){lastPad=pad;++frames;}
void renderNesError(){++errors;}void render(){}
void stopNesGame(){++stopped;gNesRunning=false;gNesFaulted=false;}
bool startNesGame(int){++started;gNesRunning=true;return true;}
enum class UiMode {Home};void setUiMode(UiMode){}
template<class T>T clampValue(T n,T lo,T hi){return max(lo,min(hi,n));}
uint32_t millis(){return 1000;}uint32_t micros(){static uint32_t n=0;return n+=20000;}
void delay(int){}void logf(const char*,...){}
struct File {
 std::vector<uint8_t> data=std::vector<uint8_t>(1600,42);size_t position=0;int zeros=0,reads=0;
 explicit operator bool()const{return true;}size_t size()const{return data.size();}
 bool seek(size_t offset){position=offset;return offset<=size();}
 size_t read(uint8_t* out,size_t count){++reads;if(zeros){--zeros;return 0;}
  count=min<size_t>(count,300);count=min(count,size()-position);memcpy(out,data.data()+position,count);position+=count;return count;}
};
'''
code+='\n'+function('bool readNesRom(')
code+='\n'+function('void renderNesFrame()')
code+='\n'+function('void serviceNesApp()')
code+=r'''
int main(){
 for(int x=0;x<256;++x)rowData[x]=x%3;
 static_assert(nes_view::width(false)*3==nes_view::height*4);
 static_assert(nes_view::left(false)==30&&nes_view::left(true)==0);
 assert(nes_view::sourceX(0,false)==0&&nes_view::sourceX(179,false)==255);
 assert(nes_view::sourceRow(0)==0&&nes_view::sourceRow(134)==238);
 renderNesFrame();gNesWide=true;renderNesFrame();gNesWide=false;
 // The real key handler must route Enter to Start, never to app exit.
 gKeyboardState.enter=true;gKeyboardState.hid_keys={0x28};serviceNesApp();
 assert(gNesRunning&&stopped==0&&(lastPad&8));
 serviceNesApp();serviceNesApp();assert(gNesRunning&&stopped==0&&!(lastPad&8));
 gKeyboardState={};serviceNesApp();gKeyboardState.word={'f'};serviceNesApp();assert(gNesWide);
 serviceNesApp();assert(gNesWide);gKeyboardState={};serviceNesApp();
 gKeyboardState.word={'f'};serviceNesApp();assert(!gNesWide);gKeyboardState={};
 // Read errors pause without freeing the emulator or switching to the list.
 ioOk=false;serviceNesApp();int oldFrames=frames;
 assert(gNesRunning&&gNesFaulted&&errors==1&&stopped==0&&audioStops==1);
 gKeyboardState.enter=true;serviceNesApp();assert(frames==oldFrames&&gNesRunning);
 gKeyboardState={};gKeyboardState.hid_keys={0x29};serviceNesApp();assert(!gNesRunning&&stopped==1);
 // Sector reads retain offsets across short reads and one transient empty read.
 File file;file.zeros=1;uint8_t data[1200]={};assert(readNesRom(&file,100,data,sizeof(data)));
 for(auto byte:data)assert(byte==42);assert(file.reads>3);
 file.zeros=2;assert(!readNesRom(&file,0,data,10));
 assert(!readNesRom(&file,1500,data,200));
}
'''
with tempfile.TemporaryDirectory(prefix='s1-nes-ui-') as directory:
    path=pathlib.Path(directory);(path/'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',
        '-I'+str(root/'bots/CardputerADV/src'),str(path/'test.cpp'),'-o',str(path/'test')],check=True)
    subprocess.run([str(path/'test')],check=True)
print('NES UI PASS: native RGB pixels, 4:3/fill, Enter/escape, retained error state and short SD reads')
