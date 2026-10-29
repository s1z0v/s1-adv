// A quiet, offline screensaver and optional hands-on preview. No audio/SD/HTTP.
namespace {
chess_mind::Session gChessMind;
void beginChessMind(){gChessMind.begin(millis(),esp_random());}
bool handleChessMindKey(char key,const Keyboard_Class::KeysState& keys) {
  if(keys.ctrl||keys.alt||keys.opt||gScreensaverActive)return true;
  if(key==' '){gChessMind.advance(millis());gLastRenderMs=0;gUiFramePolicy.invalidate();}
  else if(keys.enter||key=='\r'||key=='\n'||key=='n'||key=='N') {
    gChessMind.next(millis());gLastRenderMs=0;gUiFramePolicy.invalidate();
  }
  return true;
}
void renderChessMindUi() {
  if(!gChessMind.started)beginChessMind();
  const uint32_t now=millis();gChessMind.tick(now);
  const auto& q=gChessMind.question;const bool answer=gChessMind.revealed;
  auto& d=gCanvas;
  const uint16_t bg=rgb565_local(2,7,10),panel=rgb565_local(3,16,25);
  const uint16_t cyan=rgb565_local(47,227,255),violet=rgb565_local(157,102,255);
  const uint16_t white=rgb565_local(235,247,251),muted=rgb565_local(125,159,177);
  const uint16_t amber=rgb565_local(255,163,95),green=rgb565_local(88,240,141);
  const uint16_t accent=answer?green:cyan;
  d.fillScreen(bg);d.setFont(&fonts::Font0);
  // Sparse low-contrast rain: a dark overlay impression, never bright Matrix
  // glyphs behind the question. No shared C-Matrix state or dynamic buffers.
  static const char symbols[]="abcdefgh12345678KNBRQ";
  for(int col=0;col<15;++col) {
    int y=int((now/220U+unsigned(col*17))%143U)-8;
    for(int trail=0;trail<3;++trail) {
      int row=y-trail*11;if(row<0||row+8>135)continue;
      d.setTextColor(rgb565_local(2,trail?19:31,trail?22:35),bg);
      d.setCursor(2+col*16,row);d.print(symbols[(now/600U+unsigned(col*7+trail))%(sizeof(symbols)-1)]);
    }
  }
  d.fillRoundRect(5,4,230,23,5,panel);d.setFont(&fonts::Font2);
  d.setTextColor(cyan,panel);d.setCursor(10,6);d.print("CHESS MIND");
  String hhmm="--:--";time_t stamp=time(nullptr);
  if(stamp>100000) {
    struct tm ti;localtime_r(&stamp,&ti);char text[12];
    clock_display::format(text,sizeof(text),ti.tm_hour,ti.tm_min,gDeviceSettings.clockTwelveHour,true);hhmm=text;
  }
  d.setTextColor(white,panel);d.setCursor(230-d.textWidth(hhmm),6);d.print(hhmm);
  d.setFont(&fonts::Font0);d.setTextColor(answer?green:violet,panel);d.setCursor(103,11);d.print(answer?"ANSWER":"QUIZ");
  constexpr int bx=11,by=32,cell=11;
  const bool labels=q.kind!=chess_mind::Kind::Square||answer;
  for(int s=0;s<64;++s) {
    int f=s%8,r=s/8,x=bx+f*cell,y=by+(7-r)*cell;
    const uint16_t square=chess_mind::light(uint8_t(s))?rgb565_local(43,59,70):rgb565_local(8,22,31);
    d.fillRect(x,y,cell,cell,square);
    bool target=false,source=false;
    if(q.kind==chess_mind::Kind::Square)target=s==q.to;
    else if(q.kind==chess_mind::Kind::Color)target=answer&&s==q.to;
    else if(q.kind==chess_mind::Kind::Reach){target=s==q.to;source=s==q.from;}
    else if(q.kind==chess_mind::Kind::Reverse)target=s==q.to;
    else if(answer){target=s==q.to;source=s==q.from;}
    uint16_t edge=answer&&q.kind==chess_mind::Kind::Reach&&!q.yes?amber:accent;
    if(target||source)d.drawRect(x,y,cell,cell,target?edge:violet);
    const int p=q.board[s];
    if(p) {
      static const char pieces[]=" PNBRQK";
      d.setTextColor(p>0?white:amber,square);d.setCursor(x+3,y+2);d.print(pieces[chess_demo::absPiece(p)]);
      // A small side marker supplements colour, even on a tiny board.
      d.fillRect(x+1,p>0?y+1:y+9,1,1,p>0?cyan:amber);
    } else if(target) d.fillCircle(x+5,y+5,2,edge);
  }
  if(labels) {
    d.setTextColor(muted,bg);
    for(int f=0;f<8;++f){d.setCursor(bx+f*cell+3,123);d.print(char('a'+f));}
    for(int r=0;r<8;++r){d.setCursor(2,by+(7-r)*cell+2);d.print(char('1'+r));}
  } else {
    d.setTextColor(muted,bg);d.setCursor(14,123);d.print("White at bottom");
  }
  d.fillRoundRect(106,31,129,102,5,panel);
  d.setTextColor(violet,panel);d.setCursor(112,35);d.print(fitCurrentFontToWidth(q.tag,118));
  d.setTextColor(white,panel);d.setCursor(112,49);d.print(fitCurrentFontToWidth(q.line1,118));
  d.setTextColor(muted,panel);d.setCursor(112,61);d.print(fitCurrentFontToWidth(q.line2,118));
  if(q.kind==chess_mind::Kind::Reverse) {
    char a[3],b[3],c[3],options[24];
    chess_mind::name(q.options[0],a);chess_mind::name(q.options[1],b);chess_mind::name(q.options[2],c);
    snprintf(options,sizeof(options),"A %s  B %s  C %s",a,b,c);
    d.setTextColor(white,panel);d.setCursor(112,75);d.print(fitCurrentFontToWidth(options,118));
  } else {
    d.setTextColor(muted,panel);d.setCursor(112,75);
    d.print(q.kind==chess_mind::Kind::Mate?"W light / B amber":gScreensaverActive?"Think, then reveal":"Space answer/next");
  }
  char count[24];snprintf(count,sizeof(count),"%s %lus",answer?"Next in":"Answer in",static_cast<unsigned long>(gChessMind.remaining(now)));
  d.setTextColor(muted,panel);d.setCursor(112,88);d.print(count);
  if(answer) {
    d.setFont(&fonts::Font2);d.setTextColor(green,panel);d.setCursor(112,99);d.print(fitCurrentFontToWidth(q.answer,118));
    d.setFont(&fonts::Font0);d.setTextColor(muted,panel);d.setCursor(112,117);d.print(fitCurrentFontToWidth(q.hint,118));
  } else {
    d.setTextColor(cyan,panel);d.setCursor(112,105);d.print("Solve in your head");
    d.setTextColor(muted,panel);d.setCursor(112,117);d.print(gScreensaverActive?"Any key wakes":"Enter next Esc back");
  }
  renderLauncherOverlay();renderDebugOverlay();
}
} // namespace
