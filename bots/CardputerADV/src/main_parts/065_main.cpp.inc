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
  gVoiceNoticeText = cleanReplyForDevice(text);
  while (gVoiceNoticeText.length() > 1200) removeLastUtf8Char(gVoiceNoticeText);
  gVoiceNoticePending = pending;
  gVoiceNoticeVisible = true;
  gVoiceNoticeShownMs = millis();
  gLauncherVisible = false;
  gChatCommandsVisible = false;
  markUserActivity();
  logf("[VOICE_UI] sheet=%s mode=%d", pending ? "accepted" : "reply", static_cast<int>(gUiMode));
}

void dismissVoiceNotice() {
  gVoiceNoticeVisible = false;
  gQueuedVoiceReplySpeech = "";
  ++gVoiceReplySpeechGeneration;
}

bool handleVoiceNoticeKey(char key, const Keyboard_Class::KeysState& keys) {
  if (!gVoiceNoticeVisible || !isAssistantUi()) return false;
  if (keys.enter || key == '\r' || key == '\n') {
    // Opening the conversation does not cancel speech already preparing.
    gVoiceNoticeVisible = false;
    gInboxUnread = false;
    setUiMode(UiMode::ChatFull);
    logf("[VOICE_UI] sheet=open-chat");
  }
  return true;
}

void renderVoiceNotice() {
  if (!gVoiceNoticeVisible || !isAssistantUi() || gRecording || gRealtimeActive) return;
  auto& d = gCanvas;
  const uint16_t panel = rgb565_local(9, 27, 42);
  const uint16_t accent = gVoiceNoticePending ? rgb565_local(255, 194, 74) : rgb565_local(105, 255, 156);
  d.setFont(&fonts::efontCN_12);
  auto lines = wrapText(gVoiceNoticeText, 212);
  const int count = min<int>(6, lines.size());
  const int height = max<int>(80, 38 + count * 14);
  const uint32_t age = millis() - gVoiceNoticeShownMs;
  const int y = 4 - (age < 180 ? static_cast<int>((180 - age) * height / 180) : 0);
  d.fillRoundRect(4, y, 232, height, 12, panel);
  d.drawRoundRect(4, y, 232, height, 12, accent);
  d.setFont(&fonts::Font2);
  d.setTextColor(accent, panel);
  d.setCursor(14, y + 5);
  d.print(gVoiceNoticePending ? "Request accepted" : "AI Agent");
  d.setFont(&fonts::efontCN_12);
  d.setTextColor(TFT_WHITE, panel);
  for (int i = 0; i < count; ++i) {
    d.setCursor(14, y + 25 + i * 14);
    d.print(fitCurrentFontToWidth(lines[i], 212));
  }
  d.setFont(&fonts::Font0);
  d.setTextColor(rgb565_local(147, 173, 192), panel);
  d.setCursor(14, y + height - 10);
  d.print(lines.size() > 6 ? "Enter read more   Esc close" : "Enter open   Esc close");
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
  if (gQueuedVoiceReplySpeech.isEmpty() || gVoiceReplySpeechBusy || gInboxHttpBusy || gVoiceDialBusy ||
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
  if (heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) < 40000)
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
}
void beginVoicePreconnect() {
  clearEmojiCache();
  serviceVoicePreconnect();
  cancelVoicePreconnect();
  if (gVoiceDialBusy || gVoiceReplySpeechBusy || gInboxHttpBusy || !gWifiReady || gHubHost.isEmpty() ||
      heap_caps_get_largest_free_block(MALLOC_CAP_8BIT) < 40000) return;
  std::unique_ptr<VoiceDialPayload> payload(new (std::nothrow) VoiceDialPayload());
  if (!payload) return;
  payload->host = gHubHost; payload->port = gHubPort; payload->tls = hubUsesTls(); payload->generation = gVoiceDialGeneration;
  gVoiceDialBusy = true;
  VoiceDialPayload* raw = payload.release();
  if (xTaskCreate(voicePreconnectTask, "voice-connect", 12288, raw, 1, nullptr) != pdPASS) { delete raw; gVoiceDialBusy = false; }
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
