#!/usr/bin/env python3
"""Execute SD browser/delete handlers against an isolated fake filesystem."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'
source = (parts / '045_main.cpp.inc').read_text()
source = source[source.index('bool fileManagerBusy() {'):]
assert 'LittleFS' not in source and 'activeVoiceFs' not in source and '.rmdir' not in source
assert source.count('SD.remove(') == 1
renderer = (parts / '057_main.cpp.inc').read_text().split('void renderFileManagerUi() {', 1)[1]
renderer = 'void renderFileManagerUi() {' + renderer
code = r'''
#include <cassert>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <map>
#include <string>
#include <type_traits>
#include <vector>
#include "sd_file_manager.h"
using std::max;using std::min;
struct String:std::string {
 using std::string::string;
 String(const std::string&s):std::string(s){}
 template<class T,typename=std::enable_if_t<std::is_integral_v<T>>>
 String(T n):std::string(std::to_string(n)){}
 int compareTo(const String&s)const{return compare(s);}
};
struct Node {bool directory;uint64_t size;};
std::map<std::string,Node> disk;
struct File {
 std::string name;bool valid=false;Node node{};std::vector<std::string>children;size_t next=0;
 explicit operator bool()const{return valid;}
 bool isDirectory()const{return node.directory;}
 uint64_t size()const{return node.size;}
 const char*path()const{return name.c_str();}
 void close(){valid=false;}
 File openNextFile();
};
struct FakeSD {
 int removes=0;
 File open(const char*p,const char* = "r"){
  File f;if(!disk.count(p))return f;
  f.name=p;f.node=disk[p];f.valid=true;
  if(f.node.directory)for(auto item:disk)if(sd_file_manager::directChild(p,item.first))f.children.push_back(item.first);
  return f;
 }
 bool remove(const char*p){++removes;if(!disk.count(p)||disk[p].directory)return false;disk.erase(p);return true;}
}SD;
File File::openNextFile(){return next<children.size()?SD.open(children[next++].c_str()):File{};}
namespace Keyboard_Class {struct KeysState{bool tab=false,ctrl=false,alt=false,fn=false,enter=false,del=false;};}
bool hasHidKey(const Keyboard_Class::KeysState&,uint8_t){return false;}
constexpr uint8_t kHidKeyEscape=41;
bool gSdReady=true,gRecording=false,gSubmitting=false,gPlaybackActive=false,gRealtimeActive=false;
bool gInboxHttpBusy=false,gVoiceReplySpeechBusy=false,gVoiceDialBusy=false,gRealtimeDialBusy=false;
bool gBlockingInputPumpActive=false,gBootBackgroundActive=false,gNotesScanned=true;
void clearEmojiCache(){}
enum class UiMode{Files,Home};UiMode mode=UiMode::Files;
void setUiMode(UiMode m){mode=m;}
struct SdFileEntry{String name,path;uint64_t size;bool directory;};
std::vector<SdFileEntry>gFileEntries;
String gFilesDir="/",gFilesStatus;int gSelectedFile=0;bool gFilesTruncated=false;
sd_file_manager::DeletePrompt gFileDelete;
template<class T>T clampValue(T n,T low,T high){return max(low,min(n,high));}
String filenameFromPath(const String&p){return p.substr(p.rfind('/')+1);}
String parentDirOf(const String&p){auto i=p.rfind('/');return i==0?String("/"):String(p.substr(0,i));}
''' + source + r'''
namespace fonts {int Font0=0,Font2=2;}
constexpr uint16_t TFT_WHITE=0xffff;
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r&0xf8)<<8)|((g&0xfc)<<3)|(b>>3);}
struct Rect{int x,y,w,h;};
struct Canvas{
 const int*font=&fonts::Font0;int x=0,y=0;std::vector<Rect>text;
 void fillScreen(uint16_t){text.clear();}
 template<class...T>void fillRoundRect(T...){}
 void setFont(const int*f){font=f;}
 void setTextColor(uint16_t,uint16_t){}
 void setCursor(int xx,int yy){x=xx;y=yy;}
 int textWidth(const String&s){return int(s.size())*(font==&fonts::Font0?6:8);}
 void print(const String&s){Rect r{x,y,textWidth(s),font==&fonts::Font0?8:16};assert(x>=6&&y>=5&&x+r.w<=234&&y+r.h<=129);for(auto p:text)assert(x+r.w<=p.x||p.x+p.w<=x||y+r.h<=p.y||p.y+p.h<=y);text.push_back(r);}
}gCanvas;
String fitCurrentFontToWidth(const String&s,int w){return s.substr(0,w/(gCanvas.font==&fonts::Font0?6:8));}
String marqueeText(const String&s,int w,int){return fitCurrentFontToWidth(s,w);}
void drawTinyFooter(uint16_t bg,uint16_t fg,const String&s,int x,int y,int w){gCanvas.setFont(&fonts::Font0);gCanvas.setTextColor(fg,bg);gCanvas.setCursor(x,y);gCanvas.print(fitCurrentFontToWidth(s,w));}
void renderLauncherOverlay(){}void renderDebugOverlay(){}
''' + renderer + r'''
void reset(){disk={{"/",{true,0}},{"/notes",{true,0}},{"/extra.wav",{false,1024}},{"/notes/a.txt",{false,20}}};SD.removes=0;gFilesDir="/";gSelectedFile=0;gSdReady=true;gRecording=false;gFileDelete.cancel();refreshFileManager();}
void selectFile(){gSelectedFile=1;assert(gFileEntries[1].path=="/extra.wav");}
int main(){
 using namespace sd_file_manager;
 for(auto p:{"", "relative", "/../file", "/a/./b", "/a//b", "/a/", "/a\\b", "/a:bad"})assert(!validPath(p));
 assert(validPath("/")&&validPath("/notes/a.txt"));
 assert(!directChild("/notes","/notes2/a")&&!directChild("/notes","/notes/sub/a"));
 Keyboard_Class::KeysState keys;
 reset();assert(gFileEntries.size()==2&&gFileEntries[0].directory);
 // Browsing and selecting never deletes; entering a directory and Escape go up.
 handleFileManagerKey('\n',keys);assert(gFilesDir=="/notes"&&SD.removes==0);
 handleFileManagerKey(27,keys);assert(gFilesDir=="/");
 handleFileManagerKey('d',keys);assert(!gFileDelete.pending()&&SD.removes==0);
 for(char cancel:{'n','\n',char(27),',','d'}){
  reset();selectFile();handleFileManagerKey('d',keys);assert(gFileDelete.pending()&&SD.removes==0);
  handleFileManagerKey(cancel,keys);assert(!gFileDelete.pending()&&SD.removes==0&&disk.count("/extra.wav"));
 }
 reset();selectFile();handleFileManagerKey('d',keys);handleFileManagerKey('y',keys);
 assert(SD.removes==1&&!disk.count("/extra.wav")&&disk.count("/notes/a.txt")&&gFilesStatus=="File deleted");
 handleFileManagerKey('y',keys);assert(SD.removes==1); // One confirmation cannot be replayed.
 for(int guard=0;guard<5;++guard){
  reset();selectFile();handleFileManagerKey('d',keys);
  if(guard==0)gRecording=true;
  if(guard==1)gSdReady=false;
  if(guard==2)disk["/extra.wav"].size=2048;
  if(guard==3)disk["/extra.wav"].directory=true;
  if(guard==4)disk.erase("/extra.wav");
  handleFileManagerKey('y',keys);assert(SD.removes==0&&!gFileDelete.pending());
 }
 reset();selectFile();handleFileManagerKey('d',keys);keys.ctrl=true;
 handleFileManagerKey('y',keys);assert(SD.removes==0&&!gFileDelete.pending());keys.ctrl=false;
 reset();for(int i=0;i<150;++i)disk["/file"+std::to_string(i)]={false,0};refreshFileManager();
 assert(gFileEntries.size()==kMaxEntries&&gFilesTruncated);
 for(int selected=0;selected<128;++selected){gSelectedFile=selected;renderFileManagerUi();}
 reset();selectFile();handleFileManagerKey('d',keys);renderFileManagerUi();
 reset();gSdReady=false;refreshFileManager();assert(gFileEntries.empty());
 renderFileManagerUi();
}
'''
with tempfile.TemporaryDirectory(prefix='s1-sd-files-') as directory:
    p = Path(directory)
    (p / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-I', str(root / 'bots/CardputerADV/src'), str(p / 'test.cpp'), '-o', str(p / 'test')], check=True)
    subprocess.run([str(p / 'test')], check=True)
print('PASS actual SD browser/delete handlers: navigation, cancel/default-no, one-shot confirmation, busy/removed/changed/directory guards and bounded listing')
