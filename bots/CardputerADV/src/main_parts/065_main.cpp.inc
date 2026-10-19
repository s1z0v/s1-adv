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
  gUiFramePolicy.invalidate();
  while(gVoiceRequestTranscript.length()>512) removeLastUtf8Char(gVoiceRequestTranscript);
  gVoiceNoticeText = cleanReplyForDevice(text);
  while (gVoiceNoticeText.length() > 1200) removeLastUtf8Char(gVoiceNoticeText);
  gVoiceNoticePending = pending;
  gVoiceRequestPhase=pending ? VoiceRequestPhase::Accepted : VoiceRequestPhase::Reply;
  if (gScreensaverActive || gScreensaverDimmed || gScreenOffActive) handleScreensaverWake();
  // Receipts and replies live in chat and the Home badge. They must not
  // reopen a sheet over the clock or a menu the user is navigating.
  gVoiceNoticeVisible = false;
  if (!pending && gUiMode!=UiMode::ChatFull && gUiMode!=UiMode::ChatFace) gInboxUnread=true;
  gVoiceNoticeShownMs = millis();
  render(); // Paint feedback before a notification tone or TLS borrows the canvas.
  gLastRenderMs=millis();
  logf("[VOICE_UI] sheet=%s mode=%d painted=%d", pending ? "accepted" : "reply",
       static_cast<int>(gUiMode),static_cast<int>(gCanvasSpriteActive));
}

void rememberStoredAssistantSeq(uint32_t seq) {
  if (!seq || std::find(gStoredAssistantSeqs.begin(), gStoredAssistantSeqs.end(), seq) != gStoredAssistantSeqs.end()) return;
  gStoredAssistantSeqs.push_back(seq);
  while (gStoredAssistantSeqs.size() > 32) gStoredAssistantSeqs.pop_front();
}

bool consumeStoredAssistantSeq(uint32_t seq) {
  auto found = std::find(gStoredAssistantSeqs.begin(), gStoredAssistantSeqs.end(), seq);
  if (found == gStoredAssistantSeqs.end()) return false;
  gStoredAssistantSeqs.erase(found);
  return true;
}

void acceptPendingAssistantRequest(const String& transcript, const String& acknowledgement,
                                   uint32_t afterSeq, uint32_t receiptSeq) {
  gVoiceRequestTranscript = cleanReplyForDevice(transcript);
  gVoiceReplyPending = true;
  gAssistantPendingVisible = false;
  gVoiceReplyAfterSeq = afterSeq;
  gVoiceReplyPendingMs = millis();
  gVoiceReplyNotifyUntilMs = millis() + 600000U;
  gLastInboxAutoPollMs = 0;
  const String receipt = acknowledgement.isEmpty()
      ? String("Request accepted. The reply will arrive here.") : acknowledgement;
  // Persist the acknowledgement in the conversation before advancing the inbox
  // cursor. Its durable device event can then be ACKed without hiding its text.
  appendAssistantReply(receipt);
  // Do not skip an older final reply that raced this HTTP acknowledgement.
  // The ordered inbox drain advances its cursor when it sees this stored seq.
  rememberStoredAssistantSeq(receiptSeq);
  setFaceMode(FaceMode::Idle);
  setStatus("Sent", 1200);
  showVoiceNotice(receipt, true);
  if (gCanvasSpriteActive) M5Cardputer.Speaker.tone(1047, 90);
  logf("[REQUEST] accepted after_seq=%u receipt_seq=%u mode=%d visible=%d",
       static_cast<unsigned>(afterSeq), static_cast<unsigned>(receiptSeq),
       static_cast<int>(gUiMode), static_cast<int>(gVoiceNoticeVisible));
}

void applyFirmwareJobState(const String& state, const String& requestId) {
  using State = firmware_job_display::State;
  State next = State::Idle;
  if (state == "building") next = State::Building;
  else if (state == "awaiting_input") next = State::AwaitingInput;
  else if (state == "working") next = State::Working;
  else if (state == "completed" || state == "cancelled") next = State::Idle;
  else if (state == "ready") next = State::Ready;
  else if (state == "uncertain") next = State::Unconfirmed;
  else if (state == "attention") next = State::Attention;
  else if (state == "failed") next = State::Failed;
  else if (state == "error") next = State::TaskError;
  else if (state == "stalled") next = State::Stalled;
  else if (state != "idle") return;
  if (next != gFirmwareJobState || requestId != gFirmwareJobRequestId)
    logf("[FIRMWARE_JOB] state=%s request=%s", state.c_str(), requestId.c_str());
  gFirmwareJobState = next;
  gFirmwareJobRequestId = requestId;
  gFirmwareJobLastSyncMs = millis();
  gBridgeLastSuccessMs = millis();
  gBridgeHttpFailed = false;
}

const char* homeStatusLabel(bool updateReady) {
  if (gG0VoicePending || gVoiceCapturePreparing) return "LOADING";
  if (gSubmitting || gThinking || voiceRequestBusyUi()) return "THINKING";
  if (gVoiceReplySpeechBusy || !gQueuedVoiceReplySpeech.isEmpty()) return "LOADING";
  // Voice/Realtime can intentionally pause polling for minutes. An old job
  // timestamp alone is not evidence that the Bridge connection has failed.
  const bool linkFailed = !gWifiReady || (gBridgeHttpFailed && autoInboxPollAllowed());
  const char* label=firmware_job_display::label(gFirmwareJobState, updateReady,
      millis() - gBridgeLastSuccessMs, linkFailed);
  if (strcmp(label,"CHECK CHAT")==0) return gInboxUnread ? "NEW MESSAGE" : "READY";
  if (strcmp(label,"READY")==0 && gInboxUnread) return "NEW MESSAGE";
  return label;
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
  gVoiceNoticeVisible = !gLauncherVisible && !gChatCommandsVisible &&
      gUiMode!=UiMode::ChatFull && gUiMode!=UiMode::ChatFace;
  render();
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
  else if(gSubmitting || gThinking || gVoiceRequestPhase==VoiceRequestPhase::Sending ||
          gVoiceRequestPhase==VoiceRequestPhase::Processing){setStatus("Sending - please wait",900);return true;}
  dismissVoiceNotice();
  gAssistantPendingVisible=false;
  setFaceMode(FaceMode::Idle);
  if(gPlaybackActive){stopPlaybackStream();gPlaybackActive=false;}
  setUiMode(UiMode::Home);
  setStatus("Ready",1000);
  return true;
}

void openAssistantConversation() {
  // Navigation uses the reply already stored locally. Do not fetch history,
  // play audio, submit a draft or cancel a pending request/TTS preparation.
  gVoiceNoticeVisible = false;
  if (!gSubmitting && !gThinking && gVoiceRequestPhase != VoiceRequestPhase::Sending &&
      gVoiceRequestPhase != VoiceRequestPhase::Processing) gVoiceRequestPhase = VoiceRequestPhase::None;
  gInboxUnread = false;
  gChatScrollOffset = 0;
  setUiMode(UiMode::ChatFull);
  gUiFramePolicy.invalidate();
  gLastRenderMs = 0;
  logf("[VOICE_UI] open-chat local pending=%d", static_cast<int>(gVoiceReplyPending));
}

bool handleUnreadAssistantKey(char key, const Keyboard_Class::KeysState& keys) {
  if (!gInboxUnread || !isAssistantUi() || gLauncherVisible || gChatCommandsVisible ||
      keys.ctrl || keys.alt || keys.fn || !(keys.enter || key == '\r' || key == '\n') ||
      gRecording || gG0VoicePending || gVoiceCapturePreparing || gRealtimeActive || gRealtimeExclusiveMode)
    return false;
  if ((gUiMode == UiMode::ChatFull || gUiMode == UiMode::ChatFace) && !gInputBuffer.isEmpty()) return false;
  openAssistantConversation();
  return true;
}

bool handleVoiceNoticeKey(char key, const Keyboard_Class::KeysState& keys) {
  if (!gVoiceNoticeVisible || !isAssistantUi()) return false;
  if(gVoiceRequestPhase==VoiceRequestPhase::Recording && keys.ctrl &&
      (key=='v'||key=='V')) return false;
  if (!gRecording && !gVoiceCapturePreparing && (keys.enter || key == '\r' || key == '\n')) {
    openAssistantConversation();
    return true;
  }
  if(gVoiceRequestPhase==VoiceRequestPhase::Recording || gVoiceRequestPhase==VoiceRequestPhase::Sending ||
     gVoiceRequestPhase==VoiceRequestPhase::Processing || gSubmitting || gThinking) return true;
  return true;
}

bool voiceRequestBusyUi() {
  return gVoiceNoticeVisible && isAssistantUi() && !gRealtimeActive &&
      (gRecording || gSubmitting || gThinking ||
       gVoiceRequestPhase==VoiceRequestPhase::Recording ||
       gVoiceRequestPhase==VoiceRequestPhase::Sending ||
       gVoiceRequestPhase==VoiceRequestPhase::Processing);
}

void renderVoiceNotice() {
  if (!gVoiceNoticeVisible || gLauncherVisible || gChatCommandsVisible ||
      !isAssistantUi() || voiceRequestBusyUi() || gRealtimeActive) return;
  auto& d = gCanvas;
  const uint16_t panel = rgb565_local(9, 27, 42);
  const bool error=gVoiceRequestPhase==VoiceRequestPhase::Error;
  const uint16_t accent = error ? rgb565_local(255,96,80) : gVoiceNoticePending ? rgb565_local(255,136,64) : rgb565_local(105, 255, 156);
  d.setFont(&fonts::efontCN_12);
  auto lines = wrapText(gVoiceNoticeText, 212);
  const int count = min<int>(6, lines.size());
  const int height = max<int>(80, 38 + count * 14);
  // The first frame must already contain readable feedback. A slide-in that
  // starts above the display can freeze there while TLS borrows the canvas.
  const int y = 4;
  d.fillRoundRect(4, y, 232, height, 12, panel);
  d.drawRoundRect(4, y, 232, height, 12, accent);
  d.setFont(&fonts::Font2);
  d.setTextColor(accent, panel);
  d.setCursor(14, y + 5);
  d.print(error ? "Check delivery" : gVoiceNoticePending ? "Request accepted" : "AI Agent");
  d.setFont(&fonts::efontCN_12);
  d.setTextColor(TFT_WHITE, panel);
  for (int i = 0; i < count; ++i) {
    d.setCursor(14, y + 25 + i * 14);
    d.print(fitCurrentFontToWidth(lines[i], 212));
  }
  d.setFont(&fonts::Font0);
  d.setTextColor(rgb565_local(147, 173, 192), panel);
  d.setCursor(14, y + height - 10);
  d.print(lines.size() > 6 ? "Enter read more   Esc OK" : "Enter chat       Esc OK");
}

struct VoiceSpeechPayload {
  String url, token, body, path;
  String host, requestPath;
  uint16_t port = 443;
  std::unique_ptr<WiFiClient> connection;
  fs::FS* fs = nullptr;
  fs::FS* fallbackFs = nullptr;
  size_t maxBytes = 4 * 1024 * 1024;
  uint32_t generation = 0;
};
struct VoiceSpeechResult {
  String path;
  fs::FS* fs = nullptr;
  uint32_t generation = 0, sampleRate = kTtsDefaultSampleRate;
  uint32_t startedMs = 0, headersMs = 0, finishedMs = 0;
  size_t bytes = 0;
  int code = 0;
  bool ok = false;
  bool keptSocket = false, retriedSocket = false;
};
portMUX_TYPE gVoiceSpeechMux = portMUX_INITIALIZER_UNLOCKED;
VoiceSpeechResult* gVoiceSpeechResult = nullptr;
volatile bool gVoiceSpeechAllocationFailed = false;

VoiceSpeechResult* performVoiceReplySpeech(void* arg) {
  std::unique_ptr<VoiceSpeechPayload> payload(static_cast<VoiceSpeechPayload*>(arg));
  std::unique_ptr<VoiceSpeechResult> result(new (std::nothrow) VoiceSpeechResult());
  if (!result) return nullptr;
  result->path = payload->path; result->fs = payload->fs; result->generation = payload->generation;
  result->startedMs = millis();
  // The HTTP object must die before its externally owned client, including
  // cancellation between begin() and POST().
  std::unique_ptr<WiFiClient> connection = std::move(payload->connection);
  const bool keptSocket = connection != nullptr;
  result->keptSocket = keptSocket;
  std::unique_ptr<uint8_t[]> buffer(new (std::nothrow) uint8_t[4096]);
  for (unsigned attempt = 0; attempt < (keptSocket ? 2U : 1U); ++attempt) {
    // The preceding iteration's HTTP destructor may still call stop() even
    // after end() on a closed socket. Dispose it only after that scope ends.
    if (attempt != 0) connection.reset();
    HTTPClient http;
    http.setConnectTimeout(4000); http.setTimeout(20000); http.setReuse(false);
    bool opened = false;
    if (buffer && payload->fs && WiFi.status() == WL_CONNECTED) {
      if (!connection) {
        if (payload->url.startsWith("https://")) {
          auto* secure = new (std::nothrow) WiFiClientSecure();
          if (secure) { secure->setCACert(kTlsRootCaPem); secure->setHandshakeTimeout(12); }
          connection.reset(secure);
        } else connection.reset(new (std::nothrow) WiFiClient());
      }
      // begin(client, url) treats its initially empty _host as an origin
      // switch and stops an already connected client. The explicit-origin
      // overload preserves the same-origin socket handed off by voice POST.
      if (connection) opened = http.begin(*connection, payload->host, payload->port,
                                          payload->requestPath, payload->url.startsWith("https://"));
    }
    const char* headers[] = {"X-Audio-Sample-Rate"};
    http.collectHeaders(headers, 1);
    if (!opened || payload->generation != gVoiceReplySpeechGeneration) break;
    http.addHeader("Content-Type", "application/json");
    if (!payload->token.isEmpty()) http.addHeader("Authorization", "Bearer " + payload->token);
    result->code = http.POST(payload->body);
    result->headersMs = millis();
    if (result->code < 0 && keptSocket && attempt == 0 &&
        payload->generation == gVoiceReplySpeechGeneration) {
      // Only stateless speech synthesis may retry a stale keep-alive socket.
      // The user's original voice/agent request is never sent a second time.
      http.end();
      result->retriedSocket = true;
      continue;
    }
    if (result->code == 200 && payload->generation == gVoiceReplySpeechGeneration) {
      const uint32_t rate = http.header("X-Audio-Sample-Rate").toInt();
      if (rate >= 8000 && rate <= 48000) result->sampleRate = rate;
      const int expected = http.getSize();
      size_t maxBytes=payload->maxBytes;
      if(expected>static_cast<int>(maxBytes) && payload->fallbackFs) {
        result->fs=payload->fallbackFs;
        maxBytes=4*1024*1024;
      }
      if (expected > 0 && expected <= static_cast<int>(maxBytes)) {
        File output = result->fs->open(payload->path, "w");
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
          if (got <= 0 || writeRecordedBytes(output,buffer.get(),got) != static_cast<size_t>(got)) break;
          result->bytes += got;
          delay(1);
        }
        output.flush();
        const bool stored=output.size()==result->bytes;
        output.close();
        result->ok = payload->generation == gVoiceReplySpeechGeneration && result->bytes > 0 &&
                     stored && !(result->bytes & 1) && result->bytes == static_cast<size_t>(expected);
      }
    }
    http.end();
    break;
  }
  if (!result->ok && result->fs) fsRemove(*result->fs, result->path);
  result->finishedMs = millis();
  return result.release(); // TLS, HTTP and file destructors finish before publication.
}

void voiceReplySpeechTask(void* arg) {
  VoiceSpeechResult* result = performVoiceReplySpeech(arg);
  logf("[VOICE_TTS] worker_stack_free=%u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
  portENTER_CRITICAL(&gVoiceSpeechMux);
  gVoiceSpeechResult = result; gVoiceSpeechAllocationFailed = result == nullptr;
  portEXIT_CRITICAL(&gVoiceSpeechMux);
  vTaskDelete(nullptr);
}

bool voiceReplyFeedbackReady() {
  // Never tear down the speaker while it still owns the notification tone.
  return gCanvasSpriteActive && !M5Cardputer.Speaker.isPlaying();
}

fs::FS* voiceReplyStorage(size_t& maxBytes) {
  maxBytes=4*1024*1024;
  if(gLittleFsReady) {
    const uint64_t total=LittleFS.totalBytes(),used=LittleFS.usedBytes();
    const uint64_t free=total>used?total-used:0;
    constexpr size_t reserve=64*1024;
    if(free>=reserve+256*1024 && ensureVoiceStorageOn(LittleFS)) {
      maxBytes=min<uint64_t>(maxBytes,free-reserve);
      return &LittleFS;
    }
  }
  return activeVoiceFs();
}

void serviceVoiceReplySpeech() {
  gVoiceReplyConnection.expire(millis());
  if (gQueuedVoiceReplySpeech.isEmpty() && !gSubmitting && !gThinking)
    gVoiceReplyConnection.clear();
  VoiceSpeechResult* completed = nullptr;
  portENTER_CRITICAL(&gVoiceSpeechMux);
  completed = gVoiceSpeechResult; gVoiceSpeechResult = nullptr;
  portEXIT_CRITICAL(&gVoiceSpeechMux);
  if (completed) {
    std::unique_ptr<VoiceSpeechResult> result(completed);
    gVoiceReplySpeechBusy = false;
    if (result->code > 0) gNetworkRecovery.success();
    if (gVoiceSpeechCanvasReleased) { restoreUiCanvasAfterNetwork(); gVoiceSpeechCanvasReleased = false; }
    initSpeaker();
    const bool current = result->generation == gVoiceReplySpeechGeneration;
    const bool play = result->ok && current && !gRecording && !gRealtimeActive && !gPlaybackActive;
    bool started = play && startPlaybackStreamFromRawPcmFile(result->path, result->sampleRate, result->bytes, "voice reply",result->fs);
    logf("[VOICE][LAT] speech_http start=%u headers=%u done=%u playback_request=%u started=%d",
         static_cast<unsigned>(result->startedMs), static_cast<unsigned>(result->headersMs),
         static_cast<unsigned>(result->finishedMs), static_cast<unsigned>(millis()), started);
    if (!started && result->fs) fsRemove(*result->fs, result->path);
    logf("[VOICE_TTS] code=%d bytes=%u playback=%d current=%d storage=%s kept_socket=%d retry=%d", result->code,
         static_cast<unsigned>(result->bytes), started, current,result->fs==&LittleFS?"flash":"sd",
         result->keptSocket, result->retriedSocket);
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
  if (!voiceReplyFeedbackReady()) return; // Finish the tone and recover the canvas first.
  render();
  gLastRenderMs=millis();
  std::unique_ptr<VoiceSpeechPayload> payload(new (std::nothrow) VoiceSpeechPayload());
  if (!payload) { gQueuedVoiceReplySpeech = ""; return; }
  payload->fs = voiceReplyStorage(payload->maxBytes);
  if(payload->fs==&LittleFS && gSdReady) payload->fallbackFs=&SD;
  if (!payload->fs || !gWifiReady) { gQueuedVoiceReplySpeech = ""; return; }
  payload->url = hubBaseUrl() + kDeviceTtsPath; payload->token = gDeviceToken;
  payload->host = gHubHost; payload->port = gHubPort; payload->requestPath = kDeviceTtsPath;
  payload->connection = gVoiceReplyConnection.take(gHubHost.c_str(), gHubPort, millis());
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
  const bool flashStorage=payload->fs==&LittleFS;
  const size_t storageLimit=payload->maxBytes;
  VoiceSpeechPayload* raw = payload.release();
  logf("[VOICE][LAT] speech_dispatch t=%u", static_cast<unsigned>(millis()));
  // A retained TLS client can leave only 12 KB contiguous. The HTTP worker
  // uses heap buffers; match the 8 KB stack of the other verified HTTP owner.
  if (xTaskCreate(voiceReplySpeechTask, "voice-tts", 8192, raw, 1, nullptr) != pdPASS) {
    logf("[VOICE_TTS] task allocation failed free=%u largest=%u",
         static_cast<unsigned>(ESP.getFreeHeap()),
         static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    delete raw; gVoiceReplySpeechBusy = false;
    if (gVoiceSpeechCanvasReleased) { restoreUiCanvasAfterNetwork(); gVoiceSpeechCanvasReleased = false; }
    initSpeaker(); setStatus("Reply text ready; voice memory low", 2500);
  } else logf("[VOICE_TTS] background start generation=%u storage=%s limit=%u",
      static_cast<unsigned>(gVoiceReplySpeechGeneration),flashStorage?"flash":"sd",
      static_cast<unsigned>(storageLimit));
}
struct VoiceDialPayload {
  String host, streamHeaders;
  std::shared_ptr<VoiceCaptureUpload> capture;
  uint16_t port=443; bool tls=true; uint32_t generation=0;
};
struct VoiceDialResult {
  std::unique_ptr<WiFiClient> socket;
  uint32_t generation=0;
  bool streamed=false;
  bool earlyReply=false;
};
portMUX_TYPE gVoiceDialMux = portMUX_INITIALIZER_UNLOCKED;
VoiceDialResult* gVoiceDialResult = nullptr;
volatile bool gVoiceDialAllocationFailed = false;
uint32_t gVoiceDialGeneration = 0;
std::unique_ptr<WiFiClient> gVoiceReadySocket;

bool streamVoiceCapture(WiFiClient& client, VoiceCaptureUpload& capture, const String& headers) {
  File finalizedFile;
  client.setTimeout(3); // Seconds on both pinned Arduino WiFi client classes.
  size_t sentHeaders = 0;
  while (sentHeaders < headers.length() && !capture.stream.cancelled.load() && client.connected()) {
    const size_t n = client.write(reinterpret_cast<const uint8_t*>(headers.c_str()) + sentHeaders,
                                  headers.length() - sentHeaders);
    if (!n) return false;
    sentHeaders += n;
  }
  if (sentHeaders != headers.length()) return false;
  const bool ok = capture_upload::sendBody(client, capture.stream,
      [&](size_t offset, uint8_t* bytes, size_t count) -> size_t {
        std::lock_guard<std::mutex> lock(capture.fileMutex);
        if (capture.stream.cancelled.load() || !capture.fs) return 0;
        if (capture.activeFile && *capture.activeFile) {
          File& file = *capture.activeFile;
          const size_t position = file.position();
          const bool seeked = file.seek(44U + offset);
          const int read = seeked ? file.read(bytes, count) : -1;
          const bool restored = file.seek(position);
          if (!restored) capture.stream.storageFailed.store(true);
          return restored && read == static_cast<int>(count) ? count : 0;
        }
        // Keep one read handle only after a valid release has finalized the
        // original. Cancellation during live capture never pins a deleted file.
        if (capture.stream.finished.load()) {
          if (!finalizedFile) finalizedFile = capture.fs->open(capture.path, "r");
          const bool seeked = finalizedFile && finalizedFile.seek(44U + offset);
          const int read = seeked ? finalizedFile.read(bytes, count) : -1;
          return read == static_cast<int>(count) ? count : 0;
        }
        File file = capture.fs->open(capture.path, "r");
        const bool seeked = file && file.seek(44U + offset);
        const int read = seeked ? file.read(bytes, count) : -1;
        file.close();
        return read == static_cast<int>(count) ? count : 0;
      }, [] { delay(2); }, [] { return static_cast<uint32_t>(millis()); },
      kMaxRecordSamples * sizeof(int16_t), static_cast<uint32_t>(kMaxRecordSeconds * 1000) + 17000U);
  {
    std::lock_guard<std::mutex> lock(capture.fileMutex);
    finalizedFile.close();
  }
  logf("[VOICE_STREAM] complete=%d sent=%u first_sent_ms=%u commit=%d", ok,
       static_cast<unsigned>(capture.stream.sent.load()),
       static_cast<unsigned>(capture.stream.firstSentMs.load()), capture.stream.commitAttempted.load());
  if (ok) client.setTimeout((kTurnHttpTimeoutMs + 999) / 1000);
  return ok;
}

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
  if (payload->capture) {
    result->streamed = result->socket && streamVoiceCapture(*result->socket, *payload->capture, payload->streamHeaders);
    if (!result->streamed) {
      payload->capture->stream.cancelled.store(true);
      result->earlyReply = payload->capture->stream.responseAvailable.load();
      if (!result->earlyReply) result->socket.reset();
      // Preserve an early 401/413/429/507 for the normal response parser.
      // An incomplete/uncertain POST is never automatically repeated.
    }
  }
  return result.release();
}
void voicePreconnectTask(void* arg) {
  VoiceDialResult* result = performVoicePreconnect(arg);
  logf("[VOICE] TLS worker_stack_free=%u", static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
  portENTER_CRITICAL(&gVoiceDialMux);
  gVoiceDialResult = result; gVoiceDialAllocationFailed = result == nullptr;
  portEXIT_CRITICAL(&gVoiceDialMux);
  vTaskDelete(nullptr);
}
void cancelVoicePreconnect() {
  gVoicePreconnectEarly = false;
  gVoiceReadyStreamed = false;
  gVoiceReadyEarlyReply = false;
  if (gVoiceCaptureUpload) gVoiceCaptureUpload->stream.cancelled.store(true);
  gVoiceReplyConnection.clear();
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
    if (current) {
      gVoiceReadySocket = std::move(result->socket);
      gVoiceReadyStreamed = result->streamed;
      gVoiceReadyEarlyReply = result->earlyReply;
    }
    logf("[VOICE] preconnect ready=%d current=%d", static_cast<int>(gVoiceReadySocket != nullptr), current);
  }
  if (gVoiceDialAllocationFailed) { gVoiceDialAllocationFailed = false; gVoiceDialBusy = false; }
  if (!gVoiceDialBusy && gVoiceDialCanvasReleased) {
    restoreUiCanvasAfterNetwork();gVoiceDialCanvasReleased=false;
  }
}
void beginVoicePreconnect() {
  if (gRecording) return; // Capture owns the microphone, UI and SD service budget.
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
  if (xTaskCreate(voicePreconnectTask, "voice-connect", 8192, raw, 1, nullptr) != pdPASS) {
    delete raw; gVoiceDialBusy = false;
    if(gVoiceDialCanvasReleased){restoreUiCanvasAfterNetwork();gVoiceDialCanvasReleased=false;}
  }
}
void publishVoiceCaptureBytes() {
  // Called while the capture file mutex is held, after a successful SD write.
  if (!gVoiceCaptureUpload || gVoiceCaptureUpload->stream.cancelled.load() || !gActiveRecordFile) return;
  auto& state = gVoiceCaptureUpload->stream;
  if (gActiveRecordBytes - state.published.load() < 4096U) return;
  gActiveRecordFile.flush();
  if (gActiveRecordFile.size() == gActiveRecordBytes + 44U) state.published.store(gActiveRecordBytes);
}

void finishVoiceCaptureUpload(size_t bytes) {
  if (!gVoiceCaptureUpload || gVoiceCaptureUpload->stream.cancelled.load() ||
      gVoiceCaptureUpload->stream.storageFailed.load()) return;
  // The original file is already finalized and capture length validated.
  gVoiceCaptureUpload->stream.published.store(bytes);
  gVoiceCaptureUpload->stream.finished.store(true);
  logf("[VOICE_STREAM] release total=%u already_sent=%u first_sent_ms=%u", static_cast<unsigned>(bytes),
       static_cast<unsigned>(gVoiceCaptureUpload->stream.sent.load()),
       static_cast<unsigned>(gVoiceCaptureUpload->stream.firstSentMs.load()));
}

void beginVoiceCaptureUpload() {
  if (!gRecordingToFile || !gActiveRecordFile || !gRecording || gVoiceDialBusy ||
      gInboxHttpBusy || gRealtimeDialBusy || gVoiceReplySpeechBusy || !gWifiReady) return;
  std::shared_ptr<VoiceCaptureUpload> capture(new (std::nothrow) VoiceCaptureUpload());
  std::unique_ptr<VoiceDialPayload> payload(new (std::nothrow) VoiceDialPayload());
  if (!capture || !payload) return; // File-only capture keeps the existing release path.
  capture->fs = activeVoiceFs(); capture->path = gActiveRecordPath;
  capture->activeFile = &gActiveRecordFile;
  capture->turnId = makeClientTurnId("voice");
  gActiveRecordFile.flush();
  capture->stream.published.store(gActiveRecordBytes);
  payload->host = gHubHost; payload->port = gHubPort; payload->tls = hubUsesTls();
  payload->generation = gVoiceDialGeneration; payload->capture = capture;
  String host = gHubHost;
  if ((!payload->tls && gHubPort != 80) || (payload->tls && gHubPort != 443)) host += ":" + String(gHubPort);
  String& headers = payload->streamHeaders;
  headers.reserve(1024);
  headers = String("POST ") + kDeviceAudioTurnRawPath + " HTTP/1.1\r\nHost: " + host +
      "\r\nUser-Agent: S1-ADV/" + kAppVersion +
      "\r\nConnection: keep-alive\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n" +
      "X-Audio-Sample-Rate: " + String(kMicSampleRate) + "\r\nX-Device-Id: " + gDeviceId +
      "\r\nX-Firmware-Version: " + kAppVersion + "\r\nX-Conversation-Key: " + currentConversationKey() +
      "\r\nX-Client-Msg-Id: " + capture->turnId + "\r\nX-Turn-Id: " + capture->turnId +
      "\r\nX-Reply-Audio: false\r\nX-Save-Reply-Audio: false\r\nX-Voice-Wait-Ms: 1000\r\n";
  if (!gDeviceToken.isEmpty()) headers += "Authorization: Bearer " + gDeviceToken + "\r\nX-Device-Token: " + gDeviceToken + "\r\n";
  headers += "\r\n";
  gVoiceCaptureUpload = capture; gVoiceReadyStreamed = false; gVoiceDialBusy = true;
  VoiceDialPayload* raw = payload.release();
  if (xTaskCreate(voicePreconnectTask, "voice-stream", 8192, raw, 1, nullptr) != pdPASS) {
    delete raw; gVoiceDialBusy = false; gVoiceCaptureUpload.reset();
  } else logf("[VOICE_STREAM] background capture started t=%u", static_cast<unsigned>(millis()));
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
