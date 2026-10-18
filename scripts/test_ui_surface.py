#!/usr/bin/env python3
"""Execute the real drawing-surface selection and frame presentation."""
from pathlib import Path
import os, subprocess,tempfile
root=Path(__file__).resolve().parents[1]
s=(root/'bots/CardputerADV/src/main_parts/006_main.cpp.inc').read_text()
def function(signature):
 a=s.index(signature);i=s.index('{',a)+1;n=1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
code=r'''
#include <cassert>
#include <cstdint>
namespace lgfx {struct LGFXBase{int draws=0;void drawFastHLine(int,int,int,uint16_t){++draws;}};}
struct Sprite:lgfx::LGFXBase{int pushes=0;void pushSprite(int,int){++pushes;}}gCanvasBuffer;
struct{lgfx::LGFXBase Display;}M5Cardputer;
bool gCanvasSpriteActive=true,gInboxHttpBusy=false;
unsigned millis(){return 1000;}uint16_t rgb565_local(int,int,int){return 1;}
'''+function('lgfx::LGFXBase& uiCanvas()')+function('void presentUiFrame()')+r'''
int main(){
 assert(&uiCanvas()==static_cast<lgfx::LGFXBase*>(&gCanvasBuffer));presentUiFrame();assert(gCanvasBuffer.pushes==1);
 gCanvasSpriteActive=false;gInboxHttpBusy=true;
 assert(&uiCanvas()==&M5Cardputer.Display);uiCanvas().drawFastHLine(1,2,3,0);presentUiFrame();
 assert(M5Cardputer.Display.draws==2&&gCanvasBuffer.pushes==1);
 gCanvasSpriteActive=true;presentUiFrame();assert(gCanvasBuffer.pushes==2&&gCanvasBuffer.draws==1);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-ui-surface-') as d:
 p=Path(d);(p/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra',str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True)
print('PASS actual UI surface: sprite and direct display both draw, background indicator paints, restored sprite presents once')
