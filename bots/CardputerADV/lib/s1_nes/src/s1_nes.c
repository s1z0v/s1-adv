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

extern mapintf_t map0_intf;
mapintf_t *mappers[] = { &map0_intf, NULL };
volatile int nofrendo_ticks;
const rgb_t gui_pal[GUI_TOTALCOLORS] = {{0,0,0}};
static nes_t *machine;
static bitmap_t *frame;
static nesinput_t pad = { INP_JOYPAD0, 0 };
static const uint8_t *image;
static size_t image_size, allocated;
static int fail_after = -1;
static uint16_t colors[256];
typedef union { struct { size_t size; } h; long double align; void *p; } allocation;

void *_my_malloc(int size) {
  if (size <= 0 || (size_t)size > 128*1024 || allocated+(size_t)size > 128*1024) return NULL;
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
  /* NROM only: reject NES2, trainers, battery saves, VS/PlayChoice, four-screen. */
  if (image[6]&0xFE || image[7] || (image[4]!=1 && image[4]!=2) || image[5]>1) return false;
  return image_size == 16u + image[4]*16384u + image[5]*8192u;
}
int rom_checkmagic(const char *filename) { (void)filename; return valid_image()?0:-1; }
char *rom_getinfo(rominfo_t *r) { (void)r; return "NROM"; }
rominfo_t *rom_load(const char *filename, ppu_t *ppu) {
  (void)filename; (void)ppu;
  if (!valid_image()) return NULL;
  rominfo_t *r=NOFRENDO_MALLOC(sizeof(*r)); if(!r) return NULL;
  r->rom_banks=image[4]; r->vrom_banks=image[5];
  r->mirror=(image[6]&1)?MIRROR_VERT:MIRROR_HORIZ;
  r->rom=(uint8 *)(image+16); r->vrom=image[5]?(uint8 *)(image+16+r->rom_banks*16384):NULL;
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
  NOFRENDO_FREE((*r)->sram); NOFRENDO_FREE((*r)->vram); NOFRENDO_FREE(*r);
}
extern void nes_step_frame(bool draw);
extern void input_reset(void);
void s1_nes_close(void) {
  if(machine) nes_destroy(&machine);
  bmp_destroy(&frame); image=NULL; image_size=0; pad.data=0; input_reset();
}
bool s1_nes_open(const uint8_t *rom, size_t size) {
  s1_nes_close(); image=rom; image_size=size;
  if (!valid_image()) { s1_nes_close(); return false; }
  frame=bmp_create(256,240,8);
  if(!frame) { s1_nes_close(); return false; }
  machine=nes_create();
  if(!machine) { s1_nes_close(); return false; }
  if(nes_insertcart("embedded.nes",machine)) {
    /* nes_insertcart owns destruction on failure. */
    machine=NULL; s1_nes_close(); return false;
  }
  input_register(&pad); input_strobe();
  return true;
}
void s1_nes_frame(uint8_t buttons, bool draw, int16_t *audio, int samples) {
  if(!machine) return;
  pad.data=buttons; nes_step_frame(draw);
  if(audio && samples>0) apu_process(audio,samples);
}
const uint8_t *s1_nes_row(int y) { return frame && y>=0 && y<240 ? frame->line[y] : NULL; }
uint16_t s1_nes_color(uint8_t i) { return colors[i & 63]; }
