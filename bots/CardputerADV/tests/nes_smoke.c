#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "s1_nes.h"
#include "nes/nes.h"
#include "cpu/nes6502.h"
#include "../src/honkeypong_rom.h"
static unsigned long long hash(void) {
  unsigned long long h=1469598103934665603ULL;
  for(int y=0;y<240;++y) for(int x=0;x<256;++x) h=(h^s1_nes_row(y)[x])*1099511628211ULL;
  return h;
}
static void screenshot(const char *path) {
  FILE *f=fopen(path,"wb"); assert(f); fprintf(f,"P6\n256 240\n255\n");
  for(int y=0;y<240;++y) for(int x=0;x<256;++x) {
    unsigned c=s1_nes_color(s1_nes_row(y)[x]);
    unsigned char rgb[]={((c>>11)&31)*255/31,((c>>5)&63)*255/63,(c&31)*255/31};
    fwrite(rgb,1,3,f);
  }
  fclose(f);
}
int main(int argc,char **argv) {
  int16_t audio[368];
  assert(!s1_nes_open(kHonkeyPongRom,8));
  for(int n=0;n<25;++n) {
    s1_nes_fail_after(n);
    if(s1_nes_open(kHonkeyPongRom,sizeof(kHonkeyPongRom))) s1_nes_frame(0,true,audio,367);
    s1_nes_close(); assert(s1_nes_memory()==0);
  }
  s1_nes_fail_after(-1);
  unsigned long long title=0,game=0;
  for(int cycle=0;cycle<12;++cycle) {
    assert(s1_nes_open(kHonkeyPongRom,sizeof(kHonkeyPongRom)));
    assert(s1_nes_memory()<128*1024);
    for(int i=0;i<360;++i) s1_nes_frame(0,true,audio,367);
    assert(nes_getcontextptr()->cpu->mem_page[0][20]==0);
    title=hash();
    if(cycle==0 && argc>1) screenshot(argv[1]);
    for(int i=0;i<3;++i) s1_nes_frame(8,true,audio,368);
    assert(nes_getcontextptr()->cpu->mem_page[0][20]==1);
    unsigned before=nes_getcontextptr()->cpu->mem_page[0][14];
    for(int i=0;i<20;++i) s1_nes_frame(0x10,true,audio,367);
    assert(nes_getcontextptr()->cpu->mem_page[0][14]!=before);
    for(int i=0;i<40;++i) s1_nes_frame(0x20,true,audio,367);
    game=hash(); assert(title!=game);
    if(cycle==0 && argc>2) screenshot(argv[2]);
    s1_nes_close(); assert(s1_nes_memory()==0);
  }
  printf("NES PASS: 12 enter/play/exit cycles, 25 allocation failures; title=%llx game=%llx\n",title,game);
}
