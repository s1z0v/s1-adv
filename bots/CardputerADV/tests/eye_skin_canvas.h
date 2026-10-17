// Test-only canvas: clipped raster plus recorded ellipse geometry. Not linked on ESP.
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <string>
#include <vector>
using std::min;
using std::max;
using String = std::string;
constexpr uint16_t TFT_BLACK=0, TFT_WHITE=65535;
constexpr uint8_t kEyeSkinCount=6;
namespace fonts { int Font0, Font2; }
enum class FaceMode { Idle, Listening, Speaking, Thinking, Error };
enum class EyeEmotion { Neutral, Thinking, Sleepy, Happy, Surprised, Excited };
FaceMode gFaceMode=FaceMode::Idle;
EyeEmotion emotion=EyeEmotion::Neutral;
EyeEmotion currentEyeEmotion() { return emotion; }
uint32_t clockMs=1000, gBlinkEndMs=0;
uint32_t millis() { return clockMs; }
float gEyeLookX=0, gEyeLookY=0;
bool gScreensaverActive=false;
struct { uint8_t eyeSkin=0; bool screensaverClockOnWake=false; bool clockTwelveHour=true; } gDeviceSettings;
template<typename T> T clampValue(T x,T lo,T hi) { return max(lo,min(x,hi)); }
uint16_t rgb565_local(int r,int g,int b) { return ((r>>3)<<11)|((g>>2)<<5)|(b>>3); }
struct Ellipse { int x,y,rx,ry; uint16_t color; };
struct Canvas {
  uint16_t pixels[240*135]={};
  std::vector<Ellipse> ellipses;
  bool raster=false;
  int calls=0;
  int clipX=0,clipY=0,clipW=240,clipH=135;
  void setClipRect(int x,int y,int w,int h) {clipX=x;clipY=y;clipW=w;clipH=h;}
  void clearClipRect() {setClipRect(0,0,240,135);}
  void fillRect(int x,int y,int w,int h,uint16_t c) { ++calls; ellipses.clear(); for(int py=y;py<y+h;++py) for(int px=x;px<x+w;++px) pixel(px,py,c); }
  void pixel(int x,int y,uint16_t c) { if (raster && x>=0 && x<240 && y>=0 && y<135 && x>=clipX && x<clipX+clipW && y>=clipY && y<clipY+clipH) pixels[y*240+x]=c; }
  void fillScreen(uint16_t c) { ++calls; ellipses.clear(); if(raster) std::fill(pixels,pixels+240*135,c); }
  void fillEllipse(int x,int y,int rx,int ry,uint16_t c) {
    assert(rx>0 && ry>0 && rx<=240 && ry<=135); ++calls;
    ellipses.push_back({x,y,rx,ry,c});
    if(!raster) return;
    for(int dy=-ry;dy<=ry;++dy) {
      int w=static_cast<int>(std::floor(rx*std::sqrt(max(0.0,1.0-double(dy*dy)/double(ry*ry)))));
      for(int dx=-w;dx<=w;++dx) pixel(x+dx,y+dy,c);
    }
  }
  void fillCircle(int x,int y,int r,uint16_t c) { fillEllipse(x,y,r,r,c); }
  void drawLine(int x,int y,int x2,int y2,uint16_t c) {
    ++calls; if(!raster) return;
    int dx=std::abs(x2-x),sx=x<x2?1:-1,dy=-std::abs(y2-y),sy=y<y2?1:-1,err=dx+dy;
    for(;;) { pixel(x,y,c); if(x==x2 && y==y2)break; int e=2*err; if(e>=dy){err+=dy;x+=sx;} if(e<=dx){err+=dx;y+=sy;} }
  }
  void fillTriangle(int ax,int ay,int bx,int by,int cx,int cy,uint16_t c) {
    ++calls; if(!raster)return;
    auto cross=[](int x,int y,int x1,int y1,int x2,int y2){return (x-x1)*(y2-y1)-(y-y1)*(x2-x1);};
    for(int y=max(0,min(ay,min(by,cy)));y<=min(134,max(ay,max(by,cy)));++y)
      for(int x=max(0,min(ax,min(bx,cx)));x<=min(239,max(ax,max(bx,cx)));++x) {
        int a=cross(x,y,ax,ay,bx,by),b=cross(x,y,bx,by,cx,cy),d=cross(x,y,cx,cy,ax,ay);
        if((a>=0&&b>=0&&d>=0)||(a<=0&&b<=0&&d<=0))pixel(x,y,c);
      }
  }
  void drawRect(int x,int y,int w,int h,uint16_t c) {
    drawLine(x,y,x+w-1,y,c);drawLine(x,y+h-1,x+w-1,y+h-1,c);
    drawLine(x,y,x,y+h-1,c);drawLine(x+w-1,y,x+w-1,y+h-1,c);
  }
  // Text rasterization is outside this geometry driver; preview fonts separately.
  void fillRoundRect(int,int,int,int,int,uint16_t) { ++calls; }
  void drawRoundRect(int,int,int,int,int,uint16_t) { ++calls; }
  void setFont(int*) {}
  void setTextColor(uint16_t,uint16_t) {}
  void setCursor(int,int) {}
  int textWidth(const String& text) { return static_cast<int>(text.size()*6); }
  void print(const String&) {}
  void save(const std::string& file) {
    FILE* f=std::fopen(file.c_str(),"wb");assert(f);std::fprintf(f,"P6\n240 135\n255\n");
    for(uint16_t c:pixels) {
      // Match the firmware's existing 8-bit canvas quantization (RGB332).
      unsigned char rgb[]={static_cast<unsigned char>(((c>>13)&7)*255/7),
                           static_cast<unsigned char>(((c>>8)&7)*255/7),
                           static_cast<unsigned char>(((c>>3)&3)*255/3)};
      assert(std::fwrite(rgb,1,3,f)==3);
    }
    std::fclose(f);
  }
} gCanvas;

// ACTUAL_FIRMWARE_RENDERER

int main(int argc,char**argv) {
  assert(argc==2);
  // Prevent the neutral cat from becoming olive after RGB332 conversion.
  auto cat=eyeSkinPalette(1);
  int catR=((cat.face>>13)&7)*255/7,catG=((cat.face>>8)&7)*255/7,catB=((cat.face>>3)&3)*255/3;
  assert(max(catR,max(catG,catB))-min(catR,min(catG,catB))<=20);
  gBlinkEndMs=1120;
  assert(uncannyBlinkAmount(1000)==0 && uncannyBlinkAmount(1060)==255 && uncannyBlinkAmount(1120)==0);
  gBlinkEndMs=60; // millis wrap must preserve blink duration
  assert(uncannyBlinkAmount(UINT32_MAX-59)==0 && uncannyBlinkAmount(0)==255);
  gBlinkEndMs=0;
  for(int skin=0;skin<6;++skin) {
    gCanvas.raster=true;gDeviceSettings.eyeSkin=skin;renderUncannyEyesUi();
    gCanvas.save(std::string(argv[1])+"/skin-"+std::to_string(skin)+".ppm");gCanvas.raster=false;
  }
  for(int skin=0;skin<6;++skin) {
    gCanvas.raster=true;gDeviceSettings.eyeSkin=skin;
    gCanvas.fillScreen(rgb565_local(3,7,13));
    renderEyeSkinRegion(48,13,144,73);
    assert(gCanvas.pixels[0]==rgb565_local(3,7,13));
    assert(gCanvas.pixels[90*240+120]==rgb565_local(3,7,13));
    gCanvas.save(std::string(argv[1])+"/compact-"+std::to_string(skin)+".ppm");
    gCanvas.raster=false;
  }
  int cases=0;
  for(int e=0;e<6;++e)for(int f=0;f<5;++f)for(int blink=0;blink<256;++blink)for(int gaze=-1;gaze<=1;gaze+=2) {
    emotion=static_cast<EyeEmotion>(e);gFaceMode=static_cast<FaceMode>(f);
    gEyeLookX=gaze*100;gEyeLookY=gaze*100;gCanvas.ellipses.clear();gCanvas.calls=0;
    drawSmoothUncannyEye(62,67,clockMs,blink);
    if(!gCanvas.ellipses.empty()) {
      const auto& outer=gCanvas.ellipses[1];const auto& iris=gCanvas.ellipses[2];const auto& pupil=gCanvas.ellipses[3];
      assert(std::abs(iris.y-outer.y)+iris.ry<=outer.ry);
      assert(pupil.ry<=iris.ry && pupil.rx<=iris.rx);
      for(const auto& a:gCanvas.ellipses)assert(a.x-a.rx>=0 && a.x+a.rx<240 && a.y-a.ry>=0 && a.y+a.ry<135);
    }
    assert(gCanvas.calls<=7);++cases;
  }
  for(int skin=0;skin<6;++skin) {
    gCanvas.calls=0;gDeviceSettings.eyeSkin=skin;renderUncannyEyesUi();assert(gCanvas.calls<100);
  }
  std::printf("PASS %d actual eye geometry cases; six skins; bounded primitives; blink/wrap\n",cases);
}
