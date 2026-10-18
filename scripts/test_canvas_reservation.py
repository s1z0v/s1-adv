#!/usr/bin/env python3
"""Keep complete frames and the same heap allocation through actual TLS paths."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
text = (root / 'bots/CardputerADV/src/main_parts/006_main.cpp.inc').read_text()
start = text.index('bool releaseUiCanvasForNetwork(')
end = text.index('\nvoid restoreUiCanvasAfterNetwork()', start)
function = text[start:end]
code = r'''
#include <cassert>
#include <cstring>
#include <cstdint>
bool gCanvasSpriteActive=true;int deletes=0,waits=0;
struct {void deleteSprite(){++deletes;}}gCanvasBuffer;
struct {struct {void waitDMA(){++waits;}}Display;}M5Cardputer;
struct {unsigned getFreeHeap(){return 65000;}}ESP;
constexpr int MALLOC_CAP_8BIT=0;
unsigned heap_caps_get_largest_free_block(int){return 20000;}
void yield(){}void delay(int){}void logf(const char*,...){}
'''+function+r'''
int main(){
 for(int pass=0;pass<20;++pass)
  for(const char* reason:{"inbox memory","speech memory","realtime TLS","voice TLS","voice preconnect TLS","reply-audio","tts"}) {
   assert(!releaseUiCanvasForNetwork(reason));
   assert(gCanvasSpriteActive&&deletes==0&&waits==0);
  }
 assert(!releaseUiCanvasForNetwork(nullptr)&&gCanvasSpriteActive);
 assert(releaseUiCanvasForNetwork("NES")&&!gCanvasSpriteActive&&deletes==1&&waits==1);
 assert(!releaseUiCanvasForNetwork("NES")&&deletes==1);
}
'''
code = '#include <initializer_list>\n' + code
with tempfile.TemporaryDirectory(prefix='s1-canvas-reservation-') as directory:
    p=Path(directory);(p/'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
    subprocess.run([str(p/'test')],check=True)
print('PASS actual canvas ownership: all network paths retain complete frames; only NES releases after DMA')
