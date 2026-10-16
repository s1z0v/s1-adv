# HonkeyPong source provenance

Source: https://github.com/HonkeyKong/HonkeyPong

Commit: `f9ab7ad450ffebabec15623aa811a7564f079168`

Copyright 2015 Ryan Souders, MIT; see [LICENSE](LICENSE). Upstream identifies
BoxyBold and FamiTone as public domain; the original notices and readmes remain.

The S1-ADV copy changes the host tool variable `wait` to `frame_wait` in
`src/nsf2data.cpp`, avoiding a collision with the POSIX `wait()` function on
modern macOS. Game logic and assets are unchanged.

The ready ROM is `bin/HonkeyPong.nes`; firmware embeds the same bytes in
`bots/CardputerADV/src/honkeypong_rom.h`. Rebuild with `make`, a C++ compiler,
and `ophis-asm==2.2.0.post1`:

```sh
python3 -m pip install ophis-asm==2.2.0.post1
python3 scripts/build_nes_game.py
```
