#!/usr/bin/env python3
"""Actual fixed-point synth: note mapping, tuning, envelopes, chords, fuzz, PCM."""
from pathlib import Path
import os,subprocess,tempfile,math,wave,struct
ROOT=Path(__file__).resolve().parents[1];SRC=ROOT/'bots/CardputerADV/src'
CODE=r'''
#include "pocket_synth.h"
#include <cassert>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <algorithm>
#include <string>
using namespace pocket_synth;
void drain(Synth&s,int n=10000){int16_t b[256];while(n>0){int count=std::min(n,256);s.render(b,count);n-=count;}}
int main(int argc,char**argv){
 if(argc==2){for(int patch=0;patch<4;++patch){Synth s;s.patch=Patch(patch);s.octave=4;s.gain=100;s.noteOn(9); // A4
  std::string path=std::string(argv[1])+"/patch"+std::to_string(patch)+".pcm";auto*f=fopen(path.c_str(),"wb");assert(f);
  for(uint32_t n=0;n<kRate;++n){int16_t v;s.render(&v,1);fwrite(&v,2,1,f);}fclose(f);}return 0;}
 double worst=0;for(uint32_t i=0;i<65536;++i){uint32_t phase=i<<16;double exact=sin(2*3.141592653589793*i/65536)*32767;worst=std::max(worst,fabs(sine(phase)-exact));}assert(worst<4);
 assert(strlen(kKeyMap)==25&&sizeof(Synth)<256);
 for(int i=0;i<25;++i){assert(keyIndex(kKeyMap[i])==i);if(kKeyMap[i]>='a')assert(keyIndex(char(kKeyMap[i]-32))==i);for(int j=0;j<i;++j)assert(kKeyMap[i]!=kKeyMap[j]);}
 assert(keyIndex('@')==13&&keyIndex('#')==15&&keyIndex('%')==18&&keyIndex('^')==20&&keyIndex('&')==22);
 assert(keyIndex('a')==-1&&keyIndex('p')==-1&&keyIndex(0)==-1);
 for(int midi=36;midi<=96;++midi){double hz=440*pow(2.,(midi-69)/12.);double actual=double(kSteps[midi-36])*kRate/4294967296.;assert(fabs(1200*log2(actual/hz))<0.001);char note[8];noteName(midi,note,sizeof(note));assert(strlen(note)>=2&&strlen(note)<=3);}
 char name[4];noteName(60,name,4);assert(!strcmp(name,"C4"));noteName(128,name,4);assert(!*name);noteName(60,name,1);assert(!*name);noteName(60,name,0);
 for(int patch=0;patch<4;++patch){Synth s;s.patch=Patch(patch);assert(!s.active());assert(!s.sync(0));assert(s.sync(1));drain(s,1000);auto age=s.voices[0].age;assert(!s.sync(1)&&s.voices[0].age==age); // hold never retriggers
  assert(s.sync(0));drain(s);assert(!s.active());s.setSustain(true);s.sync(1);drain(s,1000);s.sync(0);assert(s.active());s.setSustain(false);drain(s);assert(!s.active());
  s.sync(1);drain(s,kAttackSamples);assert(s.voices[0].env==32767);s.panic();assert(!s.active()&&s.heldMask==0&&s.lastMidi==-1);
  s.sync(0x1ffffff);assert(s.activeCount()==6);s.sync(0);drain(s);assert(!s.active());
  s.noteOn(-1);s.noteOn(25);s.noteOff(-1);s.noteOff(25);assert(!s.active());
  s.noteOn(0);drain(s,kRate*11);assert(!s.active()); // watchdog silences lost-release/sustain
 }
 Synth s;assert(s.midiFor(0)==48&&s.midiFor(24)==72);for(int i=0;i<10;++i)s.nextOctave(-1);assert(s.octave==2&&s.midiFor(0)==36);for(int i=0;i<10;++i)s.nextOctave(1);assert(s.octave==5&&s.midiFor(24)==96);
 for(int i=0;i<4;++i)s.nextPatch(1);assert(s.patch==Patch::Piano);s.nextPatch(-1);assert(s.patch==Patch::Chip);
 for(int l=1;l<=3;++l){s.lesson=Lesson(l);s.lessonStep=0;int n=l==3?6:8;for(int i=0;i<n*4;++i){int target=s.targetKey();int step=s.lessonStep;s.noteOn(24);assert(s.lessonStep==step);s.noteOn(target);assert(s.lessonStep==(step+1)%n);}assert(s.lessonStep==0);}
 s=Synth{};s.patch=Patch::Organ;s.gain=0;s.noteOn(0);s.panic();int16_t b[256];s.render(b,256);for(int v:b)assert(v==0);
 uint32_t rng=42;for(int i=0;i<100000;++i){rng=rng*1664525+1013904223;s.sync(rng);if(i%103==0)s.setSustain(!s.sustain);if(i%109==0)s.nextPatch(1);if(i%127==0)s.nextOctave(i%2?1:-1);s.render(b,8);assert(s.activeCount()<=6);for(int j=0;j<8;++j)assert(b[j]>=-16384&&b[j]<=16384);}
 s.panic();s.render(b,256);for(int v:b)assert(v==0);
 puts("PASS actual Pocket Synth: 25 chromatic keys, C2-C7 range, A440 tuning, 6-voice bounded chords, four patches, gain, sustain/release/panic, 3 scale coaches, watchdog and 100000 fuzz steps (ASan/UBSan)");
}
'''
with tempfile.TemporaryDirectory(prefix='pocket-synth-') as tmp:
 p=Path(tmp);(p/'test.cpp').write_text(CODE)
 subprocess.run([os.environ.get('CXX','c++'),'-std=c++17','-O1','-Wall','-Wextra','-Werror','-Wno-misleading-indentation','-fsanitize=address,undefined','-fno-omit-frame-pointer','-no-pie','-I'+str(SRC),str(p/'test.cpp'),'-o',str(p/'test')],check=True)
 subprocess.run([str(p/'test')],check=True,timeout=60)
 subprocess.run([str(p/'test'),str(p)],check=True,timeout=20)
 pcm=[]
 for patch in range(4):
  raw=(p/f'patch{patch}.pcm').read_bytes();samples=struct.unpack('<'+'h'*(len(raw)//2),raw);assert len(samples)==48000 and max(samples)>100 and min(samples)<-100
  assert max(abs(x) for x in samples)<=16384
  # Fundamental checked from rendered PCM (not merely the phase table).
  a=samples[4800:14400];n=len(a)
  def energy(hz):return abs(sum(v*complex(math.cos(2*math.pi*hz*i/48000),math.sin(2*math.pi*hz*i/48000)) for i,v in enumerate(a)))
  assert energy(440)>energy(430)*10 and energy(440)>energy(450)*10
  pcm.append(raw)
 assert len(set(pcm))==4
 # Steady organ contains only 440/880/1760 Hz. Measure residual noise from
 # actual PCM after removing these harmonics (0.2s contains integer periods).
 samples=struct.unpack('<'+'h'*(len(pcm[2])//2),pcm[2]);a=samples[4800:14400];n=len(a)
 total=sum(v*v for v in a);tonal=0
 for hz in (440,880,1760):
  re=sum(v*math.cos(2*math.pi*hz*i/48000) for i,v in enumerate(a));im=sum(v*math.sin(2*math.pi*hz*i/48000) for i,v in enumerate(a));tonal+=2*(re*re+im*im)/n
 snr=10*math.log10(tonal/max(1,total-tonal));assert snr>55, snr
 print(f'PASS actual 48k steady organ residual SNR {snr:.1f} dB; linear-interpolated oscillator peak error below 4/32767')
 print('PASS native 48k rendered PCM: all four sounds distinct, bounded/non-silent, A4 fundamental 440 Hz; no external samples or audio libraries')
