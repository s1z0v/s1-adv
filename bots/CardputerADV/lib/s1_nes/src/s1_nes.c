/* S1-ADV Nofrendo host adapter, 2026. LGPL-2.0-only; see ../COPYING.
 * Immutable, bounded iNES loader; no filesystem/XIP partition changes. */
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include "s1_nes.h"
#include "nes/nes.h"
#include "nes/nesinput.h"
#include "nes/nes_pal.h"
#include "gui.h"
#include "nofrendo.h"

extern mapintf_t map0_intf, map4_intf;
mapintf_t *mappers[] = { &map0_intf, &map4_intf, NULL };
volatile int nofrendo_ticks;
const rgb_t gui_pal[GUI_TOTALCOLORS] = {{0,0,0}};
static nes_t *machine;
static bitmap_t *frame;
static uint8_t *viewport;
static uint8_t expanded_row[256];
static int expanded_y=-1;
static nesinput_t pad = { INP_JOYPAD0, 0 };
static const uint8_t *image;
static size_t image_size, allocated;
static s1_nes_reader image_reader;
static void *image_context;
static uint8_t image_header[16];
static int prg_window_ids[4], chr_window_ids[8];
static uint8_t *prg_cache[12];
static int prg_cache_count;
static int prg_ids[12];
static uint32_t prg_age[12],prg_clock;
static bool image_io_ok = true;
static size_t image_io_bytes;
static int fail_after = -1;
static uint16_t colors[256];
typedef union { struct { size_t size; } h; long double align; void *p; } allocation;

void *_my_malloc(int size) {
  if (size <= 0 || (size_t)size > 128*1024 || allocated+(size_t)size > 144*1024) return NULL;
  if (fail_after == 0) return NULL;
  if (fail_after > 0) --fail_after;
  allocation *p = calloc(1, sizeof(*p)+(size_t)size);
  if (!p) return NULL;
  p->h.size = size; allocated += size;
  return p+1;
}
void _my_free(void **value) {
  if (!value || !*value) return;
  allocation *p = (allocation *)*value-1;
  allocated -= p->h.size; free(p); *value = NULL;
}
char *_my_strdup(const char *s) {
  char *p = _my_malloc(strlen(s)+1); if(p) strcpy(p,s); return p;
}
size_t s1_nes_memory(void) { return allocated; }
bool s1_nes_streaming(void) { return image_reader != NULL; }
bool s1_nes_io_ok(void) { return image_io_ok; }
size_t s1_nes_io_bytes(void) { return image_io_bytes; }
static bool read_image(size_t offset, uint8_t *destination, size_t length) {
  if (offset > image_size || length > image_size-offset ||
      !image_reader(image_context,offset,destination,length)) {
    memset(destination,0,length); image_io_ok=false; return false;
  }
  image_io_bytes+=length; return true;
}
bool s1_nes_map_prg(int size_kb, uint32_t address, int bank) {
  rominfo_t *r=mmc_getinfo();const size_t span=(size_t)size_kb*1024;
  if (!r || !span || address<0x8000 || address+span>0x10000) { image_io_ok=false; return false; }
  const int banks=r->rom_banks*16384/span;
  if (!banks) { image_io_ok=false; return false; }
  bank=bank<0?banks-1:bank%banks;
  for (size_t offset=0;offset<span;offset+=8192) {
    const int slot=(address-0x8000+offset)/8192;
    const int id=((size_t)bank*span+offset)/8192;
    int cached=-1;
    for(int i=0;i<prg_cache_count;++i)if(prg_ids[i]==id){cached=i;break;}
    if(cached<0){
      for(int i=0;i<prg_cache_count;++i){
        bool pinned=false;for(int j=0;j<4;++j)if(prg_window_ids[j]==i)pinned=true;
        if(!pinned && (cached<0 || prg_age[i]<prg_age[cached]))cached=i;
      }
      if(cached<0 || !read_image(16+(size_t)id*8192,prg_cache[cached],8192))return false;
      prg_ids[cached]=id;
    }
    prg_window_ids[slot]=cached;prg_age[cached]=++prg_clock;
  }
  return true;
}
uint8_t *s1_nes_prg_page(uint32_t address) {
  if(address<0x8000 || address>=0x10000)return NULL;
  int cached=prg_window_ids[(address-0x8000)/8192];
  return cached<0?NULL:prg_cache[cached]+(address&8191);
}
uint8_t *s1_nes_chr_window(int size_kb, uint32_t address, int bank) {
  rominfo_t *r=mmc_getinfo();
  const size_t span=(size_t)size_kb*1024;
  if (!r || !span || address+span>8192) { image_io_ok=false; return NULL; }
  const int banks=r->vrom_banks*8192/span;
  if (!banks) { image_io_ok=false; return NULL; }
  bank=bank<0?banks-1:bank%banks;
  for (size_t offset=0;offset<span;offset+=1024) {
    const int slot=(address+offset)/1024;
    const int id=((size_t)bank*span+offset)/1024;
    if (chr_window_ids[slot]!=id) {
      if (read_image(16+(size_t)r->rom_banks*16384+(size_t)id*1024,r->vrom+slot*1024,1024)) chr_window_ids[slot]=id;
    }
  }
  return r->vrom+address;
}
void s1_nes_fail_after(int n) { fail_after=n; }
int nofrendo_log_printf(const char *format, ...) { (void)format; return 0; }
void gui_sendmsg(int color, char *format, ...) { (void)color; (void)format; }
void gui_frame(bool draw) { (void)draw; }
void gui_tick(int ticks) { (void)ticks; }
void vid_flush(void) {}
void osd_getinput(void) {}
void osd_setsound(void (*fn)(void *,int)) { (void)fn; }
void osd_getsoundinfo(sndinfo_t *info) { info->sample_rate=22050; info->bps=16; }
bitmap_t *vid_getbuffer(void) { return frame; }
void vid_setpalette(rgb_t *p) {
  for(int i=0;i<256;++i) colors[i]=((p[i].r&248)<<8)|((p[i].g&252)<<3)|(p[i].b>>3);
}

static bool valid_image(void) {
  if (!image || image_size<16 || memcmp(image,"NES\032",4)) return false;
  /* NROM/MMC3, including simple NES2 headers without extended banks/submappers. */
  unsigned mapper=(image[6]>>4)|(image[7]&0xF0);
  if (image[6]&0x0E || image[7]&0x03 || !image[4]) return false;
  if ((image[7]&0x0C)==0x08 && (image[8] || image[9])) return false;
  if (mapper!=0 && mapper!=4) return false;
  if (mapper==0 && ((image[4]!=1 && image[4]!=2) || image[5]>1)) return false;
  if (image[4]>32 || image[5]>32) return false;
  return image_size == 16u + image[4]*16384u + image[5]*8192u;
}
int rom_checkmagic(const char *filename) { (void)filename; return valid_image()?0:-1; }
char *rom_getinfo(rominfo_t *r) { (void)r; return r && r->mapper_number==4 ? "MMC3" : "NROM"; }
rominfo_t *rom_load(const char *filename, ppu_t *ppu) {
  (void)filename; (void)ppu;
  if (!valid_image()) return NULL;
  rominfo_t *r=NOFRENDO_MALLOC(sizeof(*r)); if(!r) return NULL;
  r->rom_banks=image[4]; r->vrom_banks=image[5];
  r->mapper_number=(image[6]>>4)|(image[7]&0xF0);
  r->mirror=(image[6]&1)?MIRROR_VERT:MIRROR_HORIZ;
  if (image_reader) {
    prg_cache_count=r->rom_banks*2; if(prg_cache_count>12)prg_cache_count=12;
    for(int i=0;i<prg_cache_count;++i) { prg_cache[i]=NOFRENDO_MALLOC(8192); if(!prg_cache[i]) { rom_free(&r); return NULL; } }
    r->rom=prg_cache[0];
    r->vrom=image[5]?NOFRENDO_MALLOC(8192):NULL;
    if (!r->rom || (image[5] && !r->vrom)) { rom_free(&r); return NULL; }
  } else {
    r->rom=(uint8 *)(image+16); r->vrom=image[5]?(uint8 *)(image+16+r->rom_banks*16384):NULL;
  }
  r->sram_banks=1; r->sram=NOFRENDO_MALLOC(8192);
  if (!r->sram) { rom_free(&r); return NULL; }
  if (!r->vrom) {
    r->vram_banks=1; r->vram=NOFRENDO_MALLOC(8192);
    if(!r->vram) { rom_free(&r); return NULL; }
  }
  return r;
}
void rom_free(rominfo_t **r) {
  if(!r || !*r) return;
  if (image_reader) { for(int i=0;i<12;++i)NOFRENDO_FREE(prg_cache[i]); NOFRENDO_FREE((*r)->vrom); }
  NOFRENDO_FREE((*r)->sram); NOFRENDO_FREE((*r)->vram); NOFRENDO_FREE(*r);
}
extern void nes_step_frame(bool draw);
extern void input_reset(void);
void s1_nes_close(void) {
  if(machine) nes_destroy(&machine);
  bmp_destroy(&frame); NOFRENDO_FREE(viewport); expanded_y=-1; image=NULL; image_size=0; image_reader=NULL; image_context=NULL; pad.data=0; input_reset();
}
static bool open_image(void) {
  image_io_ok=true; image_io_bytes=0;prg_clock=0;
  memset(prg_cache,0,sizeof(prg_cache));memset(prg_ids,0xFF,sizeof(prg_ids));memset(prg_age,0,sizeof(prg_age));
  memset(prg_window_ids,0xFF,sizeof(prg_window_ids)); memset(chr_window_ids,0xFF,sizeof(chr_window_ids));
  if (!valid_image()) { s1_nes_close(); return false; }
  viewport=NOFRENDO_MALLOC(128*120);
  if(!viewport){s1_nes_close();return false;}
  frame=bmp_create_scanline(256,240,8);
  if(!frame) { s1_nes_close(); return false; }
  machine=nes_create();
  if(!machine) { s1_nes_close(); return false; }
  if(nes_insertcart("embedded.nes",machine)) {
    /* nes_insertcart owns destruction on failure. */
    machine=NULL; s1_nes_close(); return false;
  }
  if (!image_io_ok) { s1_nes_close(); return false; }
  input_register(&pad); input_strobe();
  return true;
}
bool s1_nes_open(const uint8_t *rom, size_t size) {
  s1_nes_close(); image=rom; image_size=size; return open_image();
}
bool s1_nes_open_stream(s1_nes_reader reader, void *context, size_t size) {
  s1_nes_close();
  if (!reader || !reader(context,0,image_header,sizeof(image_header))) return false;
  image_reader=reader; image_context=context; image=image_header; image_size=size;
  return open_image();
}
void s1_nes_frame(uint8_t buttons, bool draw, int16_t *audio, int samples) {
  if(!machine) return;
  pad.data=buttons; expanded_y=-1; nes_step_frame(draw);
  if(audio && samples>0) apu_process(audio,samples);
}
void s1_nes_capture_scanline(int y) {
  if(!viewport || !frame || y<0 || y>=240 || !(y&1))return;
  for(int x=0;x<128;++x)viewport[(y/2)*128+x]=frame->line[y][x*2];
}
const uint8_t *s1_nes_row(int y) {
  if(!viewport || y<0 || y>=240)return NULL;
  if(expanded_y!=y/2){
    expanded_y=y/2;for(int x=0;x<256;++x)expanded_row[x]=viewport[expanded_y*128+x/2];
  }
  return expanded_row;
}
uint16_t s1_nes_color(uint8_t i) { return colors[i & 63]; }
