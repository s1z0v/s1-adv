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
typedef struct {const uint8_t *bytes;size_t size;bool fail;} source_t;
static bool read_source(void *context,size_t offset,uint8_t *destination,size_t length) {
  source_t *s=context;if(s->fail||offset>s->size||length>s->size-offset)return false;
  memcpy(destination,s->bytes+offset,length);return true;
}
static void streaming_banks(void) {
  size_t size=16+131072+8192;uint8_t *rom=calloc(1,size);assert(rom);
  memcpy(rom,"NES\032",4);rom[4]=8;rom[5]=1;rom[6]=0x40;
  for(int bank=0;bank<16;++bank)memset(rom+16+bank*8192,bank,8192);
  source_t source={rom,size,false};assert(s1_nes_open_stream(read_source,&source,size));
  for(int round=0;round<10;++round)for(int bank=0;bank<8;++bank){
    mmc_bankrom(8,0x8000,bank);nes6502_context current;nes6502_getcontext(&current);assert(current.mem_page[8][100]==bank);
  }
  assert(s1_nes_io_bytes()<150000);source.fail=true;mmc_bankrom(8,0x8000,12);
  assert(!s1_nes_io_ok());s1_nes_close();assert(s1_nes_memory()==0);free(rom);
  source_t sample={kHonkeyPongRom,sizeof(kHonkeyPongRom),false};
  assert(s1_nes_open_stream(read_source,&sample,sizeof(kHonkeyPongRom)));
  for(int i=0;i<30;++i)s1_nes_frame(0,true,NULL,0);
  assert(s1_nes_io_ok()&&s1_nes_memory()<144*1024);s1_nes_close();assert(s1_nes_memory()==0);
}
int main(int argc,char **argv) {
  int16_t audio[368];
  assert(!s1_nes_open(kHonkeyPongRom,8));
  for(int n=0;n<80;++n) {
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
  streaming_banks();
  printf("NES PASS: 12 enter/play/exit cycles, 80 allocation failures; title=%llx game=%llx\n",title,game);
}
