#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include "s1_nes.h"

static size_t split,prg_io,chr_io;
static bool read_rom(void *context,size_t offset,uint8_t *destination,size_t length) {
  FILE *file=context;
  if(offset>=16 && offset<split)prg_io+=length;else if(offset>=split)chr_io+=length;
  return fseek(file,(long)offset,SEEK_SET)==0 && fread(destination,1,length,file)==length;
}
static void screenshot(const char *path) {
  FILE *file=fopen(path,"wb");assert(file);fprintf(file,"P6\n256 240\n255\n");
  for(int y=0;y<240;++y)for(int x=0;x<256;++x){
    unsigned c=s1_nes_color(s1_nes_row(y)[x]);
    uint8_t rgb[]={((c>>11)&31)*255/31,((c>>5)&63)*255/63,(c&31)*255/31};
    fwrite(rgb,1,3,file);
  }
  fclose(file);
}
int main(int argc,char **argv) {
  assert(argc>=3);FILE *file=fopen(argv[1],"rb");assert(file);
  fseek(file,0,SEEK_END);size_t size=ftell(file);
  for(int n=0;n<80;++n){
    s1_nes_fail_after(n);
    bool opened=s1_nes_open_stream(read_rom,file,size);
    if(opened) s1_nes_frame(0,true,NULL,0);
    s1_nes_close();assert(s1_nes_memory()==0);
  }
  fseek(file,4,SEEK_SET);split=16+(size_t)fgetc(file)*16384;prg_io=chr_io=0;
  s1_nes_fail_after(-1);assert(s1_nes_open_stream(read_rom,file,size));
  const size_t memory=s1_nes_memory();int16_t audio[368];
  for(int i=0;i<720;++i){
    uint8_t pad=(i>=240&&i<244)||(i>=480&&i<484)?8:(i>=560?0x80:0);
    s1_nes_frame(pad,true,audio,367);assert(s1_nes_io_ok());
  }
  screenshot(argv[2]);size_t io=s1_nes_io_bytes();s1_nes_close();assert(s1_nes_memory()==0);
  fclose(file);printf("ROM PASS bytes=%zu memory=%zu io=%zu frames=720 failures=80 prg=%zu chr=%zu\n",size,memory,io,prg_io,chr_io);
}
