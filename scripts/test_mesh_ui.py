#!/usr/bin/env python3
"""Run the actual 240x135 renderer across empty/full/UTF-8/scroll states."""
import os
from pathlib import Path
import subprocess
import tempfile
ROOT=Path(__file__).resolve().parents[1]
source=(ROOT/'bots/CardputerADV/src/main_parts/068_main.cpp.inc').read_text()
render=source[source.index('String meshClip('):source.rindex('} // namespace')]
code=r'''
#include "mesh_leaf_state.h"
#include <algorithm>
#include <atomic>
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <memory>
#include <string>
#include <type_traits>
using std::min;
struct String:std::string {
 using std::string::string;using std::string::operator=;
 String(const std::string&s):std::string(s){}
 template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>String(T n):std::string(std::to_string(n)){}
 bool isEmpty()const{return empty();}
 void remove(size_t p){erase(p);}void remove(size_t p,size_t n){erase(p,n);}
 String substring(size_t p,size_t n)const{return substr(p,n-p);}
};
void removeLastUtf8Char(String&s){if(s.empty())return;size_t n=s.size()-1;while(n&&(uint8_t(s[n])&0xc0)==0x80)--n;s.erase(n);}
namespace fonts {int Font0=0,Font2=2,efontCN_12=12;}
constexpr int TFT_WHITE=65535;int rgb565_local(int,int,int){return 0;}
struct Canvas {
 int font=0,x=0,y=0,calls=0;bool clipped=false;
 void fillScreen(int){++calls;}
 void setTextSize(int n){assert(n==1);}void setFont(int*p){font=*p;}
 void setTextColor(int,int){}void setCursor(int a,int b){x=a;y=b;}
 int textWidth(const String&s)const {
  int w=0;for(size_t i=0;i<s.size();++i)if((uint8_t(s[i])&0xc0)!=0x80)w+=font==0?6:font==2?8:uint8_t(s[i])<128?6:12;
  return w;
 }
 template<class T>void print(T value){String s(value);int w=textWidth(s),h=font==0?8:font==2?16:12;
  if(w){assert(x>=0&&x+w<=240&&y>=0&&y+h<=135);if(clipped)assert(x>=8&&x+w<=232&&y>=54&&y+h<=126);}
  x+=w;++calls;
 }
 void printf(const char*f,...){char b[128];va_list a;va_start(a,f);vsnprintf(b,sizeof(b),f,a);va_end(a);print(b);}
 void drawRect(int a,int b,int w,int h,int){assert(a>=0&&b>=0&&a+w<=240&&b+h<=135);++calls;}
 void drawFastHLine(int a,int b,int w,int){assert(a>=0&&b>=0&&a+w<=240&&b<135);++calls;}
 void setClipRect(int a,int b,int w,int h){assert(a==8&&b==54&&w==224&&h==72);clipped=true;}
 void clearClipRect(){clipped=false;}
}gCanvas;
namespace s1_mesh {
constexpr int kInitPending=-32768;
struct RadioSession {State state;std::atomic<int>initResult{0};};
}
std::unique_ptr<s1_mesh::RadioSession>gMeshSession;
bool gMeshBusOwned=false,gSdReady=true;String gMeshNotice;
uint32_t millis(){return 1234567890;}
'''+render+r'''
int main() {
 for(bool sd:{false,true}){gSdReady=sd;renderMeshUi();assert(!gCanvas.clipped);}
 gMeshSession=std::make_unique<s1_mesh::RadioSession>();gMeshBusOwned=true;gSdReady=false;
 for(int init:{0,s1_mesh::kInitPending,-19}) {gMeshSession->initResult=init;renderMeshUi();assert(!gCanvas.clipped);}
 gMeshSession->initResult=0;auto& s=gMeshSession->state;
 for(uint32_t n=1;n<=16;++n){auto* p=s.hear(n,UINT32_MAX-n,int16_t(n%2?-32768:32767));memset(p->name,'W',40);p->name[40]=0;}
 for(unsigned type=0;type<3;++type) {
  std::string text;
  for(unsigned n=0;n<200;++n)text+=type==0?"W":type==1?u8"Я":u8"😀";
  for(unsigned m=0;m<8;++m)s.message(m+1,type*100+m,m%2,reinterpret_cast<const uint8_t*>(text.data()),text.size());
  s.append(std::string(200,'W').c_str());
  for(size_t scroll=0;scroll<s.messageCount;++scroll)for(bool detail:{false,true}) {
   s.historyOffset=scroll;s.detailView=detail;s.nodeView=false;renderMeshUi();assert(!gCanvas.clipped);
  }
 }
 s.nodeView=true;s.detailView=false;
 for(size_t page=0;page<9;++page){s.nodePage=page;renderMeshUi();assert(!gCanvas.clipped);}
 assert(gCanvas.calls>500);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-mesh-ui-') as directory:
    p=Path(directory);(p/'ui.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',
                    '-fsanitize=address,undefined','-fno-omit-frame-pointer',
                    '-I'+str(ROOT/'bots/CardputerADV/src'),str(p/'ui.cpp'),'-o',str(p/'ui')],check=True)
    subprocess.run([str(p/'ui')],check=True)
print('PASS actual Mesh renderer: 240x135 bounds, startup/failure/empty, 16 nodes, every history/page, long ASCII/Cyrillic/emoji and clip-state restoration (ASan/UBSan)')
