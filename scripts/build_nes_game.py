#!/usr/bin/env python3
"""Rebuild the bundled MIT HonkeyPong ROM. Requires make, C++, ophis-asm==2.2.0.post1."""
from pathlib import Path
import hashlib, os, subprocess
root=Path(__file__).resolve().parents[1]
game=root/'third_party/honkeypong'
subprocess.run(['make','CXX='+os.environ.get('CXX','c++')],cwd=game,check=True)
rom=(game/'bin/HonkeyPong.nes').read_bytes()
assert len(rom)==24592 and rom[:6]==b'NES\x1a\x01\x01'
header='// HonkeyPong by Ryan Souders (2015), MIT. Rebuild: python3 scripts/build_nes_game.py\n#pragma once\n#include <stdint.h>\nstatic const uint8_t kHonkeyPongRom[] = {\n'
header+=''.join('  '+','.join('0x%02x'%v for v in rom[i:i+24])+',\n' for i in range(0,len(rom),24))+'};\n'
(root/'bots/CardputerADV/src/honkeypong_rom.h').write_text(header)
print('HonkeyPong',len(rom),'bytes; SHA256',hashlib.sha256(rom).hexdigest())
