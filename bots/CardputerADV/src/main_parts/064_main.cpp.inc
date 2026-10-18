extern "C" {
#include <s1_nes.h>
}

namespace {
constexpr uint8_t kNesAudioChannel=0;
// Shared assistant navigation and a bounded NES app.
bool handleHomeUpdateKey(char key, const Keyboard_Class::KeysState& keys) {
  if (!keys.ctrl || keys.alt || keys.fn || (key!='u' && key!='U') ||
      (gUiMode!=UiMode::Home && gUiMode!=UiMode::Clock) ||
      gLauncherVisible || gChatCommandsVisible || gVoiceNoticeVisible) return false;
  if (gBlockingInputPumpActive || gRecording || gSubmitting || gThinking ||
      gPlaybackActive || gRealtimeActive || gRealtimeDialBusy || gOtaApplyInProgress ||
      gPendingOtaCheckAction || gPendingOtaApplyAction) {
    setStatus("Busy, please wait",900);
    return true;
  }
  // Queue on the UI thread. The existing OTA service waits for network workers
  // and retains its battery, version, trusted-URL, hash and rollback checks.
  gPendingOtaApplyAction = homeFirmwareUpdateAvailable();
  gPendingOtaCheckAction = true;
  gPendingOtaActionAfterMs = millis()+100;
  setStatus(gPendingOtaApplyAction ? "Starting update..." : "Checking updates...",900);
  logf("[OTA_UI] Ctrl+U queued apply=%d",static_cast<int>(gPendingOtaApplyAction));
  return true;
}

bool isAssistantUi() {
  return gUiMode == UiMode::Home || gUiMode == UiMode::ChatFace ||
         gUiMode == UiMode::ChatFull || gUiMode == UiMode::Face || gUiMode == UiMode::Hero ||
         gUiMode == UiMode::Clock;
}

String makeRealtimeUpgradeRequest(const String& host,uint16_t port,const String& path,
                                  const String& key,const String& extraHeaders) {
  String request;
  request.reserve(512+extraHeaders.length());
  request="GET "+path+" HTTP/1.1\r\nHost: "+host;
  // The public ingress routes the authority as received. A redundant :443
  // reaches its unavailable fallback; use the canonical HTTPS authority.
  if (port!=443) request+=":"+String(port);
  request+="\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ";
  request+=key+"\r\n";
  if (!extraHeaders.isEmpty()) request+=extraHeaders+"\r\n";
  request+="User-Agent: S1-ADV\r\n\r\n";
  return request;
}

RealtimeDialResult* performRealtimeDial(void* arg) {
  std::unique_ptr<RealtimeDialRequest> request(static_cast<RealtimeDialRequest*>(arg));
  std::unique_ptr<RealtimeDialResult> result(new RealtimeDialResult());
  if (!result) return nullptr;
  result->generation=request->generation;
  result->key=request->key;
  std::unique_ptr<WiFiClientSecure> socket(new WiFiClientSecure());
  if (!socket || WiFi.status()!=WL_CONNECTED) {
    result->error="Wi-Fi unavailable";
  } else {
    socket->setCACert(kTlsRootCaPem);
    socket->setHandshakeTimeout(12);
    if (!socket->connect(request->host.c_str(),request->port,5000)) {
      char detail[96]={};
      const int code=socket->lastError(detail,sizeof(detail));
      result->error="TLS connect failed "+String(code);
    } else {
      socket->setNoDelay(true);
      const size_t length=request->request.length();
      if (socket->write(reinterpret_cast<const uint8_t*>(request->request.c_str()),length)!=length)
        result->error="Upgrade request send failed";
      else result->socket=std::move(socket);
    }
  }
  return result.release(); // Failed sockets and request strings die before task deletion.
}

void realtimeDialTask(void* arg) {
  RealtimeDialResult* result=performRealtimeDial(arg);
  portENTER_CRITICAL(&gRealtimeDialMux);
  gRealtimeDialResult=result;
  gRealtimeDialAllocationFailed=result==nullptr;
  portEXIT_CRITICAL(&gRealtimeDialMux);
  vTaskDelete(nullptr);
}

bool beginRealtimeDial() {
  std::unique_ptr<RealtimeDialRequest> request(new RealtimeDialRequest());
  if (!request) return false;
  request->host=gHubHost;
  request->port=gHubPort;
  request->key=gRealtimeWs.newHandshakeKey();
  request->request=makeRealtimeUpgradeRequest(gHubHost,gHubPort,kRealtimeWsPath,
                                               request->key,gRealtimeExtraHeaders);
  request->generation=++gRealtimeDialGeneration;
  // TLS needs two record buffers and certificate workspace at once. Borrow
  // the sprite only during the handshake; loopTask restores it on completion.
  clearEmojiCache();
  M5Cardputer.Speaker.end();
  gRealtimeDialCanvasReleased=releaseUiCanvasForNetwork("realtime TLS");
  gRealtimeDialBusy=true;
  RealtimeDialRequest* raw=request.release();
  if (xTaskCreate(realtimeDialTask,"rt-connect",12288,raw,1,nullptr)!=pdPASS) {
    delete raw;gRealtimeDialBusy=false;
    if(gRealtimeDialCanvasReleased){restoreUiCanvasAfterNetwork();gRealtimeDialCanvasReleased=false;}
    return false;
  }
  return true;
}

void serviceRealtimeDialCompletion() {
  RealtimeDialResult* completed=nullptr;
  bool allocationFailed=false;
  portENTER_CRITICAL(&gRealtimeDialMux);
  completed=gRealtimeDialResult;gRealtimeDialResult=nullptr;
  allocationFailed=gRealtimeDialAllocationFailed;gRealtimeDialAllocationFailed=false;
  portEXIT_CRITICAL(&gRealtimeDialMux);
  if (!completed && !allocationFailed) return;
  gRealtimeDialBusy=false;
  if(gRealtimeDialCanvasReleased){restoreUiCanvasAfterNetwork();gRealtimeDialCanvasReleased=false;}
  if (allocationFailed) {
    if (gRealtimeActive) failRealtimeSession("Not enough memory for connection");
    return;
  }
  std::unique_ptr<RealtimeDialResult> result(completed);
  if (!gRealtimeActive || result->generation!=gRealtimeDialGeneration) return;
  if (!result->error.isEmpty() || !result->socket) {
    failRealtimeSession(result->error.isEmpty() ? String("Connection failed") : result->error);
    return;
  }
  gRealtimeWs.adopt(result->socket.release(),result->key);
  logf("[RT] TLS worker ready; awaiting upgrade");
}

// Tab always opens the app launcher. Assistant commands have their own chord.
bool handleAssistantMenuKey(char key,const Keyboard_Class::KeysState& keys) {
  if (!isAssistantUi()) return false;
  char lower=static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (keys.ctrl && lower=='b') {toggleRealtimeView();return true;}
  if (keys.ctrl && lower=='k') {
    gVoiceNoticeVisible=false;
    gChatCommandsVisible=!gChatCommandsVisible;
    gLauncherVisible=false;
    return true;
  }
  if (keys.ctrl && lower=='l') {
    gVoiceNoticeVisible=false;
    gChatCommandsVisible=false;
    gLauncherVisible=!gLauncherVisible;
    return true;
  }
  if (keys.tab) {
    gVoiceNoticeVisible=false;
    gChatCommandsVisible=false;
    if (gLauncherVisible) moveLauncherSubSelection(1);
    else gLauncherVisible=true;
    return true;
  }
  return false;
}

bool handleEyeSkinKey(char key,const Keyboard_Class::KeysState& keys) {
  if (!isAssistantUi() || gLauncherVisible || gRecording) return false;
  // Brackets remain text in Full Chat. On an eye screen, or with Ctrl, they
  // always work, including while Realtime owns the microphone.
  const bool eyes=gUiMode==UiMode::Face || gUiMode==UiMode::ChatFace;
  if (!keys.ctrl && !eyes) return false;
  if (key=='[' || (keys.ctrl && key==',')) {runChatCommand(4);return true;}
  if (key==']' || (keys.ctrl && key=='.')) {runChatCommand(5);return true;}
  return false;
}

const char* realtimeStageLabel() {
  if (!gRealtimeUiError.isEmpty()) return "ERROR";
  if (gPendingRealtimeStart) return "WAIT";
  if (!gRealtimeActive) return "OFF";
  if (!gRealtimeConnected) return "CONNECT";
  if (gRealtimePlaybackActive || gPlaybackActive) return "SPEAK";
  if (gRealtimeRecording) return "LISTEN";
  if (gRealtimeAwaiting) return "THINK";
  return "READY";
}

void renderRealtimeBadges() {
  auto& d=gCanvas;
  const bool error=!gRealtimeUiError.isEmpty();
  const bool micOn=gRealtimeRecording && gRealtimeActive && gRealtimeConnected && !error;
  const bool preparing=gPendingRealtimeStart || gRealtimeRestartAfterPlayback ||
      (gRealtimeActive && !gRealtimeConnected);
  const char* stage=!error && preparing ? "PREPARE" : realtimeStageLabel();
  const uint16_t bg=rgb565_local(3,7,13),muted=rgb565_local(140,160,180);
  const uint16_t accent=error ? rgb565_local(255,96,64) :
      micOn ? rgb565_local(96,255,160) : rgb565_local(96,208,255);
  d.setFont(&fonts::Font0);d.setTextSize(1);
  // Small floating badges retain the complete eye renderer and its full height.
  const int stageWidth=d.textWidth(stage)+23;
  d.fillRoundRect(6,4,stageWidth,15,6,bg);
  d.fillCircle(13,11,2,accent);
  d.setTextColor(accent,bg);d.setCursor(20,8);d.print(stage);
  d.fillRoundRect(178,4,56,15,6,bg);
  d.setTextColor(micOn?accent:muted,bg);d.setCursor(184,8);
  d.print(micOn?"MIC ON":"MIC OFF");
  const uint8_t level=gMicInputMeter.visibleLevel(micOn,millis());
  if(micOn && level){
    for(int i=0;i<3;++i){
      const int height=static_cast<unsigned>(level)*(i==1?10:7)/255;
      if(height)d.fillRect(222+i*4,16-height,2,height,accent);
    }
  }
  if(error){
    d.fillRoundRect(12,113,216,18,5,bg);
    d.setTextColor(accent,bg);d.setCursor(18,118);
    d.print(fitCurrentFontToWidth(gRealtimeUiError,204));
  }
  d.setFont(&fonts::Font2);
}

void renderRealtimeEyesUi() {
  renderUncannyEyesUi();
  renderRealtimeBadges();
}

void renderRealtimeUi() {
  // One renderer shares the existing transport, microphone and playback state.
  if (gRealtimeClassicView) {
    renderAssistantPulseUi();
    if (!gLauncherVisible && !gDebugOverlayVisible) renderRealtimeBadges();
  } else renderRealtimeEyesUi();
}

void toggleRealtimeView() {
  gRealtimeClassicView=!gRealtimeClassicView;
  gUiFramePolicy.invalidate();
  gLastRenderMs=0;
  setStatus(gRealtimeClassicView?"Realtime view: Classic":"Realtime view: Eyes",900);
}

void servicePendingRealtimeStart() {
  if (!gPendingRealtimeStart || gInboxHttpBusy || gVoiceDialBusy || gVoiceReplySpeechBusy || gRealtimeDialBusy || gTextTurnTaskHandle || gCompletedTextTurn ||
      gSubmitting || !gPendingTextTurns.empty()) return;
  gPendingRealtimeStart = false;
  if (isAssistantUi()) startRealtimeSession(gPendingRealtimeAutoStart);
}

void runChatCommand(uint8_t index) {
  gChatCommandsVisible = false;
  gLauncherVisible = false;
  if (index==6) {toggleRealtimeView();return;}
  if (index<=3 && gRecording) cancelRecordingDiscard();
  if (index == 0) { toggleRealtimeVoice(); return; }
  if (index <= 3) {
    if (gRealtimeActive || gRealtimeExclusiveMode) closeRealtimeSession("chat view");
    gPendingRealtimeStart = false;
    gRealtimeScreenVisible=false;
    setUiMode(index == 1 ? UiMode::ChatFull : (index == 2 ? UiMode::ChatFace : UiMode::Face));
    return;
  }
  gDeviceSettings.eyeSkin = static_cast<uint8_t>((gDeviceSettings.eyeSkin +
      (index == 4 ? kEyeSkinCount - 1 : 1)) % kEyeSkinCount);
  saveDeviceSettings();
  logf("[EYES] skin=%u name=%s",gDeviceSettings.eyeSkin,eyeSkinName(gDeviceSettings.eyeSkin));
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
  const char* labels[] = {"R  Realtime", "C  Full Chat", "E  Chat Eyes",
                         "F  Big Eyes", "[  Previous animal", "]  Next animal",
                         gRealtimeClassicView?"B  RT view: Classic (Ctrl+B)":"B  RT view: Eyes (Ctrl+B)"};
  for (uint8_t i=0;i<kChatCommandCount;++i) {
    uint16_t row = i == gChatCommandSelection ? rgb565_local(18,53,59) : bg;
    d.fillRoundRect(21,30+i*13,198,12,3,row);
    d.setTextColor(i == gChatCommandSelection ? TFT_WHITE : rgb565_local(160,180,190),row);
    d.setCursor(26,33+i*13); d.print(labels[i]);
  }
}

struct NesGame { String path, title; size_t bytes=0; };
std::vector<NesGame> gNesGames;
File gNesRomFile;
bool gNesRunning=false, gNesWifiWasOn=false, gNesMenuDirty=true;
bool gNesEnterHeld=false, gNesEscapeHeld=false, gNesViewHeld=false;
bool gNesWide=false, gNesFaulted=false;
uint8_t gNesStartFrames=0;
int gNesSelection=0;
uint32_t gNesNextFrameUs=0, gNesFrameNumber=0, gNesStartedMs=0, gNesNavMs=0;
int16_t gNesAudio[3][368];
uint8_t gNesAudioSlot=0, gNesInjectedPad=0;
uint16_t gNesInjectedFrames=0;
lgfx::rgb565_t gNesScanline[240];
String gNesMessage;
File gNesUploadFile;
String gNesUploadTarget, gNesUploadTemp, gNesUploadSha;
size_t gNesUploadExpected=0, gNesUploadBytes=0;
bool gNesUploadActive=false;
uint32_t gNesUploadLastMs=0;
void serviceNesTransfer() {
  if(gNesUploadActive && millis()-gNesUploadLastMs>30000){gNesUploadFile.close();gNesUploadActive=false;gTransferUiActive=false;Serial.println("[NES_PUT] ERR timeout");}
}

void scanNesGames() {
  gNesGames.clear();
  if (!gSdReady) return;
  File directory=SD.open("/nes");
  if (!directory || !directory.isDirectory()) return;
  while (gNesGames.size()<32) {
    File file=directory.openNextFile();
    if (!file) break;
    String name=filenameFromPath(String(file.name())), lower=name;
    lower.toLowerCase();
    if (!file.isDirectory() && lower.endsWith(".nes") && file.size()>=16 && file.size()<=1024*1024) {
      NesGame game;game.path="/nes/"+name;game.title=name.substring(0,name.length()-4);game.bytes=file.size();
      gNesGames.push_back(game);
    }
    file.close();
  }
  directory.close();
  std::sort(gNesGames.begin(),gNesGames.end(),[](const NesGame& a,const NesGame& b){return a.title.compareTo(b.title)<0;});
  gNesSelection=clampValue<int>(gNesSelection,0,max<int>(0,static_cast<int>(gNesGames.size())-1));
  gNesMenuDirty=true;
}

void renderNesMenu() {
  auto& d=gCanvas;
  const uint16_t bg=rgb565_local(3,8,14),accent=rgb565_local(47,227,255),muted=rgb565_local(145,163,181);
  d.fillScreen(bg);d.setFont(&fonts::Font2);d.setTextSize(1);
  d.setTextColor(accent,bg);d.setCursor(10,5);d.print("NES GAMES");
  d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(184,11);d.printf("%u on SD",static_cast<unsigned>(gNesGames.size()));
  d.drawFastHLine(8,26,224,rgb565_local(21,51,65));
  if (gNesGames.empty()) {
    d.setCursor(12,44);d.print("No ROM files on the SD card.");
    d.setCursor(12,61);d.print("Copy your .nes files to SD:/nes");
  }
  const int first=max<int>(0,gNesSelection-3);
  for(int row=0;row<5 && first+row<static_cast<int>(gNesGames.size());++row) {
    int index=first+row,y=32+row*15;
    uint16_t panel=index==gNesSelection?rgb565_local(15,47,59):bg;
    d.fillRoundRect(8,y,224,14,3,panel);
    d.setTextColor(index==gNesSelection?TFT_WHITE:muted,panel);d.setCursor(13,y+3);
    d.print(fitCurrentFontToWidth(gNesGames[index].title,210));
  }
  d.setCursor(8,111);
  if(!gNesMessage.isEmpty()){d.setTextColor(rgb565_local(255,194,91),bg);d.print(fitCurrentFontToWidth(gNesMessage,224));}
  else {d.setTextColor(muted,bg);d.print(gNesWide?"F: fill screen (switch to 4:3)":"F: classic 4:3 (switch to fill)");}
  d.setTextColor(muted,bg);d.setCursor(8,127);d.print("W/S choose  Enter play  Esc back");
}

bool readNesRom(void* context,size_t offset,uint8_t* destination,size_t length) {
  auto* file=static_cast<File*>(context);
  if(!*file || offset>file->size() || length>file->size()-offset)return false;
  size_t done=0;
  while(done<length){
    const size_t count=min<size_t>(512,length-done);
    size_t got=0;
    for(int attempt=0;attempt<2 && !got;++attempt){
      if(file->seek(offset+done))got=file->read(destination+done,count);
      if(!got)delay(2);
    }
    if(!got || got>count)return false;
    done+=got;
  }
  return true;
}

void stopNesGame() {
  if (!gNesRunning) return;
  M5Cardputer.Speaker.stop(kNesAudioChannel);
  s1_nes_close();gNesRomFile.close();gNesRunning=false;gNesFaulted=false;
  restoreUiCanvasAfterNetwork();initSpeaker();
  if (gNesWifiWasOn) {WiFi.mode(WIFI_STA);WiFi.begin(gWifiSsid.c_str(),gWifiPassword.c_str());}
  markUserActivity();gNesMenuDirty=true;
  logf("[NES] exit allocated=%u heap=%u",static_cast<unsigned>(s1_nes_memory()),ESP.getFreeHeap());
}

void leaveNesApp() { stopNesGame();gNesGames.clear();gNesGames.shrink_to_fit();gNesMessage=""; }

bool startNesGame(int index) {
  if (index<0 || index>=static_cast<int>(gNesGames.size())) return false;
  if (gInboxHttpBusy || gVoiceDialBusy || gVoiceReplySpeechBusy || gSubmitting || gThinking ||
      gRecording || gTextTurnTaskHandle || !gPendingTextTurns.empty() || gOtaApplyInProgress || gNesUploadActive) {
    gNesMessage="Wait for the current request";gNesMenuDirty=true;return false;
  }
  if (gNesRunning) stopNesGame();
  gNesSelection=index;gNesMessage="";
  if (gRealtimeActive || gRealtimeExclusiveMode) closeRealtimeSession("NES");
  if (gPlaybackActive || gPlaybackStreaming) stopPlaybackStream();
  gPlaybackActive=false;cancelVoicePreconnect();
  M5Cardputer.Mic.end();M5Cardputer.Speaker.end();clearEmojiCache();prepareNetworkMemory("NES",true);
  gNesWifiWasOn=WiFi.getMode()!=WIFI_OFF;
  WiFi.disconnect(false,false);WiFi.mode(WIFI_OFF);gWifiReady=false;
  releaseUiCanvasForNetwork("NES");delay(30);
  gNesRunning=true;
  gNesRomFile=SD.open(gNesGames[index].path,"r");
  if(gNesRomFile)gNesRomFile.setBufferSize(512);
  if(!gNesRomFile || !s1_nes_open_stream(readNesRom,&gNesRomFile,gNesGames[index].bytes)) {
    logf("[NES] load failed heap=%u largest=%u io=%u",ESP.getFreeHeap(),static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)),static_cast<unsigned>(s1_nes_io_bytes()));
    stopNesGame();gNesMessage="Cannot load ROM (format / memory)";return false;
  }
  initSpeaker();gNesFrameNumber=0;gNesStartedMs=millis();gNesNextFrameUs=micros();
  gNesAudioSlot=0;gNesInjectedFrames=0;gNesStartFrames=0;gNesFaulted=false;
  M5Cardputer.Display.fillScreen(TFT_BLACK);
  logf("[NES] enter game=%s bytes=%u allocated=%u heap=%u",gNesGames[index].title.c_str(),
       static_cast<unsigned>(gNesGames[index].bytes),static_cast<unsigned>(s1_nes_memory()),ESP.getFreeHeap());
  return true;
}

bool enterNesApp() {
  if (gInboxHttpBusy || gVoiceDialBusy || gVoiceReplySpeechBusy || gSubmitting || gThinking ||
      gRecording || gTextTurnTaskHandle || gBootBackgroundActive || gNesUploadActive) {
    setStatus("NES: wait for current task",1200);return false;
  }
  scanNesGames();gNesMessage="";gNesEnterHeld=gKeyboardState.enter;gNesEscapeHeld=false;gNesViewHeld=false;
  return true;
}

void renderNesFrame() {
  const int width=nes_view::width(gNesWide),left=nes_view::left(gNesWide);
  M5Cardputer.Display.startWrite();
  for(int y=0;y<nes_view::height;++y){
    const uint8_t* row=s1_nes_row(nes_view::sourceRow(y));
    for(int x=0;x<width;++x)gNesScanline[x].raw=s1_nes_color(row[nes_view::sourceX(x,gNesWide)]);
    // An explicitly typed native RGB565 buffer avoids the driver's swapped
    // uint16_t image convention and cannot affect other screens' byte order.
    M5Cardputer.Display.pushImage(left,y,width,1,gNesScanline);
  }
  M5Cardputer.Display.endWrite();
}

void renderNesError() {
  auto& d=M5Cardputer.Display;
  d.fillRect(0,108,240,27,TFT_BLACK);d.setFont(&fonts::Font0);
  d.setTextColor(TFT_WHITE,TFT_BLACK);d.setCursor(8,113);d.print("SD read failed. Game paused.");
  d.setCursor(8,125);d.print("Esc: return to games");
}

void serviceNesApp() {
  const auto& keys=gKeyboardState;uint8_t pad=0;
  bool escape=hasHidKey(keys,kHidKeyEscape),up=hasHidKey(keys,0xDA),down=hasHidKey(keys,0xD9),view=false;
  for(char c:keys.word){
    c=static_cast<char>(tolower(static_cast<unsigned char>(c)));
    if(c=='`'||c=='~')escape=true;
    if(c=='w'||c=='i'){pad|=0x10;up=true;}if(c=='s'||c=='k'){pad|=0x20;down=true;}
    if(c=='a'||c=='j')pad|=0x40;if(c=='d'||c=='l')pad|=0x80;
    if(c=='z')pad|=1;if(c=='x')pad|=2;
    if(c=='f')view=true;
  }
  bool escapePressed=escape&&!gNesEscapeHeld,enterPressed=keys.enter&&!gNesEnterHeld,viewPressed=view&&!gNesViewHeld;
  gNesEscapeHeld=escape;gNesEnterHeld=keys.enter;gNesViewHeld=view;
  if(escapePressed){
    logf("[NES] exit requested key=escape running=%d",gNesRunning);
    if(gNesRunning)stopNesGame();else setUiMode(UiMode::Home);
    render();return;
  }
  if(viewPressed){
    gNesWide=!gNesWide;gNesMenuDirty=true;
    logf("[NES] view=%s",gNesWide?"fill":"4:3");
    if(gNesRunning){M5Cardputer.Display.fillScreen(TFT_BLACK);renderNesFrame();if(gNesFaulted)renderNesError();}
  }
  if(!gNesRunning){
    if((up||down) && (!gNesNavMs || millis()-gNesNavMs>180)){
      gNesNavMs=millis();gNesSelection=clampValue<int>(gNesSelection+(down?1:-1),0,max<int>(0,static_cast<int>(gNesGames.size())-1));gNesMenuDirty=true;
    }
    if(!up&&!down)gNesNavMs=0;
    if(enterPressed)startNesGame(gNesSelection);
    if(!gNesRunning&&gNesMenuDirty){render();gNesMenuDirty=false;}
    return;
  }
  if(gNesFaulted)return;
  if(enterPressed)gNesStartFrames=2;
  if(keys.space)pad|=4;
  if(hasHidKey(keys,0xDA))pad|=0x10;if(hasHidKey(keys,0xD9))pad|=0x20;
  if(hasHidKey(keys,0xD8))pad|=0x40;if(hasHidKey(keys,0xD7))pad|=0x80;
  if(static_cast<int32_t>(micros()-gNesNextFrameUs)<0)return;
  gNesNextFrameUs=micros()+16667;
  if(gNesStartFrames){pad|=8;--gNesStartFrames;}
  if(gNesInjectedFrames){pad|=gNesInjectedPad;--gNesInjectedFrames;}
  bool canQueue=M5Cardputer.Speaker.isPlaying(kNesAudioChannel)<2;
  uint8_t slot=canQueue?gNesAudioSlot:2;int count=(gNesFrameNumber&1)?368:367;bool draw=(gNesFrameNumber%2)==0;
  s1_nes_frame(pad,draw,gNesAudio[slot],count);
  if(!s1_nes_io_ok()){
    gNesFaulted=true;M5Cardputer.Speaker.stop(kNesAudioChannel);
    logf("[NES] paused reason=sd_read frame=%u",gNesFrameNumber);renderNesError();return;
  }
  if(canQueue&&M5Cardputer.Speaker.playRaw(gNesAudio[slot],count,22050,false,1,kNesAudioChannel,false))gNesAudioSlot^=1;
  if(draw)renderNesFrame();
  ++gNesFrameNumber;
}

bool handleNesHostCommand(const String& line) {
  if(line=="nes.put.abort"){gNesUploadFile.close();gNesUploadActive=false;gTransferUiActive=false;Serial.println("[NES_PUT] ABORTED");return true;}
  if(line=="nes.list"){
    scanNesGames();for(size_t i=0;i<gNesGames.size();++i)logf("[NES_GAME] index=%u bytes=%u path=%s",static_cast<unsigned>(i),static_cast<unsigned>(gNesGames[i].bytes),gNesGames[i].path.c_str());return true;
  }
  if(line.startsWith("nes.start ")){setUiMode(UiMode::Nes);if(gUiMode==UiMode::Nes)startNesGame(line.substring(10).toInt());return true;}
  if(line=="nes.exit"){setUiMode(UiMode::Home);render();return true;}
  if(line.startsWith("nes.pad ")){
    int at=line.indexOf(' ',8);if(at>0){gNesInjectedPad=line.substring(8,at).toInt();gNesInjectedFrames=clampValue<int>(line.substring(at+1).toInt(),0,600);}return true;
  }
  if(line=="nes.status"){
    uint32_t hash=2166136261U;
    if(gNesRunning)for(int y=0;y<240;y+=2){const auto* row=s1_nes_row(y);for(int x=0;x<256;x+=2)hash=(hash^row[x])*16777619U;}
    logf("[NES_STATUS] running=%d index=%d frames=%u fps=%u allocated=%u heap=%u io=%u hash=%08x faulted=%d view=%s",gNesRunning,gNesSelection,gNesFrameNumber,
         gNesRunning?static_cast<unsigned>(gNesFrameNumber*1000ULL/max<uint32_t>(1,millis()-gNesStartedMs)):0,
         static_cast<unsigned>(s1_nes_memory()),ESP.getFreeHeap(),static_cast<unsigned>(s1_nes_io_bytes()),hash,gNesFaulted,gNesWide?"fill":"4:3");return true;
  }
  if(line.startsWith("nes.put.begin ")){
    int first=line.indexOf(' ',14),second=first<0?-1:line.indexOf(' ',first+1);
    if(first<0||second<0||gNesUploadActive||gNesRunning||gRecording||gSubmitting||gInboxHttpBusy||gVoiceDialBusy||gVoiceReplySpeechBusy||gTransferUiActive){Serial.println("[NES_PUT] ERR busy/header");return true;}
    size_t size=line.substring(14,first).toInt();String sha=line.substring(first+1,second),name=line.substring(second+1),lower=name;lower.toLowerCase();
    bool valid=size>=16&&size<=1024*1024&&sha.length()==64&&name.length()<=96&&!name.startsWith(".")&&name.indexOf("..")<0&&lower.endsWith(".nes");
    for(char c:name)if(!(isalnum(static_cast<unsigned char>(c))||c==' '||c=='_'||c=='-'||c=='.'||c=='('||c==')'))valid=false;
    for(char c:sha)if(!isxdigit(static_cast<unsigned char>(c)))valid=false;
    if(!valid||!gSdReady){Serial.println("[NES_PUT] ERR invalid");return true;}
    if(!SD.exists("/nes"))SD.mkdir("/nes");gNesUploadTarget="/nes/"+name;gNesUploadTemp=gNesUploadTarget+".upload.part";
    gNesUploadFile=SD.open(gNesUploadTemp,"w");
    if(!gNesUploadFile){Serial.println("[NES_PUT] ERR open");return true;}
    gNesUploadFile.setBufferSize(512);gNesUploadExpected=size;gNesUploadBytes=0;gNesUploadSha=sha;
    gNesUploadActive=true;gTransferUiActive=true;gNesUploadLastMs=millis();markUserActivity();Serial.println("[NES_PUT] READY");return true;
  }
  if(line.startsWith("nes.put.chunk ")){
    int at=line.indexOf(' ',14);String hex=at<0?String():line.substring(at+1);
    size_t offset=at<0?0:line.substring(14,at).toInt();bool ok=gNesUploadActive&&at>0&&offset==gNesUploadBytes&&hex.length()>0&&hex.length()<=768&&(hex.length()%2)==0&&gNesUploadBytes+hex.length()/2<=gNesUploadExpected;
    uint8_t bytes[384];
    for(int i=0;ok&&i<hex.length();i+=2){
      if(!isxdigit(hex[i])||!isxdigit(hex[i+1])){ok=false;break;}
      auto digit=[](char c)->uint8_t{return isdigit(c)?c-'0':tolower(c)-'a'+10;};bytes[i/2]=(digit(hex[i])<<4)|digit(hex[i+1]);
    }
    if(ok)ok=writeRecordedBytes(gNesUploadFile,bytes,hex.length()/2)==hex.length()/2;
    if(!ok){gNesUploadFile.close();gNesUploadActive=false;gTransferUiActive=false;Serial.println("[NES_PUT] ERR chunk");return true;}
    gNesUploadBytes+=hex.length()/2;gNesUploadLastMs=millis();markUserActivity();Serial.printf("[NES_PUT] ACK %u\n",static_cast<unsigned>(gNesUploadBytes));return true;
  }
  if(line=="nes.put.end"){
    bool ok=gNesUploadActive&&gNesUploadBytes==gNesUploadExpected;
    gNesUploadFile.flush();gNesUploadFile.close();
    if(ok)ok=sha256File(SD,gNesUploadTemp)==gNesUploadSha;
    if(ok&&SD.exists(gNesUploadTarget)){
      if(sha256File(SD,gNesUploadTarget)==gNesUploadSha){SD.remove(gNesUploadTemp);}
      else ok=SD.rename(gNesUploadTarget,gNesUploadTarget+".previous."+String(millis()))&&SD.rename(gNesUploadTemp,gNesUploadTarget);
    }else if(ok)ok=SD.rename(gNesUploadTemp,gNesUploadTarget);
    gNesUploadActive=false;gTransferUiActive=false;scanNesGames();
    Serial.printf("[NES_PUT] %s bytes=%u\n",ok?"DONE":"ERR verify",static_cast<unsigned>(gNesUploadBytes));return true;
  }
  return false;
}

} // namespace
