namespace {
bool gVoiceWifiPerformance = false;
wifi_ps_type_t gVoicePreviousWifiSleep = WIFI_PS_NONE;
bool beginVoiceWifiPerformance() {
  if (!gVoiceWifiPerformance && esp_wifi_get_ps(&gVoicePreviousWifiSleep) == ESP_OK) {
    gVoiceWifiPerformance = true;
    esp_wifi_set_ps(WIFI_PS_NONE);
    return true;
  }
  return false;
}
void endVoiceWifiPerformance() {
  if (gVoiceWifiPerformance) {
    esp_wifi_set_ps(gVoicePreviousWifiSleep);
    gVoiceWifiPerformance = false;
  }
}
void showVoiceNotice(const String& text, bool pending) {
  if(pending) gVoiceRequestTranscript=cleanReplyForDevice(text);
  while(gVoiceRequestTranscript.length()>512) removeLastUtf8Char(gVoiceRequestTranscript);
  gVoiceNoticeText = pending ? String("Reply will arrive in chat. You can close this window.") : cleanReplyForDevice(text);
  while (gVoiceNoticeText.length() > 1200) removeLastUtf8Char(gVoiceNoticeText);
  gVoiceNoticePending = pending;
  gVoiceRequestPhase=pending ? VoiceRequestPhase::Accepted : VoiceRequestPhase::Reply;
  gVoiceNoticeVisible = true;
  gVoiceNoticeShownMs = millis();
  gLauncherVisible = false;
  gChatCommandsVisible = false;
  markUserActivity();
  logf("[VOICE_UI] sheet=%s mode=%d", pending ? "accepted" : "reply", static_cast<int>(gUiMode));
}

void beginVoiceRequestUi() {
  gVoiceRequestTranscript="";gVoiceNoticeText="";gVoiceRequestProgress=0;
  gVoiceRequestPhase=VoiceRequestPhase::Recording;
  gVoiceNoticePending=false;gVoiceNoticeVisible=true;gVoiceNoticeShownMs=millis();
  gLauncherVisible=false;gChatCommandsVisible=false;
}

void showVoiceRequestError(const String& text) {
  showVoiceNotice(text,false);
  gVoiceRequestPhase=VoiceRequestPhase::Error;
}

void dismissVoiceNotice() {
  gVoiceNoticeVisible = false;
  gVoiceRequestPhase=VoiceRequestPhase::None;
  gQueuedVoiceReplySpeech = "";
  ++gVoiceReplySpeechGeneration;
}

bool handleVoiceRequestEscape() {
  if(!gVoiceNoticeVisible) return false;
  if(gRecording) cancelRecordingDiscard();
  else if(gSubmitting || gThinking){setStatus("Sending - please wait",900);return true;}
  dismissVoiceNotice();
  gAssistantPendingVisible=false;
  setFaceMode(FaceMode::Idle);
  if(gPlaybackActive){stopPlaybackStream();gPlaybackActive=false;}
  setUiMode(UiMode::Home);
  setStatus("Ready",1000);
  return true;
}

bool handleVoiceNoticeKey(char key, const Keyboard_Class::KeysState& keys) {
  if (!gVoiceNoticeVisible || !isAssistantUi()) return false;
  if(gVoiceRequestPhase==VoiceRequestPhase::Recording && keys.ctrl &&
      (key=='v'||key=='V')) return false;
  if(gVoiceRequestPhase==VoiceRequestPhase::Recording || gSubmitting || gThinking) return true;
  if (keys.enter || key == '\r' || key == '\n') {
    // Opening the conversation does not cancel speech already preparing.
    gVoiceNoticeVisible = false;
    gVoiceRequestPhase=VoiceRequestPhase::None;
    gAssistantPendingVisible=false;
    gInboxUnread = false;
    setUiMode(UiMode::ChatFull);
    logf("[VOICE_UI] sheet=open-chat");
  }
  return true;
}

void renderVoiceNotice() {
  if (!gVoiceNoticeVisible || !isAssistantUi() || gRealtimeActive) return;
  auto& d = gCanvas;
  const uint16_t bg=rgb565_local(5,13,20),muted=rgb565_local(147,173,192);
  const bool recording=gVoiceRequestPhase==VoiceRequestPhase::Recording;
  const bool sending=gVoiceRequestPhase==VoiceRequestPhase::Sending;
  const bool processing=gVoiceRequestPhase==VoiceRequestPhase::Processing;
  const bool accepted=gVoiceRequestPhase==VoiceRequestPhase::Accepted;
  const bool error=gVoiceRequestPhase==VoiceRequestPhase::Error;
  const uint16_t accent=error ? rgb565_local(255,96,80) :
      recording||sending||processing ? rgb565_local(47,227,255) : rgb565_local(105,255,156);
  d.fillScreen(bg);d.drawRoundRect(4,4,232,126,5,rgb565_local(29,62,81));
  d.setFont(&fonts::Font0);d.setTextSize(1);d.setTextColor(muted,bg);
  d.setCursor(14,13);d.print("VOICE REQUEST");d.fillCircle(221,16,2,accent);
  const char* title=recording?"Recording":sending?"Sending":processing?"Processing":
      accepted?"Request accepted":error?"Check delivery":"Agent replied";
  d.setFont(&fonts::Font2);d.setTextColor(accent,bg);d.setCursor(14,29);d.print(title);
  if(recording){
    const uint32_t seconds=(millis()-gRecordStartMs)/1000U;char elapsed[12];
    snprintf(elapsed,sizeof(elapsed),"%02u:%02u",static_cast<unsigned>(seconds/60U),static_cast<unsigned>(seconds%60U));
    d.setFont(&fonts::Font4);d.setTextColor(TFT_WHITE,bg);d.setCursor(14,54);d.print(elapsed);
    mic_input_meter::draw(d,126,62,88,gMicInputMeter.visibleLevel(gRecording,millis()),rgb565_local(23,48,59),accent,rgb565_local(157,102,255));
    d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(14,97);d.print("Release G0 / Ctrl+V to send");
  }else if(sending||processing){
    d.setFont(&fonts::Font0);d.setTextColor(muted,bg);d.setCursor(14,58);
    d.print(processing?"Recognizing and delivering...":fitCurrentFontToWidth(gStatusText,208));
    d.fillRoundRect(14,85,208,6,2,rgb565_local(23,48,59));
    if(gVoiceRequestProgress) d.fillRoundRect(14,85,max<int>(1,208*gVoiceRequestProgress/100),6,2,accent);
    d.setCursor(14,99);d.print("Keep this window open");
  }else if(accepted){
    d.setFont(&fonts::Font0);d.setTextColor(TFT_WHITE,bg);d.setCursor(14,53);d.print("Reply will arrive in chat.");
    d.setTextColor(muted,bg);d.setCursor(14,66);d.print("You can close this window.");
    d.setCursor(14,80);d.print("YOU SAID");d.setFont(&fonts::efontCN_12);
    auto lines=wrapText(gVoiceRequestTranscript,208);d.setTextColor(TFT_WHITE,bg);
    for(int i=0;i<min<int>(2,lines.size());++i){d.setCursor(14,91+i*12);d.print(fitCurrentFontToWidth(lines[i],208));}
  }else{
    d.setFont(&fonts::efontCN_12);auto lines=wrapText(gVoiceNoticeText,208);d.setTextColor(TFT_WHITE,bg);
    for(int i=0;i<min<int>(4,lines.size());++i){d.setCursor(14,55+i*14);d.print(fitCurrentFontToWidth(lines[i],208));}
  }
  d.fillRoundRect(10,116,220,12,2,rgb565_local(9,27,42));
  d.setFont(&fonts::Font0);d.setTextColor(muted,rgb565_local(9,27,42));d.setCursor(14,119);
  d.print(recording?"Esc cancel":sending||processing?"Sending - please wait":"Enter chat         Esc OK");
  d.setFont(&fonts::Font2);
}

struct VoiceSpeechPayload {
  String url, token, body, path;
  fs::FS* fs = nullptr;
  uint32_t generation = 0;
};
struct VoiceSpeechResult {
  String path;
  fs::FS* fs = nullptr;
  uint32_t generation = 0, sampleRate = kTtsDefaultSampleRate;
  size_t bytes = 0;
  int code = 0;
  bool ok = false;
};
portMUX_TYPE gVoiceSpeechMux = portMUX_INITIALIZER_UNLOCKED;
VoiceSpeechResult* gVoiceSpeechResult = nullptr;
volatile bool gVoiceSpeechAllocationFailed = false;

VoiceSpeechResult* performVoiceReplySpeech(void* arg) {
  std::unique_ptr<VoiceSpeechPayload> payload(static_cast<VoiceSpeechPayload*>(arg));
  std::unique_ptr<VoiceSpeechResult> result(new (std::nothrow) VoiceSpeechResult());
  if (!result) return nullptr;
  result->path = payload->path; result->fs = payload->fs; result->generation = payload->generation;
  HTTPClient http;
  std::unique_ptr<WiFiClientSecure> secure;
  std::unique_ptr<uint8_t[]> buffer(new (std::nothrow) uint8_t[4096]);
  http.setConnectTimeout(4000); http.setTimeout(20000); http.setReuse(false);
  bool opened = false;
  if (buffer && payload->fs && WiFi.status() == WL_CONNECTED) {
    if (payload->url.startsWith("https://")) {
      secure.reset(new WiFiClientSecure());
      secure->setCACert(kTlsRootCaPem); secure->setHandshakeTimeout(12);
      opened = http.begin(*secure, payload->url);
    } else opened = http.begin(payload->url);
  }
  const char* headers[] = {"X-Audio-Sample-Rate"};
  http.collectHeaders(headers, 1);
  if (opened && payload->generation == gVoiceReplySpeechGeneration) {
    http.addHeader("Content-Type", "application/json");
    if (!payload->token.isEmpty()) http.addHeader("Authorization", "Bearer " + payload->token);
    result->code = http.POST(payload->body);
    if (result->code == 200 && payload->generation == gVoiceReplySpeechGeneration) {
      const uint32_t rate = http.header("X-Audio-Sample-Rate").toInt();
      if (rate >= 8000 && rate <= 48000) result->sampleRate = rate;
      const int expected = http.getSize();
      constexpr size_t maxBytes = 4 * 1024 * 1024;
      if (expected <= static_cast<int>(maxBytes)) {
        File output = payload->fs->open(payload->path, "w");
        WiFiClient* stream = http.getStreamPtr();
        const uint32_t start = millis();
        while (output && stream && http.connected() && millis() - start < 45000 &&
               payload->generation == gVoiceReplySpeechGeneration && result->bytes < maxBytes &&
               (expected < 0 || result->bytes < static_cast<size_t>(expected))) {
          const int available = stream->available();
          if (available <= 0) { delay(2); continue; }
          size_t chunk = min<size_t>(4096, min<size_t>(available, maxBytes - result->bytes));
          if (expected >= 0) chunk = min<size_t>(chunk, expected - result->bytes);
          const int got = stream->read(buffer.get(), chunk);
          if (got <= 0 || output.write(buffer.get(), got) != static_cast<size_t>(got)) break;
          result->bytes += got;
          delay(1);
        }
        output.close();
        result->ok = payload->generation == gVoiceReplySpeechGeneration && result->bytes > 0 &&
                     !(result->bytes & 1) && (expected < 0 ? !http.connected() : result->bytes == static_cast<size_t>(expected));
      }
    }
    http.end();
  }
  if (!result->ok && result->fs) fsRemove(*result->fs, result->path);
  return result.release(); // TLS, HTTP and file destructors finish before publication.
}

void voiceReplySpeechTask(void* arg) {
  VoiceSpeechResult* result = performVoiceReplySpeech(arg);
  portENTER_CRITICAL(&gVoiceSpeechMux);
  gVoiceSpeechResult = result; gVoiceSpeechAllocationFailed = result == nullptr;
  portEXIT_CRITICAL(&gVoiceSpeechMux);
  vTaskDelete(nullptr);
}

void serviceVoiceReplySpeech() {
  VoiceSpeechResult* completed = nullptr;
  portENTER_CRITICAL(&gVoiceSpeechMux);
  completed = gVoiceSpeechResult; gVoiceSpeechResult = nullptr;
  portEXIT_CRITICAL(&gVoiceSpeechMux);
  if (completed) {
    std::unique_ptr<VoiceSpeechResult> result(completed);
    gVoiceReplySpeechBusy = false;
    if (gVoiceSpeechCanvasReleased) { restoreUiCanvasAfterNetwork(); gVoiceSpeechCanvasReleased = false; }
    initSpeaker();
    const bool current = result->generation == gVoiceReplySpeechGeneration;
    const bool play = result->ok && current && !gRecording && !gRealtimeActive && !gPlaybackActive;
    bool started = play && startPlaybackStreamFromRawPcmFile(result->path, result->sampleRate, result->bytes, "voice reply");
    if (!started && result->fs) fsRemove(*result->fs, result->path);
    logf("[VOICE_TTS] code=%d bytes=%u playback=%d current=%d", result->code,
         static_cast<unsigned>(result->bytes), started, current);
    if (!started && current) setStatus("Reply text ready; voice unavailable", 2500);
  }
  if (gVoiceSpeechAllocationFailed) {
    gVoiceSpeechAllocationFailed = false; gVoiceReplySpeechBusy = false;
    if (gVoiceSpeechCanvasReleased) { restoreUiCanvasAfterNetwork(); gVoiceSpeechCanvasReleased = false; }
    initSpeaker();
  }
  if (gQueuedVoiceReplySpeech.isEmpty() || gVoiceReplySpeechBusy || gInboxHttpBusy || gVoiceDialBusy || gRealtimeDialBusy ||
      gSubmitting || gThinking || gRecording || gPlaybackActive || gRealtimeActive || gOtaApplyInProgress ||
      gTextTurnTaskHandle || !gPendingTextTurns.empty()) return;
  std::unique_ptr<VoiceSpeechPayload> payload(new (std::nothrow) VoiceSpeechPayload());
  if (!payload) { gQueuedVoiceReplySpeech = ""; return; }
  payload->fs = activeVoiceFs();
  if (!payload->fs || !gWifiReady) { gQueuedVoiceReplySpeech = ""; return; }
  payload->url = hubBaseUrl() + kDeviceTtsPath; payload->token = gDeviceToken;
  payload->generation = ++gVoiceReplySpeechGeneration;
  payload->path = "/voice/__reply_" + String(payload->generation) + ".pcm";
  while (gQueuedVoiceReplySpeech.length() > 1800) removeLastUtf8Char(gQueuedVoiceReplySpeech);
  DynamicJsonDocument doc(3072);
  doc["device_id"] = gDeviceId; doc["text"] = gQueuedVoiceReplySpeech;
  serializeJson(doc, payload->body); gQueuedVoiceReplySpeech = "";
  gVoiceReplySpeechBusy = true;
  clearEmojiCache();
  M5Cardputer.Speaker.end();
  if (tlsHandshakeNeedsCanvas())
    gVoiceSpeechCanvasReleased = releaseUiCanvasForNetwork("speech memory");
  VoiceSpeechPayload* raw = payload.release();
  if (xTaskCreate(voiceReplySpeechTask, "voice-tts", 12288, raw, 1, nullptr) != pdPASS) {
    delete raw; gVoiceReplySpeechBusy = false;
    if (gVoiceSpeechCanvasReleased) { restoreUiCanvasAfterNetwork(); gVoiceSpeechCanvasReleased = false; }
    initSpeaker(); setStatus("Reply text ready; voice memory low", 2500);
  } else logf("[VOICE_TTS] background start generation=%u", static_cast<unsigned>(gVoiceReplySpeechGeneration));
}
struct VoiceDialPayload { String host; uint16_t port=443; bool tls=true; uint32_t generation=0; };
struct VoiceDialResult { std::unique_ptr<WiFiClient> socket; uint32_t generation=0; };
portMUX_TYPE gVoiceDialMux = portMUX_INITIALIZER_UNLOCKED;
VoiceDialResult* gVoiceDialResult = nullptr;
volatile bool gVoiceDialAllocationFailed = false;
uint32_t gVoiceDialGeneration = 0;
std::unique_ptr<WiFiClient> gVoiceReadySocket;

VoiceDialResult* performVoicePreconnect(void* arg) {
  std::unique_ptr<VoiceDialPayload> payload(static_cast<VoiceDialPayload*>(arg));
  std::unique_ptr<VoiceDialResult> result(new (std::nothrow) VoiceDialResult());
  if (!result) return nullptr;
  result->generation = payload->generation;
  if (payload->tls) {
    std::unique_ptr<WiFiClientSecure> socket(new WiFiClientSecure());
    socket->setCACert(kTlsRootCaPem); socket->setHandshakeTimeout(12);
    socket->setTimeout((kTurnHttpTimeoutMs + 999) / 1000);
    if (socket->connect(payload->host.c_str(), payload->port, 4000)) result->socket = std::move(socket);
  } else {
    std::unique_ptr<WiFiClient> socket(new WiFiClient());
    socket->setTimeout((kTurnHttpTimeoutMs + 999) / 1000);
    if (socket->connect(payload->host.c_str(), payload->port, 4000)) result->socket = std::move(socket);
  }
  if (result->socket) result->socket->setNoDelay(true);
  return result.release();
}
void voicePreconnectTask(void* arg) {
  VoiceDialResult* result = performVoicePreconnect(arg);
  portENTER_CRITICAL(&gVoiceDialMux);
  gVoiceDialResult = result; gVoiceDialAllocationFailed = result == nullptr;
  portEXIT_CRITICAL(&gVoiceDialMux);
  vTaskDelete(nullptr);
}
void cancelVoicePreconnect() {
  ++gVoiceDialGeneration;
  gVoiceReadySocket.reset();
}
void serviceVoicePreconnect() {
  VoiceDialResult* completed = nullptr;
  portENTER_CRITICAL(&gVoiceDialMux);
  completed = gVoiceDialResult; gVoiceDialResult = nullptr;
  portEXIT_CRITICAL(&gVoiceDialMux);
  if (completed) {
    std::unique_ptr<VoiceDialResult> result(completed);
    gVoiceDialBusy = false;
    const bool current = result->generation == gVoiceDialGeneration;
    if (current) gVoiceReadySocket = std::move(result->socket);
    logf("[VOICE] preconnect ready=%d current=%d", static_cast<int>(gVoiceReadySocket != nullptr), current);
  }
  if (gVoiceDialAllocationFailed) { gVoiceDialAllocationFailed = false; gVoiceDialBusy = false; }
  if (!gVoiceDialBusy && gVoiceDialCanvasReleased) {
    restoreUiCanvasAfterNetwork();gVoiceDialCanvasReleased=false;
  }
}
void beginVoicePreconnect() {
  clearEmojiCache();
  serviceVoicePreconnect();
  cancelVoicePreconnect();
  if (gVoiceDialBusy || gVoiceReplySpeechBusy || gInboxHttpBusy || gRealtimeDialBusy || !gWifiReady || gHubHost.isEmpty()) return;
  std::unique_ptr<VoiceDialPayload> payload(new (std::nothrow) VoiceDialPayload());
  if (!payload) return;
  payload->host = gHubHost; payload->port = gHubPort; payload->tls = hubUsesTls(); payload->generation = gVoiceDialGeneration;
  if (payload->tls && tlsHandshakeNeedsCanvas())
    gVoiceDialCanvasReleased=releaseUiCanvasForNetwork("voice preconnect TLS");
  gVoiceDialBusy = true;
  VoiceDialPayload* raw = payload.release();
  if (xTaskCreate(voicePreconnectTask, "voice-connect", 12288, raw, 1, nullptr) != pdPASS) {
    delete raw; gVoiceDialBusy = false;
    if(gVoiceDialCanvasReleased){restoreUiCanvasAfterNetwork();gVoiceDialCanvasReleased=false;}
  }
}
std::unique_ptr<WiFiClient> takeVoicePreconnect() {
  const uint32_t started = millis();
  while (gVoiceDialBusy && millis() - started < 17000U) {
    serviceVoicePreconnect();
    if (gVoiceDialBusy) pumpBlockingNetworkUi();
  }
  serviceVoicePreconnect();
  if (gVoiceReadySocket && !gVoiceReadySocket->connected()) gVoiceReadySocket.reset();
  return std::move(gVoiceReadySocket);
}
} // namespace
