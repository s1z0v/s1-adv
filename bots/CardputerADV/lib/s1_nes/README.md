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

The initial app supports **mapper 0 (NROM), iNES, 16/32 KiB PRG and 0/8 KiB CHR**.
It embeds HonkeyPong; it is not a general ROM browser. Trainers, battery saves,
NES2 and other mappers are rejected before core allocation.

## Local changes on 2026-10-17

- `s1_nes.c/h`: checked immutable ROM loader, one-owner lifecycle, bounded
  allocator, controller and palette adapter. ROM data stays in program flash.
- `nes.c`: expose one frame per call and release handler tables on destruction.
- `bitmap.c/h`: correct pitch/overdraw allocation, 64-bit-safe alignment and
  allocation-failure cleanup. Keep the flexible line-pointer array last.
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
repeated entry/exit and every initialization allocation failure. Hardware
timing, speaker output and actual device heap still need a physical test.
