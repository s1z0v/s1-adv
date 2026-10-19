

void renderModeFooter(const String& left, const String& right = "") {
  auto& d = gCanvas;
  d.fillRect(0, 123, 240, 12, 0x18C3);
  d.setFont(&fonts::Font0);
  d.setTextColor(TFT_LIGHTGREY, 0x18C3);
  d.setCursor(4, 124);
  d.print(fitCurrentFontToWidth(left, right.isEmpty() ? 230 : 132));
  if (!right.isEmpty()) {
    int rightWidth = d.textWidth(right);
    d.setCursor(max<int>(4, 236 - rightWidth), 124);
    d.print(fitCurrentFontToWidth(right, 96));
  }
  d.setFont(&fonts::Font2);
}

void renderFaceOnlyUi() {
  if (gRealtimeScreenVisible) renderRealtimeUi();
  else renderUncannyEyesUi();
  if (!gScreensaverActive && !gRealtimeScreenVisible) {
    uint16_t bg=rgb565_local(3,7,13);
    gCanvas.fillRect(0,125,240,10,bg);
    gCanvas.setFont(&fonts::Font0);
    gCanvas.setTextColor(gRealtimeActive?rgb565_local(100,255,170):rgb565_local(126,143,157),bg);
    gCanvas.setCursor(8,128);
    gCanvas.print(gRealtimeActive?"LIVE   Tab menu  Esc end":"Tab menu  Ctrl+K commands");
  }
  if (!gRealtimeScreenVisible || !gRealtimeClassicView) {
    renderLauncherOverlay();
    renderDebugOverlay();
  }
}

void drawPetStatBar(int16_t x, int16_t y, int16_t w, const char* label, uint8_t value, uint16_t color, uint16_t bg) {
  auto& d = gCanvas;
  d.setFont(&fonts::Font0);
  d.setTextColor(rgb565_local(150, 164, 176), bg);
  d.setCursor(x, y);
  d.print(label);
  int16_t barX = x + 22;
  int16_t barW = max<int16_t>(20, w - 24);
  d.fillRoundRect(barX, y + 1, barW, 6, 3, rgb565_local(20, 32, 43));
  int16_t fillW = max<int16_t>(2, (barW * value) / 100);
  d.fillRoundRect(barX, y + 1, fillW, 6, 3, color);
}

void renderHeroUi() {
  auto& d = gCanvas;
  const uint16_t bg = rgb565_local(2, 6, 12);
  const uint16_t panel = rgb565_local(7, 14, 24);
  const uint16_t panel2 = rgb565_local(9, 20, 31);
  const uint16_t grid = rgb565_local(13, 32, 45);
  const uint16_t muted = rgb565_local(132, 148, 160);
  const uint16_t accent = petMoodAccent();
  d.fillScreen(bg);

  d.fillRoundRect(6, 5, 228, 124, 14, panel);
  d.drawRoundRect(6, 5, 228, 124, 14, accent);
  d.drawRoundRect(10, 9, 220, 116, 11, rgb565_local(18, 34, 48));

  d.setFont(&fonts::Font2);
  d.setTextColor(accent, panel);
  d.setCursor(16, 14);
  d.print("AI PET");
  String stage = petStageName(gPet.stage);
  d.setTextColor(TFT_WHITE, panel);
  d.setCursor(222 - d.textWidth(stage), 14);
  d.print(stage);

  int16_t arenaX = 15;
  int16_t arenaY = 29;
  int16_t arenaW = 116;
  int16_t arenaH = 82;
  d.fillRoundRect(arenaX, arenaY, arenaW, arenaH, 10, panel2);
  d.drawRoundRect(arenaX, arenaY, arenaW, arenaH, 10, rgb565_local(30, 52, 68));
  for (int16_t gx = arenaX + 10; gx < arenaX + arenaW - 8; gx += 22) {
    d.drawFastVLine(gx, arenaY + 8, arenaH - 16, grid);
  }
  for (int16_t gy = arenaY + 12; gy < arenaY + arenaH - 8; gy += 16) {
    d.drawFastHLine(arenaX + 8, gy, arenaW - 16, grid);
  }

  int16_t petX = arenaX + arenaW / 2 + static_cast<int16_t>(gEyeLookX / 5.5f);
  int16_t petY = arenaY + 45 + static_cast<int16_t>(gEyeLookY / 7.0f);
  drawProceduralOpenClawPet(petX, petY, gPet.stage == PetStage::Egg ? 38 : 42, false);

  int16_t statX = 139;
  int16_t statY = 32;
  int16_t statW = 87;
  d.fillRoundRect(statX - 4, statY - 4, 91, 79, 9, rgb565_local(4, 11, 19));
  d.drawRoundRect(statX - 4, statY - 4, 91, 79, 9, rgb565_local(24, 42, 56));
  drawPetStatBar(statX, statY, statW, "HUN", gPet.hunger, rgb565_local(255,136,64), rgb565_local(4, 11, 19));
  drawPetStatBar(statX, statY + 11, statW, "FUN", gPet.happiness, rgb565_local(88, 240, 141), rgb565_local(4, 11, 19));
  drawPetStatBar(statX, statY + 22, statW, "HP", gPet.health, rgb565_local(128, 230, 104), rgb565_local(4, 11, 19));
  drawPetStatBar(statX, statY + 33, statW, "EN", gPet.energy, rgb565_local(47, 227, 255), rgb565_local(4, 11, 19));
  drawPetStatBar(statX, statY + 44, statW, "CLN", gPet.cleanliness, rgb565_local(34, 209, 189), rgb565_local(4, 11, 19));
  drawPetStatBar(statX, statY + 55, statW, "DSC", gPet.discipline, rgb565_local(170, 130, 255), rgb565_local(4, 11, 19));

  d.setFont(&fonts::Font0);
  d.setTextColor(muted, panel);
  d.setCursor(18, 114);
  String bottom = String(petMoodName(gPet.mood)) + " " + petActivityName(gPet.activity) +
                  "  age " + petAgeText();
  d.print(fitCurrentFontToWidth(bottom, 130));
  d.setCursor(152, 114);
  String meta = String("poop ") + String(gPet.poop) + " wifi " + String(gPet.env.netCount);
  d.print(fitCurrentFontToWidth(meta, 72));

  drawTinyFooter(panel, muted, "F food P play C clean S sleep H hunt", 14, 123, 212);

  renderLauncherOverlay();
  renderDebugOverlay();
}

void drawAssistantPulseArc(int16_t cx, int16_t cy, int16_t outerR, int16_t innerR,
                           float startRad, float endRad, uint16_t color) {
  float startDeg = fmodf(startRad * 180.0f / kPi, 360.0f);
  float endDeg = fmodf(endRad * 180.0f / kPi, 360.0f);
  if (startDeg < 0) startDeg += 360;
  if (endDeg < 0) endDeg += 360;
  // Fill the band: outline-only arcs left the round caps looking detached.
  gCanvas.fillArc(cx, cy, outerR, innerR, startDeg, endDeg, color);
  int16_t capR = max<int16_t>(1, (outerR - innerR - 1) / 2);
  float midR = (outerR + innerR) * 0.5f;
  float start = startDeg * kPi / 180.0f;
  float end = endDeg * kPi / 180.0f;
  gCanvas.fillCircle(cx + static_cast<int16_t>(lroundf(cosf(start) * midR)),
                     cy + static_cast<int16_t>(lroundf(sinf(start) * midR)), capR, color);
  gCanvas.fillCircle(cx + static_cast<int16_t>(lroundf(cosf(end) * midR)),
                     cy + static_cast<int16_t>(lroundf(sinf(end) * midR)), capR, color);
}

void drawAssistantThinkingOrbit(int16_t cx, int16_t cy, float spin, uint16_t c1, uint16_t c2) {
  for (int i = 0; i < 4; ++i) {
    float a = spin * 1.9f + i * (kPi * 0.5f);
    drawAssistantPulseArc(cx, cy, 22, 16, a, a + 0.72f, (i % 2) ? c2 : c1);
  }
  // Both dots follow the same circular centerline as the 23..31 px ring.
  // Their fixed phase offsets stay inside its moving arc rather than drifting
  // along independent ellipses into the gaps between rings.
  const float orbit = 0.58f - spin * 1.08f;
  for (int i = 0; i < 2; ++i) {
    const float a = fmodf(orbit + (i == 0 ? 0.6f : 2.7f), 2.0f * kPi);
    gCanvas.fillCircle(cx + static_cast<int16_t>(lroundf(cosf(a) * 27.0f)),
                       cy + static_cast<int16_t>(lroundf(sinf(a) * 27.0f)),
                       3, i == 0 ? c1 : c2);
  }
}

void drawAssistantPulseButton(int16_t x, int16_t y, int16_t w, int16_t h,
                              const char* label, uint16_t accent, bool pressed) {
  auto& d = gCanvas;
  int16_t py = y + (pressed ? 1 : 0);
  uint16_t fill = pressed ? rgb565_local(16, 34, 42) : rgb565_local(7, 20, 26);
  d.fillRoundRect(x, py, w, h, 5, fill);
  d.drawRoundRect(x, py, w, h, 5, accent);
  if (pressed) {
    d.drawFastHLine(x + 8, py + 4, w - 16, rgb565_local(170, 200, 210));
  }
  if (strlen(label) > 8) d.setFont(&fonts::Font0);
  else d.setFont(&fonts::Font2);
  d.setTextColor(accent, fill);
  int tw = d.textWidth(label);
  d.setCursor(x + (w - tw) / 2, py + (h - d.fontHeight()) / 2);
  d.print(label);
}

void drawHomeReadyStatus(bool updateReady, bool pressed) {
  auto& d = gCanvas;
  const char* label = homeStatusLabel(updateReady);
  const bool voicePriority = gG0VoicePending || gVoiceCapturePreparing || voiceRequestBusyUi();
  const bool focus = !voicePriority && gFocus.state == FocusState::Focus;
  const bool rest = !voicePriority && (gFocus.state == FocusState::ShortBreak ||
      gFocus.state == FocusState::LongBreak || gFocus.state == FocusState::Reflect);
  char remaining[12] = {};
  if (focus) {
    snprintf(remaining,sizeof(remaining),"%02u:%02u",unsigned(gFocus.remainingSec/60),unsigned(gFocus.remainingSec%60));
    label=remaining;
  } else if (rest) label="BREAK";
  const bool ready = strcmp(label, "READY") == 0;
  const bool linkWait = strcmp(label, "CHECK LINK") == 0;
  const bool smallText = strlen(label) > 8;
  const int y = 103 + (pressed ? 1 : 0);
  const bool wide = strlen(label) > 7;
  const int x = wide ? 148 : 154, w = wide ? 74 : 62;
  const uint16_t warmOrange = rgb565_local(255,136,64);
  const uint16_t fill = ready ? rgb565_local(7,20,26) :
      rest ? rgb565_local(7,24,19) : rgb565_local(28,15,12);
  const uint16_t accent = rest ? rgb565_local(88,240,141) :
      ready ? rgb565_local(47,227,255) : warmOrange;
  d.fillRoundRect(x,y,w,18,5,fill);
  d.drawRoundRect(x,y,w,18,5,accent);
  d.setTextSize(1);
  d.setTextColor(accent,fill);
  if (linkWait) {
    d.setFont(&fonts::Font0);
    d.setCursor(x+(w-d.textWidth(label))/2,y+1);d.print(label);
    const char* hint = "F retry";
    d.setCursor(x+(w-d.textWidth(hint))/2,y+9);d.print(hint);
  } else {
    if (smallText) d.setFont(&fonts::Font0);
    else d.setFont(&fonts::Font2);
    d.setCursor(x+(w-d.textWidth(label))/2,y+(smallText ? 5 : 1));d.print(label);
  }
  d.setFont(&fonts::Font2);
}

void drawHomeBatteryStatus(int32_t rawLevel) {
  auto& d=gCanvas;
  const bool known=rawLevel>=0;
  const int level=known ? min<int32_t>(100,rawLevel) : 0;
  const uint16_t accent=known && level<=15 ? rgb565_local(255,63,85) :
      known && level<=30 ? rgb565_local(255,136,64) : rgb565_local(47,227,255);
  const uint16_t dim=rgb565_local(23,48,59),edge=rgb565_local(28,65,77);
  d.drawRoundRect(154,125,34,6,1,edge);
  d.fillRect(188,127,2,2,edge);
  // Five broad diagonal strokes stay inside the original compact outline.
  constexpr int strokes=5;
  const int lit=known ? (level*strokes+99)/100 : 0;
  for(int i=0;i<strokes;++i) {
    for(int row=0;row<4;++row)
      d.drawFastHLine(156+i*6+(3-row)*2/3,126+row,4,i<lit ? accent : dim);
  }
  char percent[5];
  if(known) snprintf(percent,sizeof(percent),"%d%%",level);
  else snprintf(percent,sizeof(percent),"--%%");
  d.setFont(&fonts::Font0);d.setTextSize(1);
  d.setTextColor(known ? accent : rgb565_local(130,145,155),rgb565_local(2,7,10));
  d.setCursor(193,124);d.print(percent);
  d.setFont(&fonts::Font2);
}

void renderAssistantPulseChatHint() {
  const bool hasInput = !gInputBuffer.isEmpty();
  const bool preparing = gG0VoicePending || gVoiceCapturePreparing;
  AssistantPulseState state = assistantPulseState();
  if (state == AssistantPulseState::Recording) return;
  const bool processing = state == AssistantPulseState::Thinking;
  if (!hasInput && !processing && state != AssistantPulseState::Ready && state != AssistantPulseState::Realtime) {
    return;
  }
  auto& d = gCanvas;
  const bool realtime = state == AssistantPulseState::Realtime;
  const uint16_t bg = realtime ? rgb565_local(19, 11, 4) : rgb565_local(6, 16, 22);
  const uint16_t edge = hasInput ? (realtime ? rgb565_local(255, 159, 42) : rgb565_local(47, 227, 255))
                                 : (realtime ? rgb565_local(96, 54, 18) : rgb565_local(42, 78, 88));
  const uint16_t text = hasInput ? rgb565_local(255,136,64)
                                 : (realtime ? rgb565_local(204, 151, 86) : rgb565_local(128, 145, 155));
  d.fillRoundRect(10, 107, 132, 19, 7, bg);
  d.drawRoundRect(10, 107, 132, 19, 7, edge);
  d.setFont(&fonts::efontCN_12);
  d.setTextColor(text, bg);
  d.setCursor(17, 112);
  if (preparing) {
    d.setFont(&fonts::Font0); d.setCursor(17,113); d.print("Loading voice...");
  }
  else if (processing)
    d.print(fitCurrentFontToWidth(gStatusText.isEmpty() ? String("Thinking...") : gStatusText, 116));
  else d.print(hasInput ? tailUtf8ToFit("> " + gInputBuffer, 116) : (realtime ? "> realtime" : "> type to chat"));
}



void renderAssistantPulseUi() {
  auto& d = gCanvas;
  ensureBangkokTimezone();
  AssistantPulseState state = assistantPulseState();
