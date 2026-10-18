# S1-ADV NES adapter

Nofrendo by Matthew Conte and contributors, via
[arduino-nofrendo](https://github.com/moononournation/arduino-nofrendo) and
[Cardputer Game Station](https://github.com/geo-tp/Cardputer-Game-Station-Emulators),
snapshot `74b47763c3f2ccbaed6505b83ef0ef37c2deac82` (2026-10-17).

The core is **GNU Library GPL version 2**, not the MIT license of its containing
upstream repository. Original source notices and the full [license](COPYING)
are retained. S1-ADV changes in this directory are under the same LGPL-2.0-only
license. The complete firmware source and PlatformIO build scripts are included
so the library can be modified, rebuilt and relinked. Debugging/reverse
engineering modifications to the library is permitted by this license.

The app supports mapper 0 (NROM) and mapper 4 (MMC3), including simple NES 2.0
headers without extended bank counts/submappers. ROMs are read from SD through
a bounded callback. No game is linked into the device firmware. See
[SD installation and controls](../../../../docs/NES.md).

A scratch scanline and two 15 KiB capture blocks (256x120 pixels) replace a large contiguous
framebuffer. All PPU scanlines still execute. A cache holds at most ten
8 KiB PRG banks and pins currently mapped CPU windows. CHR has an 8 KiB window.
Small cartridges allocate fewer banks. The allocator has a 144 KiB ceiling;
all allocations and the SD file are released on exit or failed initialization.
There are no XIP partitions, flash-ROM caches, or OTA layout changes.

## Local changes on 2026-10-17

- `s1_nes.c/h`: checked immutable ROM loader, one-owner lifecycle, bounded
  allocator, controller and palette adapter; SD bank cache and checked reads.
- `nes.c`: expose one frame per call and release handler tables on destruction.
- `bitmap.c/h`: correct pitch/overdraw allocation, 64-bit-safe alignment and
  allocation-failure cleanup; scanline scratch and captured viewport. Keep the flexible line-pointer array last.
- `nes_ppu.c`: preserve separately allocated nametable pointers across context
  copies, release nested allocations, use unsigned background pixel expansion.
- `nes_apu.c`: small static lookup tables, checked rectangle allocation and
  cleanup. Existing realtime noise generation avoids a large static noise LUT.
- `nesinput.c`: reset registration on exit and bound serial pad reads.
- `nes_pal.c`: fixed palette storage instead of an unreleased allocation.
- `nes6502.c`: byte-safe word reads and correct zero-page wrapping.

Only the source list in `library.json` is compiled. The original desktop GUI,
infinite emulator loop, filesystem loader, XIP partitions and unused mappers
are not part of the device app.

From repository root:

```sh
python3 scripts/test_nes.py
python3 scripts/cardputer.py build
```

The host test runs the actual CPU/PPU/APU and bundled ROM with AddressSanitizer
and UndefinedBehaviorSanitizer, checks the game's state and paddle movement,
repeated entry/exit, streaming mapper banks/cache reuse, read failures and
initialization allocation failures. `scripts/test_nes_rom.py` also tests a
user-provided ROM with sanitizers without adding it to the repository. Physical
installation, timing and heap measurements are recorded separately.
