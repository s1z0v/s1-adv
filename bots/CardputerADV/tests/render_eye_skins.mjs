// Host raster/geometry check of the actual firmware primitives (not the HTML mock).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || mkdtempSync(path.join(os.tmpdir(), 'cardputer-eye-skins-'));
mkdirSync(out, {recursive:true});
const source = readFileSync(path.join(root, 'src/main_parts/050_main.cpp.inc'), 'utf8');
const prefix = source.slice(0, source.indexOf('void renderOmniEyePair('));
if (!prefix.includes('drawSmoothUncannyEye')) throw Error('Missing actual renderer');
const harness = readFileSync(path.join(root, 'tests/eye_skin_canvas.h'), 'utf8');
const cpp = harness.replace('// ACTUAL_FIRMWARE_RENDERER', prefix);
writeFileSync(path.join(out, 'render.cpp'), cpp);
execFileSync('c++', ['-std=c++11', '-O2', '-Wall', '-Wextra', path.join(out, 'render.cpp'), '-o', path.join(out, 'render')], {stdio:'inherit'});
execFileSync(path.join(out, 'render'), [out], {stdio:'inherit'});
if (process.platform === 'darwin') {
  for (let i = 0; i < 6; i++) {
    execFileSync('sips', ['-s','format','png',path.join(out, `skin-${i}.ppm`),'--out',path.join(out, `skin-${i}.png`)], {stdio:'ignore'});
  }
}
console.log(`PASS actual firmware eye render, native RGB332 previews: ${out}`);
