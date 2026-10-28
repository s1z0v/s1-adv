// VLC remote controls the Mac; no local audio/SD ownership and no autoplay.
namespace {
vlc_remote::Config gVlcConfig;
bool gVlcLoaded=false,gVlcConnectPending=false,gVlcModePending=false;
UiMode gVlcNextMode=UiMode::Home;
uint32_t gVlcLastPollMs=0;
String gVlcNotice;

bool vlcBusy(){return vlc_remote::busy();}
void vlcInvalidate(){gLastRenderMs=0;gUiFramePolicy.invalidate();}
void loadVlcSettings() {
  if(gVlcLoaded)return;
  gVlcLoaded=true;gVlcConfig=vlc_remote::defaults();
  // Old device NVS has no VLC namespace/marker. It must not mask provisioned
  // defaults with empty legacy values or a general device "configured" flag.
  if(!gPrefs.begin("vlc_remote",true))return;
  if(gPrefs.getBool("configured",false)) {
    vlc_remote::Config saved;
    snprintf(saved.host,sizeof(saved.host),"%s",gPrefs.getString("host","").c_str());
    snprintf(saved.fallback,sizeof(saved.fallback),"%s",gPrefs.getString("fallback","").c_str());
    snprintf(saved.password,sizeof(saved.password),"%s",gPrefs.getString("password","").c_str());
    saved.port=gPrefs.getUShort("port",8080);
    if(vlc_remote::configured(saved))gVlcConfig=saved;
  }
  gPrefs.end(); // No writes: private defaults need not be copied into NVS.
}
bool vlcStartAllowed() {
  return gWifiReady && gCanvasSpriteActive && !gBootBackgroundActive && !radioBusy() &&
    !gRecording && !gSubmitting && !gThinking && !gPlaybackActive && !gTransferUiActive &&
    !gOtaApplyInProgress && !gInboxHttpBusy && !gVoiceDialBusy && !gVoiceReplySpeechBusy &&
    gQueuedVoiceReplySpeech.isEmpty() && !gRealtimeActive && !gRealtimeDialBusy &&
    !gRealtimeExclusiveMode && !gPendingRealtimeStart && !gMeshBusOwned &&
    !gTextTurnTaskHandle && !gCompletedTextTurn && gPendingTextTurns.empty() &&
    gActiveTextTurn.isEmpty() && !gG0VoicePending && !gVoiceCapturePreparing;
}
void beginVlcRemote() {
  loadVlcSettings();gVlcConnectPending=true;gVlcNotice="Searching Mac...";vlcInvalidate();
}
bool deferVlcRemoteMode(UiMode mode) {
  if(mode==UiMode::VlcRemote)return false;
  gVlcConnectPending=false;
  if(!vlcBusy())return false;
  vlc_remote::cancel();gVlcModePending=true;gVlcNextMode=mode;
  gVlcNotice="Closing connection...";vlcInvalidate();return true;
}
void vlcRequest(vlc_remote::Command command,bool discover=false) {
  if(vlcBusy()){gVlcNotice="Busy; key not queued";vlcInvalidate();return;}
  if(!vlcStartAllowed()){gVlcNotice=!gWifiReady?"Wi-Fi required":"Busy; R retry";vlcInvalidate();return;}
  if(vlc_remote::start(gVlcConfig,command,discover))gVlcNotice=discover?"Searching Mac...":"Requesting...";
  else gVlcNotice=vlc_remote::message(vlc_remote::snapshot().error);
  gVlcLastPollMs=millis();vlcInvalidate();
}
void serviceVlcRemote() {
  static uint32_t seen=0;
  if(gVlcModePending && !vlcBusy()) {
    gVlcModePending=false;setUiMode(gVlcNextMode);return;
  }
  if(gUiMode!=UiMode::VlcRemote) {gVlcConnectPending=false;return;}
  auto state=vlc_remote::snapshot();
  if(state.revision!=seen){seen=state.revision;gVlcNotice=vlc_remote::message(state.error);vlcInvalidate();}
  if(gLauncherVisible || gVlcModePending)return;
  if(gVlcConnectPending && !vlcBusy()) {
    if(!vlcStartAllowed()){gVlcNotice=!gWifiReady?"Wi-Fi required":"Waiting for network...";return;}
    gVlcConnectPending=false;vlcRequest(vlc_remote::Command::Status,true);
  } else if(!vlcBusy() && state.connected && millis()-gVlcLastPollMs>=3000 && vlcStartAllowed()) {
    vlcRequest(vlc_remote::Command::Status); // Read-only; commands are never retried.
  }
}
bool handleVlcRemoteKey(char key,const Keyboard_Class::KeysState& keys) {
  if(keys.ctrl || keys.alt || keys.opt)return true;
  char lower=static_cast<char>(tolower(static_cast<unsigned char>(key)));
  using vlc_remote::Command;
  if(lower=='r'){vlcRequest(Command::Status,true);return true;}
  const auto state=vlc_remote::snapshot();
  if(!state.connected){gVlcNotice="R: find Mac / connect";vlcInvalidate();return true;}
  if(keys.enter || key=='\r' || key=='\n' || key==' ')vlcRequest(Command::Toggle);
  else if(lower=='x')vlcRequest(Command::Stop);
  else if(lower=='n')vlcRequest(Command::Next);
  else if(lower=='p')vlcRequest(Command::Previous);
  else if(lower=='w' || key=='+' || key=='=' || key==';')vlcRequest(Command::VolumeUp);
  else if(lower=='s' || key=='-' || key=='_' || key=='.')vlcRequest(Command::VolumeDown);
  else if(lower=='a' || key==',')vlcRequest(Command::Back);
  else if(lower=='d' || key=='/')vlcRequest(Command::Forward);
  return true;
}
String vlcTime(int seconds) {
  char text[24];snprintf(text,sizeof(text),"%d:%02d",seconds/60,seconds%60);return text;
}
void renderVlcRemoteUi() {
  auto& d=gCanvas;const auto state=vlc_remote::snapshot();
  const uint16_t bg=rgb565_local(2,7,10),panel=rgb565_local(3,21,38);
  const uint16_t cyan=rgb565_local(47,227,255),white=rgb565_local(244,251,255);
  const uint16_t muted=rgb565_local(134,167,184),green=rgb565_local(88,240,141),amber=rgb565_local(255,136,64);
  d.fillScreen(bg);d.drawRoundRect(0,0,240,135,6,rgb565_local(24,90,118));
  d.fillRoundRect(5,5,230,24,6,panel);
  d.setFont(&fonts::Font2);d.setTextColor(cyan,panel);d.setCursor(11,7);d.print("VLC REMOTE");
  d.setFont(&fonts::Font0);d.setTextColor(state.connected?green:amber,panel);d.setCursor(174,14);d.print(state.connected?"MAC / LAN":"OFFLINE");
  d.setTextColor(white,bg);d.setCursor(10,35);d.print(fitCurrentFontToWidth(state.connected?String(state.title):String("Open VLC on your Mac"),220));
  d.setTextColor(muted,bg);d.setCursor(10,48);
  d.print(fitCurrentFontToWidth(String(state.connected?state.playback:"stopped")+"  "+vlcTime(state.seconds)+" / "+vlcTime(state.length),220));
  d.fillRoundRect(10,61,220,4,2,panel);
  int bar=state.length>0?int(std::min<int64_t>(220,int64_t(state.seconds)*220/state.length)):0;
  if(bar>0)d.fillRect(10,61,bar,4,cyan);
  d.setTextColor(muted,bg);d.setCursor(10,74);
  d.print(fitCurrentFontToWidth(String("VOL ")+String((state.volume*100+128)/256)+"%  "+state.route,220));
  d.setTextColor(state.connected?green:amber,bg);d.setCursor(10,88);d.print(fitCurrentFontToWidth(gVlcNotice,220));
  d.setTextColor(muted,bg);d.setCursor(10,103);d.print("Enter play/pause X stop N/P track");
  d.setCursor(10,114);d.print("W/S vol A/D seek 10s R connect");
  d.setCursor(10,125);d.print("Esc back  Tab menu  Audio on Mac");
  renderLauncherOverlay();renderDebugOverlay();
}
} // namespace
