#!/usr/bin/env python3
"""Backpressure on USB must not block capture or lose the in-memory log."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parts = root / 'bots/CardputerADV/src/main_parts'
setup = (parts / '061_main.cpp.inc').read_text().split('void setup() {', 1)[1]
assert setup.index('Serial.setTxTimeoutMs(0)') < setup.index('Serial.begin(') < setup.index('Serial.println(')
source = (parts / '006_main.cpp.inc').read_text()
function = source[source.index('void logf('):source.index('lgfx::LGFXBase& uiCanvas()')]
code = r'''
#include <cassert>
#include <cstdarg>
#include <cstdio>
#include <string>
using String=std::string;
int timeout=100,waited=0;bool full=true;String saved,delivered;
struct {
 void setTxTimeoutMs(int value){timeout=value;}
 void println(const char* line){if(full){waited+=timeout;return;}delivered=line;}
} Serial;
void appendRuntimeLog(const String& area,const String& line,bool persist){
 assert(area=="SER"&&!persist);saved=line;
}
'''
code += function
code += r'''
int main(){
 Serial.setTxTimeoutMs(0);
 for(int second=0;second<20;++second){
  logf("[VOICE_REC] ms=%d bytes=%u",second*1000,unsigned(second*32000));
  assert(waited==0&&saved.find("[VOICE_REC]")==0&&delivered.empty());
 }
 full=false;logf("capture finished %u",20U);
 assert(waited==0&&saved=="capture finished 20"&&delivered==saved);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-usb-log-') as directory:
    path = Path(directory)
    (path / 'test.cpp').write_text(code)
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
print('PASS USB backpressure has no wait budget; runtime log survives and USB output resumes when drained')
