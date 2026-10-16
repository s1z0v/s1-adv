#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Single-owner, one-frame-at-a-time NROM host. ROM bytes must outlive the session. */
bool s1_nes_open(const uint8_t *rom, size_t size);
void s1_nes_close(void);
void s1_nes_frame(uint8_t buttons, bool draw, int16_t *audio, int samples);
const uint8_t *s1_nes_row(int y);
uint16_t s1_nes_color(uint8_t index);
size_t s1_nes_memory(void);
void s1_nes_fail_after(int allocations); /* -1 disables fault injection */
#ifdef __cplusplus
}
#endif
