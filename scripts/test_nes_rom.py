#!/usr/bin/env python3
"""Exercise a user-provided ROM through the actual streaming NES core."""
import argparse,json,os,pathlib,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('rom',type=pathlib.Path)
parser.add_argument('--output',type=pathlib.Path)
args=parser.parse_args()
out=args.output or pathlib.Path(tempfile.mkdtemp(prefix='s1-nes-rom-'))
out.mkdir(parents=True,exist_ok=True)
lib=root/'bots/CardputerADV/lib/s1_nes'
sources=[s[2:-1] for s in json.loads((lib/'library.json').read_text())['build']['srcFilter'] if s.startswith('+<')]
link=['-Wl,-dead_strip'] if sys.platform=='darwin' else ['-Wl,--gc-sections']
subprocess.run([os.environ.get('CC','cc'),'-std=gnu11','-O1','-g','-fsanitize=address,undefined',
 '-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections','-I'+str(lib/'src'),
 *[str(lib/'src'/s) for s in sources],str(root/'bots/CardputerADV/tests/nes_rom_smoke.c'),
 '-lm',*link,'-o',str(out/'nes-rom-smoke')],check=True)
env=os.environ.copy();env['UBSAN_OPTIONS']='halt_on_error=1'
subprocess.run([str(out/'nes-rom-smoke'),str(args.rom.resolve()),str(out/'game.ppm')],env=env,check=True)
