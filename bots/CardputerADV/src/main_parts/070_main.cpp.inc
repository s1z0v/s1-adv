// Internet radio: clock/Pulse palette and thin rings, separate streaming owner.
namespace {
radio_catalog::Selection gRadioSelection;
bool gRadioWantPlaying = false;
bool gRadioStartPending = false;
bool gRadioModePending = false;
UiMode gRadioNextMode = UiMode::Home;
String gRadioNotice;

bool radioBusy() { return internet_radio::busy(); }
void radioInvalidate() { gLastRenderMs = 0; gUiFramePolicy.invalidate(); }
void stopInternetRadio() {
  gRadioWantPlaying = false;
  gRadioStartPending = false;
  internet_radio::stop();
  radioInvalidate();
}
bool deferInternetRadioMode(UiMode mode) {
  if (!radioBusy() || mode == UiMode::Radio) return false;
  stopInternetRadio(); gRadioModePending = true; gRadioNextMode = mode;
  setStatus("Stopping radio...", 800);
  return true; // Do not reclaim the speaker/RAM before the worker exits.
}
void beginInternetRadio() { gRadioNotice = "Enter to listen"; radioInvalidate(); }
bool radioStartAllowed() {
  return gWifiReady && !gBootBackgroundActive && gCanvasSpriteActive && !gRecording &&
    !gSubmitting && !gThinking && !gPlaybackActive && !gTransferUiActive && !gOtaApplyInProgress &&
    !gInboxHttpBusy && !gVoiceDialBusy && !gVoiceReplySpeechBusy && gQueuedVoiceReplySpeech.isEmpty() &&
    !gRealtimeActive && !gRealtimeDialBusy && !gRealtimeExclusiveMode && !gPendingRealtimeStart &&
    !gMeshBusOwned && !gTextTurnTaskHandle && !gCompletedTextTurn && gPendingTextTurns.empty() &&
    gActiveTextTurn.isEmpty() && !gG0VoicePending && !gVoiceCapturePreparing &&
    !M5Cardputer.Speaker.isPlaying();
}
void serviceInternetRadio() {
  if (gRadioModePending && !radioBusy()) {
    gRadioModePending = false; const UiMode next = gRadioNextMode;
    setUiMode(next); return;
  }
  if (gUiMode != UiMode::Radio) {
    if (radioBusy()) stopInternetRadio();
    return;
  }
  if (gRadioStartPending && !radioBusy()) {
    gRadioStartPending = false;
    const auto* station = gRadioSelection.station();
    if (!station || !radioStartAllowed()) {
      gRadioWantPlaying = false;
      gRadioNotice = !gWifiReady ? "Wi-Fi required" : "Busy: retry Enter";
    } else {
      initSpeaker();
      if (!internet_radio::start(station->url)) {
        gRadioWantPlaying = false; gRadioNotice = internet_radio::status();
      } else { gRadioNotice = ""; }
    }
    radioInvalidate();
  } else if (!radioBusy() && gRadioWantPlaying && !gRadioStartPending) {
    gRadioWantPlaying = false; gRadioNotice = internet_radio::status(); radioInvalidate();
  }
}
void radioRetune() {
  gRadioNotice = "Enter to listen";
  if (gRadioWantPlaying) { internet_radio::stop(); gRadioStartPending = true; }
  radioInvalidate();
}
bool handleInternetRadioKey(char key, const Keyboard_Class::KeysState& keys) {
  if (keys.ctrl || keys.alt || keys.opt) return true;
  const char lower = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (lower == 'w' || key == ';') { gRadioSelection.moveGenre(-1); radioRetune(); }
  else if (lower == 's' || key == '.') { gRadioSelection.moveGenre(1); radioRetune(); }
  else if (lower == 'a' || key == ',') { gRadioSelection.moveStation(-1); radioRetune(); }
  else if (lower == 'd' || key == '/') { gRadioSelection.moveStation(1); radioRetune(); }
  else if (lower == 'l') { gRadioSelection.nextLanguage(); radioRetune(); }
  else if (key == '-' || key == '_') { adjustSpeakerVolume(-16); radioInvalidate(); }
  else if (key == '+' || key == '=') { adjustSpeakerVolume(16); radioInvalidate(); }
  else if (keys.enter || key == '\r' || key == '\n' || key == ' ') {
    if (gRadioWantPlaying || radioBusy()) { stopInternetRadio(); gRadioNotice = "Paused"; }
    else { gRadioWantPlaying = true; gRadioStartPending = true; gRadioNotice = "Starting..."; }
    radioInvalidate();
  }
  return true;
}
void renderInternetRadioUi() {
  auto& d = gCanvas;
  const uint16_t bg = rgb565_local(2,7,10), panel = rgb565_local(3,21,38);
  const uint16_t cyan = rgb565_local(47,227,255), violet = rgb565_local(157,102,255);
  const uint16_t white = rgb565_local(244,251,255), muted = rgb565_local(134,167,184);
  const uint16_t green = rgb565_local(88,240,141), amber = rgb565_local(255,136,64);
  const bool playing = internet_radio::state() == internet_radio::State::Playing;
  const uint16_t accent = playing ? green : cyan;
  d.fillScreen(bg);
  for (int y = 8; y < 132; y += 9) d.drawFastHLine(6,y,228,rgb565_local(4,16,31));
  d.drawRoundRect(0,0,240,135,6,rgb565_local(24,90,118));
  const float spin = radioBusy() ? millis()/1800.0f : 0.0f;
  d.drawCircle(56,58,44,rgb565_local(8,34,43));
  drawAssistantPulseArc(56,58,40,33,-2.25f+spin,1.0f+spin,accent);
  drawAssistantPulseArc(56,58,28,22,0.58f-spin,4.54f-spin,violet);
  // Ring motion indicates stream state, not a claimed audio spectrum.
  if (playing) {
    d.fillRect(49,49,5,18,white); d.fillRect(59,49,5,18,white);
  } else d.fillTriangle(51,48,51,68,66,58,white);
  d.setFont(&fonts::Font0); d.setTextColor(accent,bg); d.setCursor(29,105); d.print("NET RADIO");
  d.fillRoundRect(113,8,119,52,12,panel);
  d.drawRoundRect(113,8,119,52,12,rgb565_local(14,58,82));
  String hhmm = "--:--";
  const time_t now = time(nullptr);
  if (now > 100000) {
    struct tm ti; localtime_r(&now,&ti); char buf[6];
    clock_display::format(buf,sizeof(buf),ti.tm_hour,ti.tm_min,gDeviceSettings.clockTwelveHour);
    hhmm = buf;
  }
  d.setFont(&fonts::Font7); d.setTextColor(white,panel);
  d.setCursor(172-d.textWidth(hhmm)/2,10); d.print(hhmm);
  d.setFont(&fonts::Font0); d.setTextColor(cyan,bg); d.setCursor(115,61);
  d.print(fitCurrentFontToWidth(radio_catalog::kGenres[gRadioSelection.genre],114));
  const auto* station = gRadioSelection.station();
  d.setTextColor(white,bg); d.setCursor(115,72);
  d.print(fitCurrentFontToWidth(station ? station->name : "No stations",114));
  d.setTextColor(muted,bg); d.setCursor(115,83);
  d.print(String(gRadioSelection.index+1)+"/"+String(gRadioSelection.count(gRadioSelection.genre))+" "+
          (station ? radio_catalog::languageName(station->language) : "--")+" "+radio_catalog::languageName(gRadioSelection.language));
  d.setTextColor(radioBusy() ? green : amber,bg); d.setCursor(115,94);
  const String status = gRadioStartPending ? "Tuning..." : radioBusy() ? internet_radio::status() : gRadioNotice;
  d.print(fitCurrentFontToWidth(status,114));
  const int volume = (int(gSpeakerVolume)*100+127)/255;
  d.setTextColor(muted,bg); d.setCursor(115,105); d.print("VOL "+String(volume)+"%");
  for (int i = 0; i < 9; ++i) d.fillRect(172+i*6,105,4,7,i*255/9<int(gSpeakerVolume)?accent:rgb565_local(16,52,66));
  d.setTextColor(muted,bg); d.setCursor(8,116); d.print("W/S genre A/D tune Enter play/pause");
  d.setCursor(8,125); d.print("L EN/RU  +/- vol  Esc exit Tab menu");
  renderLauncherOverlay(); renderDebugOverlay();
}
} // namespace
