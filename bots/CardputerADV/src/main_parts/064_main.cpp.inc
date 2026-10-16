extern "C" {
#include <s1_nes.h>
}
#include "../honkeypong_rom.h"

namespace {
constexpr uint8_t kNesAudioChannel=0;
// S1-ADV 0.2.148: shared assistant navigation and a bounded NES app.
bool isAssistantUi() {
  return gUiMode == UiMode::Home || gUiMode == UiMode::ChatFace ||
         gUiMode == UiMode::ChatFull || gUiMode == UiMode::Face || gUiMode == UiMode::Hero;
}

void servicePendingRealtimeStart() {
  if (!gPendingRealtimeStart || gInboxHttpBusy || gTextTurnTaskHandle || gCompletedTextTurn ||
      gSubmitting || !gPendingTextTurns.empty()) return;
  gPendingRealtimeStart = false;
  if (isAssistantUi()) startRealtimeSession(gPendingRealtimeAutoStart);
}

void runChatCommand(uint8_t index) {
  gChatCommandsVisible = false;
  gLauncherVisible = false;
  if (index == 0) { toggleRealtimeVoice(); return; }
  if (index <= 3) {
    if (gRealtimeActive || gRealtimeExclusiveMode) closeRealtimeSession("chat view");
    gPendingRealtimeStart = false;
    setUiMode(index == 1 ? UiMode::ChatFull : (index == 2 ? UiMode::ChatFace : UiMode::Face));
    return;
  }
  gDeviceSettings.eyeSkin = static_cast<uint8_t>((gDeviceSettings.eyeSkin +
      (index == 4 ? kEyeSkinCount - 1 : 1)) % kEyeSkinCount);
  saveDeviceSettings();
  setStatus(eyeSkinName(gDeviceSettings.eyeSkin), 900);
}

void renderChatCommandsOverlay() {
  if (!gChatCommandsVisible || !isAssistantUi()) return;
  auto& d = gCanvas;
  const uint16_t bg = rgb565_local(8,19,31), accent = rgb565_local(47,227,255);
  d.fillRoundRect(16,12,208,113,6,bg);
  d.drawRoundRect(16,12,208,113,6,accent);
  d.setFont(&fonts::Font0); d.setTextSize(1);
  d.setTextColor(accent,bg); d.setCursor(24,18); d.print("COMMANDS        Esc close");
  static const char* labels[] = {"R  Realtime / large eyes", "C  Full Chat", "E  Chat Eyes",
                                "F  Big Eyes", "[  Previous animal", "]  Next animal"};
  for (uint8_t i=0;i<6;++i) {
    uint16_t row = i == gChatCommandSelection ? rgb565_local(18,53,59) : bg;
    d.fillRoundRect(21,30+i*15,198,14,3,row);
    d.setTextColor(i == gChatCommandSelection ? TFT_WHITE : rgb565_local(160,180,190),row);
    d.setCursor(26,33+i*15); d.print(labels[i]);
  }
}

bool gNesRunning = false;
bool gNesWifiWasOn = false;
uint32_t gNesNextFrameUs = 0;
uint32_t gNesFrameNumber = 0;
int16_t gNesAudio[3][368];
uint8_t gNesAudioSlot=0;
uint16_t gNesScanline[136];

void leaveNesApp() {
  if (!gNesRunning) return;
  M5Cardputer.Speaker.stop(kNesAudioChannel);
  s1_nes_close();
  gNesRunning = false;
  restoreUiCanvasAfterNetwork();
  M5Cardputer.Mic.begin();
  if (gNesWifiWasOn) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(gWifiSsid.c_str(),gWifiPassword.c_str());
  }
  markUserActivity();
  logf("[NES] exit allocated=%u",static_cast<unsigned>(s1_nes_memory()));
}

bool enterNesApp() {
  if (gNesRunning) return true;
  if (gInboxHttpBusy || gSubmitting || gThinking || gRecording || gTextTurnTaskHandle ||
      !gPendingTextTurns.empty() || gOtaApplyInProgress || gBootBackgroundActive) {
    setStatus("NES: wait for current task",1200); return false;
  }
  if (gRealtimeActive || gRealtimeExclusiveMode) closeRealtimeSession("NES");
  if (gPlaybackActive || gPlaybackStreaming) stopPlaybackStream();
  gPlaybackActive = false;
  M5Cardputer.Mic.end(); M5Cardputer.Speaker.stop(kNesAudioChannel);
  prepareNetworkMemory("NES",true);
  gNesWifiWasOn = WiFi.getMode() != WIFI_OFF;
  WiFi.disconnect(false,false); WiFi.mode(WIFI_OFF); gWifiReady = false;
  releaseUiCanvasForNetwork("NES framebuffer");
  gNesRunning = true; // Ensures failed allocation takes the same cleanup path.
  if (!s1_nes_open(kHonkeyPongRom,sizeof(kHonkeyPongRom))) {
    leaveNesApp(); setStatus("NES: not enough memory",1600); return false;
  }
  gNesFrameNumber=0; gNesNextFrameUs=micros();
  M5Cardputer.Display.fillScreen(TFT_BLACK);
  M5Cardputer.Display.setFont(&fonts::Font0);
  M5Cardputer.Display.setTextColor(TFT_WHITE,TFT_BLACK);
  M5Cardputer.Display.setCursor(4,132-7);
  M5Cardputer.Display.print("W/S move  Enter start  Z/X A/B  Esc exit");
  logf("[NES] enter NROM HonkeyPong heap=%u allocated=%u",ESP.getFreeHeap(),
       static_cast<unsigned>(s1_nes_memory()));
  return true;
}

void serviceNesApp() {
  const auto& keys = gKeyboardState;
  uint8_t pad=0;
  bool escape=hasHidKey(keys,kHidKeyEscape);
  for (char c: keys.word) {
    c=static_cast<char>(tolower(static_cast<unsigned char>(c)));
    if(c=='`'||c=='~') escape=true;
    if(c=='w'||c=='i') pad|=0x10;
    if(c=='s'||c=='k') pad|=0x20;
    if(c=='a'||c=='j') pad|=0x40;
    if(c=='d'||c=='l') pad|=0x80;
    if(c=='z') pad|=1;
    if(c=='x') pad|=2;
  }
  if (escape) { setUiMode(UiMode::Home); render(); return; }
  if(keys.enter) pad|=8;
  if(keys.space) pad|=4;
  if(hasHidKey(keys,0xDA)) pad|=0x10;
  if(hasHidKey(keys,0xD9)) pad|=0x20;
  if(hasHidKey(keys,0xD8)) pad|=0x40;
  if(hasHidKey(keys,0xD7)) pad|=0x80;
  if (static_cast<int32_t>(micros()-gNesNextFrameUs)<0) return;
  gNesNextFrameUs=micros()+16667;
  bool canQueue=M5Cardputer.Speaker.isPlaying(kNesAudioChannel)<2;
  uint8_t slot=canQueue?gNesAudioSlot:2;
  int count=(gNesFrameNumber&1)?368:367;
  bool draw=(gNesFrameNumber%2)==0; // 60 Hz emulation, 30 Hz display.
  s1_nes_frame(pad,draw,gNesAudio[slot],count);
  if (canQueue && M5Cardputer.Speaker.playRaw(gNesAudio[slot],count,22050,false,1,kNesAudioChannel,false))
    gNesAudioSlot^=1;
  if(draw) {
    M5Cardputer.Display.startWrite();
    for(int y=0;y<124;++y) {
      const uint8_t* row=s1_nes_row(y*240/124);
      for(int x=0;x<136;++x) gNesScanline[x]=s1_nes_color(row[x*256/136]);
      M5Cardputer.Display.pushImage(52,y,136,1,gNesScanline);
    }
    M5Cardputer.Display.endWrite();
  }
  ++gNesFrameNumber;
}

} // namespace
