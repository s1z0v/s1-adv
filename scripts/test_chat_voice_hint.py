#!/usr/bin/env python3
"""Compile the actual chat footer drawing and check native display bounds."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'bots/CardputerADV/src/main_parts/060_main.cpp.inc').read_text()
start = source.index('void renderChatVoiceHint(')
end = source.index('\nvoid renderChatUi()', start)
code = r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
namespace fonts {int Font0;}
struct Canvas {
 int x=0,y=0;uint16_t ink=0;std::string text;
 void setFont(const int*){}
 void setTextColor(uint16_t color,uint16_t){ink=color;}
 void setCursor(int xx,int yy){x=xx;y=yy;}
 void print(const char* value){text=value;assert(x>=6&&x+text.size()*6<=234);assert(y>122&&y+8<=135);}
} gCanvas;
'''+source[start:end]+r'''
int main(){
 renderChatVoiceHint(false,0,1,2);assert(gCanvas.text=="Hold G0: voice  Tab: menu"&&gCanvas.ink==1);
 renderChatVoiceHint(true,0,1,2);assert(gCanvas.text=="Hold G0: reply  Tab: menu"&&gCanvas.ink==2);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-chat-hint-') as temp:
    cpp = Path(temp) / 'hint.cpp'
    binary = Path(temp) / 'hint'
    cpp.write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', str(cpp), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
print('Chat G0 footer: native bounds and clarification hint passed')
