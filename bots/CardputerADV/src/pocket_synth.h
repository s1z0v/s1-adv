#pragma once
// Offline six-voice additive synth; no heap, sample files, tasks or device APIs.
#include <cstddef>
#include <cstdint>
#include <cstdio>

namespace pocket_synth {
constexpr uint32_t kRate=22050;
constexpr int kVoices=6,kKeys=25;
constexpr char kKeyMap[]="zsxdcvgbhnjmq2w3er5t6y7ui";
// Generated equal-tempered A4=440 Hz phase increments and one sine cycle.
// Tables live in flash; no floating-point work occurs in the audio loop.
constexpr int16_t kSine[]={
  0,804,1608,2410,3212,4011,4808,5602,6393,7179,7962,8739,
  9512,10278,11039,11793,12539,13279,14010,14732,15446,16151,16846,17530,
  18204,18868,19519,20159,20787,21403,22005,22594,23170,23731,24279,24811,
  25329,25832,26319,26790,27245,27683,28105,28510,28898,29268,29621,29956,
  30273,30571,30852,31113,31356,31580,31785,31971,32137,32285,32412,32521,
  32609,32678,32728,32757,32767,32757,32728,32678,32609,32521,32412,32285,
  32137,31971,31785,31580,31356,31113,30852,30571,30273,29956,29621,29268,
  28898,28510,28105,27683,27245,26790,26319,25832,25329,24811,24279,23731,
  23170,22594,22005,21403,20787,20159,19519,18868,18204,17530,16846,16151,
  15446,14732,14010,13279,12539,11793,11039,10278,9512,8739,7962,7179,
  6393,5602,4808,4011,3212,2410,1608,804,0,-804,-1608,-2410,
  -3212,-4011,-4808,-5602,-6393,-7179,-7962,-8739,-9512,-10278,-11039,-11793,
  -12539,-13279,-14010,-14732,-15446,-16151,-16846,-17530,-18204,-18868,-19519,-20159,
  -20787,-21403,-22005,-22594,-23170,-23731,-24279,-24811,-25329,-25832,-26319,-26790,
  -27245,-27683,-28105,-28510,-28898,-29268,-29621,-29956,-30273,-30571,-30852,-31113,
  -31356,-31580,-31785,-31971,-32137,-32285,-32412,-32521,-32609,-32678,-32728,-32757,
  -32767,-32757,-32728,-32678,-32609,-32521,-32412,-32285,-32137,-31971,-31785,-31580,
  -31356,-31113,-30852,-30571,-30273,-29956,-29621,-29268,-28898,-28510,-28105,-27683,
  -27245,-26790,-26319,-25832,-25329,-24811,-24279,-23731,-23170,-22594,-22005,-21403,
  -20787,-20159,-19519,-18868,-18204,-17530,-16846,-16151,-15446,-14732,-14010,-13279,
  -12539,-11793,-11039,-10278,-9512,-8739,-7962,-7179,-6393,-5602,-4808,-4011,
  -3212,-2410,-1608,-804,
};
constexpr uint32_t kSteps[]={
  12740059,13497623,14300233,15150569,16051469,17005939,18017165,19088521,20223584,21426141,22700205,24050030,
  25480119,26995246,28600467,30301139,32102938,34011878,36034330,38177043,40447168,42852281,45400411,48100060,
  50960238,53990491,57200933,60602278,64205876,68023757,72068660,76354085,80894335,85704563,90800821,96200119,
  101920476,107980983,114401866,121204555,128411753,136047513,144137319,152708170,161788671,171409126,181601643,192400238,
  203840952,215961966,228803732,242409110,256823506,272095026,288274639,305416341,323577341,342818251,363203285,384800477,
  407681904,
};

inline char normalize(char c) {
  if(c>='A'&&c<='Z')return char(c-'A'+'a');
  switch(c){case '@':return '2';case '#':return '3';case '%':return '5';case '^':return '6';case '&':return '7';default:return c;}
}
inline int keyIndex(char c){c=normalize(c);for(int i=0;i<kKeys;++i)if(kKeyMap[i]==c)return i;return -1;}
inline void noteName(int midi,char* out,size_t size){
  static constexpr const char* names[]={"C","C#","D","D#","E","F","F#","G","G#","A","A#","B"};
  if(midi<0||midi>127){if(size)out[0]=0;return;}snprintf(out,size,"%s%d",names[midi%12],midi/12-1);
}
enum class Patch:uint8_t{Piano,Bell,Organ,Chip};
enum class Lesson:uint8_t{Free,Major,Minor,Penta};
inline const char* patchName(Patch p){switch(p){case Patch::Piano:return "Soft Piano";case Patch::Bell:return "Bell";case Patch::Organ:return "Organ";case Patch::Chip:return "Chiptune";}return "?";}
inline const char* lessonName(Lesson p){switch(p){case Lesson::Free:return "FREE";case Lesson::Major:return "C MAJOR";case Lesson::Minor:return "C MINOR";case Lesson::Penta:return "C PENTA";}return "?";}
inline int scaleOffset(Lesson p,int degree){
  static constexpr uint8_t scales[3][8]={{0,2,4,5,7,9,11,12},{0,2,3,5,7,8,10,12},{0,2,4,7,9,12,0,0}};
  if(p==Lesson::Free)return 0;const int n=p==Lesson::Penta?6:8;return scales[int(p)-1][degree%n];
}
struct Voice{uint32_t phase=0,step=0,age=0;int16_t midi=-1;uint16_t env=0;bool held=false,releasing=false;};
struct Synth {
  Voice voices[kVoices];Patch patch=Patch::Piano;Lesson lesson=Lesson::Free;
  int octave=3,gain=65,lessonStep=0,lastMidi=-1;bool sustain=false;uint32_t heldMask=0;
  void panic(){for(auto&v:voices)v=Voice{};heldMask=0;lastMidi=-1;}
  int midiFor(int key)const{return 12*(octave+1)+key;}
  int targetKey()const{return scaleOffset(lesson,lessonStep);}
  void nextPatch(int delta){panic();patch=Patch((int(patch)+delta+4)%4);}
  void nextOctave(int delta){panic();octave+=delta;if(octave<2)octave=2;if(octave>5)octave=5;lessonStep=0;}
  void nextLesson(){lesson=Lesson((int(lesson)+1)%4);lessonStep=0;}
  void setSustain(bool on){sustain=on;if(!on)for(auto&v:voices)if(!v.held)v.releasing=true;}
  void noteOn(int key){
    if(key<0||key>=kKeys)return;const int midi=midiFor(key);lastMidi=midi;
    if(lesson!=Lesson::Free&&key==targetKey())lessonStep=(lessonStep+1)%(lesson==Lesson::Penta?6:8);
    Voice* slot=nullptr;
    for(auto&v:voices)if(v.midi==midi){slot=&v;break;}
    if(!slot)for(auto&v:voices)if(v.midi<0){slot=&v;break;}
    if(!slot){slot=&voices[0];for(auto&v:voices)if((v.releasing&&!slot->releasing)||(v.releasing==slot->releasing&&v.age>slot->age))slot=&v;}
    *slot=Voice{};slot->midi=midi;slot->step=kSteps[midi-36];slot->held=true;
  }
  void noteOff(int key){if(key<0||key>=kKeys)return;for(auto&v:voices)if(v.midi==midiFor(key)){v.held=false;if(!sustain)v.releasing=true;}}
  bool sync(uint32_t mask){mask&=(uint32_t(1)<<kKeys)-1;const uint32_t changed=mask^heldMask;
    for(int i=0;i<kKeys;++i)if((changed&(uint32_t(1)<<i))&&!(mask&(uint32_t(1)<<i)))noteOff(i);
    for(int i=0;i<kKeys;++i)if((changed&mask)&(uint32_t(1)<<i))noteOn(i);
    heldMask=mask;return changed!=0;
  }
  bool active()const{for(const auto&v:voices)if(v.midi>=0)return true;return false;}
  int activeCount()const{int n=0;for(const auto&v:voices)n+=v.midi>=0;return n;}
  int waveform(const Voice&v)const{
    int hs[3]={1,2,3},ws[3]={6,2,1};
    if(patch==Patch::Bell){hs[1]=3;hs[2]=7;ws[0]=4;ws[1]=2;}
    else if(patch==Patch::Organ){hs[2]=4;ws[0]=4;}
    else if(patch==Patch::Chip){hs[1]=3;hs[2]=5;ws[0]=5;ws[1]=2;}
    int sum=0,weight=0;
    for(int h=0;h<3;++h){if(uint64_t(v.step)*hs[h]>=0x80000000ULL)continue;
      sum+=int(kSine[(v.phase*uint32_t(hs[h]))>>24])*ws[h];weight+=ws[h];}
    return weight?sum/weight:0;
  }
  void render(int16_t* out,size_t count){
    if(!out)return;
    for(size_t i=0;i<count;++i){int32_t mixed=0;
      for(auto&v:voices){if(v.midi<0)continue;
        if(v.age>=kRate*10)v.releasing=true;
        if(v.releasing){const int drop=patch==Patch::Organ?32:8;if(v.env<=drop){v=Voice{};continue;}v.env-=drop;}
        else if(v.age<64){v.env=uint16_t((v.age+1)*511);}
        else if(patch!=Patch::Organ){const int drop=patch==Patch::Bell?2:patch==Patch::Piano?1:0;if(v.env<=drop){v=Voice{};continue;}v.env-=drop;}
        mixed+=int32_t(int64_t(waveform(v))*v.env/32768);v.phase+=v.step;if(v.age!=UINT32_MAX)++v.age;
      }
      // Six equal shares: even a full chord cannot clip. The device's master
      // volume is unchanged; this app-local gain only scales its own PCM.
      out[i]=int16_t(int64_t(mixed)*gain/(kVoices*100*2));
    }
  }
};
static_assert(sizeof(Synth)<256,"Keep the synth runtime small");
} // namespace pocket_synth
