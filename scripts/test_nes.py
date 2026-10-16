#!/usr/bin/env python3
"""Build and run the actual NES core and bundled game on the host with sanitizers."""
import json, os, pathlib, subprocess, sys, tempfile
root=pathlib.Path(__file__).resolve().parents[1]
lib=root/'bots/CardputerADV/lib/s1_nes'
sources=[s[2:-1] for s in json.loads((lib/'library.json').read_text())['build']['srcFilter'] if s.startswith('+<')]
out=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else pathlib.Path(tempfile.mkdtemp(prefix='s1-nes-'))
out.mkdir(parents=True,exist_ok=True)
flags=['-Wl,-dead_strip'] if sys.platform=='darwin' else ['-Wl,--gc-sections']
subprocess.run([os.environ.get('CC','cc'),'-std=gnu11','-O1','-g',
 '-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections',
 '-I'+str(lib/'src'), *[str(lib/'src'/s) for s in sources],
 str(root/'bots/CardputerADV/tests/nes_smoke.c'),'-lm',*flags,'-o',str(out/'nes-smoke')],check=True)
os.environ['UBSAN_OPTIONS']='halt_on_error=1'
subprocess.run([str(out/'nes-smoke'),str(out/'nes-title.ppm'),str(out/'nes-game.ppm')],check=True)
