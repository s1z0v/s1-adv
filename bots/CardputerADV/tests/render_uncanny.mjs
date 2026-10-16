import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const out=process.argv[2] || "/tmp/cardputer-145-release.JzTvGM/eyes";
mkdirSync(out,{recursive:true});
const src=readFileSync(path.join(root,"src/main_parts/050_main.cpp.inc"),"utf8");
const pixel=src.slice(src.indexOf("uint16_t uncannyEyePixel("),src.indexOf("void renderOneUncannyEye("));
const cpp=`#include <cstdint>\n#include <cstddef>\n#include <cstdio>\n#include <algorithm>\nusing std::min;\n#define PROGMEM\n#define TFT_BLACK 0\n#define pgm_read_byte(p) (*(p))\n#define pgm_read_word(p) (*(p))\n#include "${root}/src/main_parts/uncanny_default_eye.h"\n${pixel}\nint main(int argc,char**argv){FILE*f=fopen(argv[1],"wb");fprintf(f,"P6\\n240 135\\n255\\n");bool swap=argc>2;for(int y=0;y<135;y++)for(int x=0;x<240;x++){uint16_t c=0;if(y>=3&&y<131)c=uncannyEyePixel(x/120,x<120?x+8:x-120,y-3,x<120?32:40,36,110,128,126);if(swap)c=(c<<8)|(c>>8);unsigned char r=(c>>11)&31,g=(c>>5)&63,b=c&31;unsigned char rgb[3]={(unsigned char)((r>>2)*255/7),(unsigned char)((g>>3)*255/7),(unsigned char)((b>>3)*255/3)};fwrite(rgb,1,3,f);}fclose(f);}\n`;
writeFileSync(path.join(out,"render.cpp"),cpp);
execFileSync("c++",["-std=c++11","-O2",path.join(out,"render.cpp"),"-o",path.join(out,"render")]);
for(const state of ["before","after"]){
  execFileSync(path.join(out,"render"),[path.join(out,state+".ppm"),...(state==="before"?["swap"]:[])]);
  execFileSync("sips",["-s","format","png",path.join(out,state+".ppm"),"--out",path.join(out,state+".png")]);
}
console.log(`PASS native eye pixel render: ${out}`);
