#!/usr/bin/env python3
"""Execute actual settings navigation and the shared launcher settings registry."""
from pathlib import Path
import os,re,subprocess,tempfile
root=Path(__file__).resolve().parents[1];p=root/'bots/CardputerADV/src/main_parts'
def fn(name):
 s=(p/'047_main.cpp.inc').read_text();a=s.index(name);i=s.index('{',a)+1;n=1
 while n:n+=(s[i]=='{')-(s[i]=='}');i+=1
 return s[a:i]
def block(s,marker):
 a=s.index(marker);return s[a:s.index('\n};',a)+3]
code=r'''
#include <cassert>
#include <cstdint>
#include <cstring>
#include <string>
constexpr uint16_t rgb565_local(int r,int g,int b){return ((r>>3)<<11)|((g>>2)<<5)|(b>>3);}
'''
code+=block((p/'002_main.cpp.inc').read_text(),'enum class UiMode : uint8_t')
constants=(p/'001_main.cpp.inc').read_text()
for name in ['kLauncherGroupCount','kLauncherMaxSubItems']:
 code+=re.search(r'constexpr uint8_t '+name+r' = \d+;',constants)[0]
source=(p/'004_main.cpp.inc').read_text()
for marker in ['struct LauncherSubItem {','struct LauncherGroup {','constexpr LauncherGroup kLauncherGroups']:
 code+=block(source,marker)
code+=r'''
UiMode gUiMode=UiMode::Home,lastHub=UiMode::Home;bool gLauncherVisible=false;int gSelectedSetting=0,adjusted=0;
int currentSettingsItemCount(){return 11;}
void adjustCurrentSetting(int d){adjusted+=d;}
void setUiMode(UiMode m){gUiMode=m;}
void syncLauncherToMode(UiMode m){lastHub=m;}
void setStatus(const char*,int){}
namespace Keyboard_Class{struct KeysState{bool enter=false,space=false;};}
int selected=0,lampValue=0,power=0;
void smartLampSelectControl(int d){selected+=d;}void smartLampAdjustSelected(int d){lampValue+=d;}
void smartLampTogglePower(){++power;}void smartLampStartScan(){}
'''
for name in ['bool isSettingsMode(', 'bool returnToSettingsHub()', 'bool handleSettingsNavigation(', 'bool handleSmartLampKey(']:code+=fn(name)+'\n'
code+=r'''
int main(){
 int settingsGroups=0,settingsEntries=0;
 for(const auto&g:kLauncherGroups){for(int i=0;i<g.count;++i)if(isSettingsMode(g.items[i].mode)){++settingsEntries;assert(std::strcmp(g.title,"Settings")==0);}
 if(std::strcmp(g.title,"Settings")==0){++settingsGroups;assert(g.count==3);}}
 assert(settingsGroups==1&&settingsEntries==3&&kLauncherMaxSubItems==8);
 for(auto m:{UiMode::Settings,UiMode::ScreenSettings,UiMode::FocusSettings}){
  gUiMode=m;gLauncherVisible=false;gSelectedSetting=0;adjusted=0;
  assert(handleSettingsNavigation(true,false,false,false)&&gSelectedSetting==10);
  assert(handleSettingsNavigation(false,true,false,false)&&gSelectedSetting==0);
  assert(handleSettingsNavigation(false,false,true,false)&&adjusted==-1&&gSelectedSetting==0);
  assert(handleSettingsNavigation(false,false,false,true)&&adjusted==0&&gSelectedSetting==0);
  assert(returnToSettingsHub()&&lastHub==m&&gUiMode==UiMode::Home&&gLauncherVisible);
 }
 gUiMode=UiMode::SmartLamp;gLauncherVisible=false;assert(!returnToSettingsHub());
 Keyboard_Class::KeysState keys;
 handleSmartLampKey('w',keys);assert(selected==-1);handleSmartLampKey('s',keys);assert(selected==0);
 handleSmartLampKey('a',keys);assert(lampValue==-1);handleSmartLampKey('d',keys);assert(lampValue==0);
 keys.enter=true;handleSmartLampKey('\n',keys);assert(power==1);
}
'''
with tempfile.TemporaryDirectory(prefix='s1-settings-') as d:
 out=Path(d);(out/'test.cpp').write_text(code)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-Wall','-Wextra','-Werror',str(out/'test.cpp'),'-o',str(out/'test')],check=True)
 subprocess.run([str(out/'test')],check=True)
print('PASS actual Settings hub: exactly one registry, three sections, arrows select/edit consistently, Esc returns to hub; SmartLamp retains the same controls')
