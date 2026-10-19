

bool playLastInboxMessage() {
  if (gInboxLastKind == "voice" && !gInboxLastVoiceUrl.isEmpty()) {
    String url = gInboxLastVoiceUrl;
    if (url.startsWith("/")) {
      url = hubBaseUrl() + url;
    }
    return downloadAndPlayResponseAudio(url, "", gInboxLastVoiceSha256, gInboxLastVoiceSize,
                                        gInboxLastVoiceTitle, gInboxLastText);
  }
  if (!gInboxLastText.isEmpty()) {
    return requestAndPlayTts(gInboxLastText);
  }
  return false;
}

bool handleInboxHistoryItem(JsonObject item, bool forcePlay, bool assistantOnly = false) {
  uint32_t seq = item["seq"] | 0;
  JsonObject sender = item["sender"].as<JsonObject>();
  JsonObject content = item["content"].as<JsonObject>();
  String senderKind = sender["kind"] | "";
  String senderName = sender["display_name"] | "";
  String kind = content["kind"] | "";
  String text = kind == "voice" ? String(content["transcript"] | content["text"] | "")
                                : String(content["text"] | "");
  if (senderKind == "device") {
    return false;
  }
  if (assistantOnly && senderKind != "assistant") {
    return false;
  }
  if (kind == "text" && text.isEmpty()) return false;
  if (!forcePlay && seq != 0 && seq <= gInboxLastSeq) {
    return false;
  }

  if (seq > gInboxLastSeq) gInboxLastSeq = seq;
  if (senderKind == "assistant") {
    gInboxUnread = true;
    if (gVoiceReplyPending && seq > gVoiceReplyAfterSeq) {
      gVoiceReplyPending = false;
      if (!gSubmitting && !gThinking) gAssistantPendingVisible = false;
    }
  }
  gInboxLastText = text;
  gInboxLastFromAssistant = senderKind == "assistant";
  gInboxLastKind = kind;
  gInboxLastSender = senderName.isEmpty() ? senderKind : senderName;
  gInboxLastVoiceUrl = "";
  gInboxLastVoiceTitle = "";
  gInboxLastVoiceSha256 = "";
  gInboxLastVoiceSize = 0;

  String prefix = senderKind == "assistant" ? "AI" : "IN";
  LineKind lineKind = senderKind == "assistant" ? LineKind::Assistant : LineKind::User;
  if (kind == "voice") {
    JsonObject voice = content["voice"].as<JsonObject>();
    gInboxLastVoiceUrl = voice["url"] | "";
    gInboxLastVoiceSha256 = voice["sha256"] | "";
    gInboxLastVoiceSize = voice["bytes"] | voice["size"] | 0;
    String mediaId = voice["media_id"] | "";
    gInboxLastVoiceTitle = mediaId.isEmpty() ? "inbox voice" : ("inbox " + mediaId);
    if (text.isEmpty()) {
      text = "Voice message";
      gInboxLastText = text;
    }
    pushVoiceHistoryLine(prefix, text, lineKind, gInboxLastVoiceUrl, gInboxLastVoiceTitle,
                         gInboxLastVoiceSha256, gInboxLastVoiceSize);
  } else {
    if (text.isEmpty()) {
      return false;
    }
    String visibleText = cleanReplyForDevice(text);
    pushLine(prefix, visibleText.isEmpty() ? text : visibleText, lineKind);
  }

  setStatus("Inbox message", 1200);
  appendRuntimeLog("INBOX", "seq=" + String(seq) + " kind=" + kind + " sender=" + gInboxLastSender, true);
  logf("[INBOX] received seq=%u kind=%s sender=%s text=%s",
       static_cast<unsigned>(seq), kind.c_str(), gInboxLastSender.c_str(), text.c_str());
  return true;
}

bool ackDeviceEvent(const String& eventId) {
  if (eventId.isEmpty() || gHubHost.isEmpty()) {
    return false;
  }
  for (const auto& pending : gInboxAckQueue) if (pending == eventId) return true;
  if (gInboxAckQueue.size() >= 16) return false; // Unacked events remain durable at bridge.
  gInboxAckQueue.push_back(eventId);
  return true;
}

bool inboxInlineActionsAllowed(JsonObject item) {
  const auto permission = item["source"]["actions_allowed"];
  return !permission.is<bool>() || permission.as<bool>();
}

bool applyInboxResponse(String& body, bool forcePlay, bool speak, bool quiet, bool assistantOnly) {
  const bool voiceReplyWasPending = gVoiceReplyPending;
  DynamicJsonDocument doc(8192);
  auto err = deserializeJson(doc, body);
  if (err) {
    if (!quiet) {
      setStatus("Inbox parse failed", 1400);
    }
    logf("[INBOX] parse failed err=%s body_len=%u", err.c_str(), static_cast<unsigned>(body.length()));
    return false;
  }

  if (doc["firmware_job"].is<JsonObject>())
    applyFirmwareJobState(doc["firmware_job"]["state"] | "idle",
                          doc["firmware_job"]["request_id"] | "");
  bool found = false;
  bool firmwareNotice = false;
  bool inlineActionsAllowed = true;
  String eventId = "";
  if (doc["items"].is<JsonArray>()) {
    JsonArray items = doc["items"].as<JsonArray>();
    for (JsonObject event : items) {
      String candidateEventId = String(event["event_id"] | "");
      JsonObject item = event["message"].as<JsonObject>();
      uint32_t seq = item["seq"] | 0;
      // Durable events may be delivered urgent-first. A global sequence
      // watermark cannot prove that an older, still-unacknowledged event was
      // shown. Dedupe by the actual event/receipt, not by that watermark.
      const bool ackQueued = std::find(gInboxAckQueue.begin(), gInboxAckQueue.end(), candidateEventId) != gInboxAckQueue.end();
      if (!candidateEventId.isEmpty() && ackQueued) continue;
      const bool stored = seq && std::find(gStoredAssistantSeqs.begin(), gStoredAssistantSeqs.end(), seq) != gStoredAssistantSeqs.end();
      if (!candidateEventId.isEmpty() && stored) {
        if (ackDeviceEvent(candidateEventId)) consumeStoredAssistantSeq(seq);
        logf("[INBOX] stored reply event seq=%u ACK queued without duplicate", static_cast<unsigned>(seq));
        continue;
      }
      if (handleInboxHistoryItem(item, !candidateEventId.isEmpty(), assistantOnly)) {
        eventId = candidateEventId;
        inlineActionsAllowed = inboxInlineActionsAllowed(item);
        const String transport=item["source"]["transport"] | "";
        firmwareNotice=transport=="cardputer_ota_release" || transport=="cardputer_firmware_job_mirror";
        found = true;
        break;
      }
      // A queued event with a valid id but unusable payload cannot become valid
      // later. Acknowledge it so the following OTA/action can make progress.
      if (!candidateEventId.isEmpty()) {
        bool acked = ackDeviceEvent(candidateEventId);
        logf("[INBOX] rejected event id=%s seq=%u ack=%d",
             candidateEventId.c_str(), static_cast<unsigned>(seq), static_cast<int>(acked));
      }
    }
  } else if (doc["item"].is<JsonObject>()) {
    JsonObject item = doc["item"].as<JsonObject>();
    if (handleInboxHistoryItem(item, forcePlay, assistantOnly)) {
      inlineActionsAllowed = inboxInlineActionsAllowed(item);
      const String transport=item["source"]["transport"] | "";
      firmwareNotice=transport=="cardputer_ota_release" || transport=="cardputer_firmware_job_mirror";
      found = true;
    }
  }
  doc.clear();
  body = "";
  if (found) {
    const bool voiceReplyArrived = voiceReplyWasPending && !gVoiceReplyPending;
    if (voiceReplyArrived || (quiet && !forcePlay && gInboxLastFromAssistant)) {
      if(gVoiceNoticeVisible || (gUiMode!=UiMode::ChatFull && gUiMode!=UiMode::ChatFace))
        showVoiceNotice(gInboxLastText, false);
      if (voiceReplyArrived || static_cast<int32_t>(gVoiceReplyNotifyUntilMs - millis()) > 0)
        gQueuedVoiceReplySpeech = cleanReplyForDevice(gInboxLastText);
      if(firmwareNotice) playUpdateChime();
      else M5Cardputer.Speaker.tone(1319,90);
      setStatus("AI Agent replied",4000);
    }
    if (speak) {
      bool played = playLastInboxMessage();
      logf("[INBOX] playback ok=%d seq=%u", static_cast<int>(played), static_cast<unsigned>(gInboxLastSeq));
    }
    const bool actionOk = inlineActionsAllowed && executeInlineDeviceActionsFromText(gInboxLastText);
    if (actionOk) {
      logf("[INBOX] inline actions executed seq=%u", static_cast<unsigned>(gInboxLastSeq));
    }
    if (!eventId.isEmpty()) {
      ackDeviceEvent(eventId);
    }
    return true;
  }
  if (!quiet) {
    setStatus("No new inbox", 900);
  }
  logf("[INBOX] no new message last_seq=%u", static_cast<unsigned>(gInboxLastSeq));
  return false;
}
bool fetchLatestInboxMessage(bool forcePlay, bool speak, bool quiet, bool assistantOnly) {
  if ((!gWifiReady && !ensureWifiForHttp("inbox", 3000)) || gHubHost.isEmpty()) {
    if (!quiet) {
      setStatus("Inbox offline", 1200);
    }
    logf("[INBOX] offline");
    return false;
  }
  // Drain a bounded batch so an already-seen or malformed event cannot remain
  // at the head of the queue forever and hide a later OTA/device action.
  String url = hubBaseUrl() + "/api/cardputer/device-events/pending?limit=10&text_chars=1024";
  if (assistantOnly) {
    url += "&sender_kind=assistant";
  }
  HTTPClient http;
  std::unique_ptr<WiFiClientSecure> secureClient;
  uint32_t inboxTimeoutMs = quiet ? 4000 : 15000;
  if (!configureHttpClient(http, secureClient, url, inboxTimeoutMs)) {
    if (!quiet) {
      setStatus("Inbox connect failed", 1200);
    }
    logf("[INBOX] connect failed");
    return false;
  }
  if (!gDeviceToken.isEmpty()) {
    http.addHeader("Authorization", "Bearer " + gDeviceToken);
  }
  int code = http.GET();
  String body = code > 0 ? http.getString() : "";
  http.end();
  if (code < 200 || code >= 300) {
    if (!quiet) {
      setStatus("Inbox HTTP " + String(code), 1400);
    }
    logf("[INBOX] http=%d body=%s", code, body.c_str());
    return false;
  }
  return applyInboxResponse(body, forcePlay, speak, quiet, assistantOnly);
}

bool autoInboxPollAllowed() {
  return gWifiReady && !gHubHost.isEmpty() && !gOtaApplyInProgress && !gTransferUiActive &&
         appAllowsBackgroundNetwork() &&
         !gBootBackgroundActive && !gG0VoicePending && !gRecording && !gSubmitting && !gThinking && !gPlaybackActive && !gVoiceReplySpeechBusy && gQueuedVoiceReplySpeech.isEmpty() && !gVoiceDialBusy &&
         !gRealtimeDialBusy && !gPendingRealtimeStart && !gRealtimeActive && !gRealtimeConnected && !gRealtimeRecording && !gRealtimeAwaiting &&
         !gRealtimeSmokeActive && !gRealtimeSmokeAudioStreaming && gTextTurnTaskHandle == nullptr &&
         gCompletedTextTurn == nullptr && gActiveTextTurn.isEmpty() && gPendingTextTurns.empty();
}

InboxHttpResult* performInboxHttpRequest(void* arg) {
  std::unique_ptr<InboxHttpPayload> request(static_cast<InboxHttpPayload*>(arg));
  std::unique_ptr<InboxHttpResult> result(new (std::nothrow) InboxHttpResult());
  if (!result) return nullptr;
  result->eventId = request->eventId;
  result->otaManifest = request->otaManifest;
  result->applyAfter = request->applyAfter;
  result->announce = request->announce;
  result->logsUpload = request->logsUpload;
  HTTPClient http;
  std::unique_ptr<WiFiClientSecure> secure;
  http.setConnectTimeout(2500);
  http.setTimeout(4000);
  http.setReuse(false);
  bool opened = false;
  if (WiFi.status() == WL_CONNECTED) {
    if (request->url.startsWith("https://")) {
      secure.reset(new WiFiClientSecure());
      configureSecureClient(*secure);
      secure->setHandshakeTimeout(6);
      opened = http.begin(*secure, request->url);
    } else opened = http.begin(request->url);
  }
  if (opened && !gInboxCancelRequested) {
    if (!request->token.isEmpty()) http.addHeader("Authorization", "Bearer " + request->token);
    if (request->logsUpload) {
      http.addHeader("Content-Type", "application/json");
      result->code = http.POST(request->body);
    } else if (request->eventId.isEmpty()) {
      result->code = http.GET();
      if (result->code >= 200 && result->code < 300) result->body = http.getString();
    } else {
      DynamicJsonDocument doc(256);
      doc["event_id"] = request->eventId;
      String body; serializeJson(doc, body);
      http.addHeader("Content-Type", "application/json");
      result->code = http.POST(body);
    }
    http.end();
  }
  return result.release();
}

void inboxHttpTask(void* arg) {
  InboxHttpResult* completed=performInboxHttpRequest(arg);
  portENTER_CRITICAL(&gInboxHttpMux);
  gInboxHttpResult = completed;
  gInboxAllocationFailed = completed == nullptr;
  portEXIT_CRITICAL(&gInboxHttpMux);
  vTaskDelete(nullptr);
}

void serviceInboxNetworkCompletion() {
  if (gRecording || gSubmitting || gPlaybackActive || gTransferUiActive) return;
  InboxHttpResult* completed = nullptr;
  portENTER_CRITICAL(&gInboxHttpMux);
  completed = gInboxHttpResult;
  gInboxHttpResult = nullptr;
  portEXIT_CRITICAL(&gInboxHttpMux);
  if (!completed) {
    if(gInboxAllocationFailed) {
      gInboxAllocationFailed=false; gInboxHttpBusy=false; gInboxRetryAfterMs=millis()+10000;
      if (gLogsUploadBusy) {gLogsUploadBusy=false;setStatus("Logs memory failure",1800);}
      if (gInboxCanvasReleased) { restoreUiCanvasAfterNetwork(); gInboxCanvasReleased=false; }
    }
    return;
  }
  std::unique_ptr<InboxHttpResult> result(completed);
  gInboxHttpBusy = false;
  if (result->logsUpload) gLogsUploadBusy=false;
  const bool cancelled = gInboxCancelRequested;
  gInboxCancelRequested = false;
  if (gInboxCanvasReleased) { restoreUiCanvasAfterNetwork(); gInboxCanvasReleased = false; }
  if (result->code > 0) gNetworkRecovery.success(); // Any HTTP response proves transport progress.
  if (result->code >= 200 && result->code < 300) {
    gBridgeLastSuccessMs = millis();
    gBridgeHttpFailed = false;
  } else if (!cancelled) {
    gBridgeHttpFailed = true;
    if (result->code <= 0) gNetworkRecovery.failure(millis());
  }
  if (cancelled) {
    if(result->logsUpload) setStatus("Logs interrupted; U retry",1800);
    logf("[INBOX] poll yielded to input"); return;
  }
  if (result->code < 200 || result->code >= 300) {
    gInboxRetryAfterMs=millis()+4000;
    logf("[INBOX] background HTTP %d",result->code);
  }
  if (result->logsUpload) {
    const bool ok=result->code>=200 && result->code<300;
    setStatus(ok ? "Logs uploaded" : "Logs HTTP " + String(result->code),2000);
    setHttpDiag(ok ? "logs: ok" : "logs: HTTP " + String(result->code));
    appendRuntimeLog("LOG",ok ? "upload ok" : "upload failed HTTP " + String(result->code),true);
    logf("[LOG_UPLOAD] complete http=%d ok=%d",result->code,static_cast<int>(ok));
  } else if (!result->eventId.isEmpty()) {
    if (result->code >= 200 && result->code < 300 && !gInboxAckQueue.empty() &&
        gInboxAckQueue.front() == result->eventId) gInboxAckQueue.pop_front();
    else gLastInboxAutoPollMs = millis(); // Retry later, never spin on a failed ACK.
  } else if (result->otaManifest) {
    const bool ok = result->code >= 200 && result->code < 300 && applyRemoteOtaManifestBody(result->body);
    logf("[OTA_AUTO] complete http=%d ok=%d elapsed_ms=%u", result->code, static_cast<int>(ok),
         static_cast<unsigned>(millis() - gOtaLastAutoCheckMs));
    if (result->announce) setStatus(ok ? (homeFirmwareUpdateAvailable() ?
        "New update: Ctrl+U" : "Firmware is current") : "Update check failed", 2200);
    if (result->applyAfter) {
      if (ok && homeFirmwareUpdateAvailable()) {
        gPendingOtaApplyAction = true;
        gPendingOtaActionAfterMs = millis() + 100;
      } else {
        setUiMode(UiMode::Home);
        setStatus(ok ? "Firmware is current" : "Update check failed", 2200);
      }
    }
  } else if (result->code >= 200 && result->code < 300) {
    applyInboxResponse(result->body, false, false, true, true);
  }
}

bool startInboxNetworkRequest(std::unique_ptr<InboxHttpPayload> payload) {
  if (gInboxHttpBusy) return false;
  gInboxCancelRequested = false;
  // Background HTTP never borrows the framebuffer. Repainting directly to
  // TFT during a TLS loan exposes partial gray frames on Home and menus.
  prepareNetworkMemory("inbox", false);
  clearEmojiCache();
  // Polling is silent: retain the speaker's DMA/amp state to avoid periodic clicks.
  gLastInboxAutoPollMs = millis();
  gInboxHttpBusy = true;
  InboxHttpPayload* raw = payload.release();
  if (xTaskCreate(inboxHttpTask, "inbox-http", 8192, raw, 1, nullptr) != pdPASS) {
    delete raw;
    gInboxHttpBusy = false;
    if (gInboxCanvasReleased) { restoreUiCanvasAfterNetwork(); gInboxCanvasReleased = false; }
    return false;
  }
  return true;
}

bool startBackgroundManifestCheck(bool applyAfter, bool announce) {
  if (gInboxHttpBusy) return false;
  std::unique_ptr<InboxHttpPayload> payload(new (std::nothrow) InboxHttpPayload());
  if (!payload) return false;
  payload->token = gDeviceToken;
  payload->url = hubBaseUrl() + kFirmwareManifestFetchPath;
  payload->otaManifest = true;
  payload->applyAfter = applyAfter;
  payload->announce = announce;
  if (!startInboxNetworkRequest(std::move(payload))) {
    gInboxRetryAfterMs = millis() + 4000U;
    return false;
  }
  gOtaLastAutoCheckMs = millis();
  logf("[OTA_AUTO] GET at_ms=%u interval_ms=%u apply=%d", static_cast<unsigned>(millis()),
       gUiMode == UiMode::Ota ? kOtaScreenCheckIntervalMs : kOtaAutoCheckIntervalMs,
       static_cast<int>(applyAfter));
  return true;
}

void serviceAutoInboxPoll() {
  uint32_t now = millis();
  if (gInboxHttpBusy || (now < 30000U && gUiMode != UiMode::Ota) ||
      now - gLastUserInputMs < 1000U || !autoInboxPollAllowed()) return;
  if (gVoiceReplyPending && now - gVoiceReplyPendingMs > 300000U) gVoiceReplyPending = false;
  const uint32_t otaInterval = gUiMode == UiMode::Ota ? kOtaScreenCheckIntervalMs : kOtaAutoCheckIntervalMs;
  const bool otaDue = now - gOtaLastAutoCheckMs >= otaInterval &&
                      !gPendingOtaCheckAction && !gPendingOtaApplyAction;
  const uint32_t interval = !gInboxAckQueue.empty() ? 250U : (gVoiceReplyPending ? 4000U : kInboxAutoPollIntervalMs);
  if (gInboxRetryAfterMs && static_cast<int32_t>(now-gInboxRetryAfterMs)<0) return;
  // A retained ACK must never starve release discovery. Keep the ACK queued
  // and let the same worker retry it after this bounded manifest request.
  if (otaDue) {
    startBackgroundManifestCheck(false, false);
    return;
  }
  // An idle draft can defer incoming chat, but it is not active network work
  // and must not prevent release checks or already-queued acknowledgements.
  if (gInboxAckQueue.empty() && !gInputBuffer.isEmpty()) return;
  if (!otaDue && gLastInboxAutoPollMs && now - gLastInboxAutoPollMs < interval) return;
  std::unique_ptr<InboxHttpPayload> payload(new (std::nothrow) InboxHttpPayload());
  if (!payload) { gInboxRetryAfterMs = now + 4000U; return; }
  payload->token = gDeviceToken;
  if (!gInboxAckQueue.empty()) {
    payload->eventId = gInboxAckQueue.front();
    payload->url = hubBaseUrl() + "/api/cardputer/device-events/ack";
  } else {
    payload->url = hubBaseUrl() + "/api/cardputer/device-events/pending?limit=2&text_chars=1024&sender_kind=assistant&firmware_version=" + String(kAppVersion) + "&firmware_git=" + String(kBuildGitSha);
  }
  startInboxNetworkRequest(std::move(payload));
}

bool injectInboxText(const String& text, bool speakAfter) {
  String bodyText = text;
  bodyText.trim();
  if (bodyText.isEmpty()) {
    logf("[INBOX] inject empty");
    return false;
  }
  if ((!gWifiReady && !ensureWifiForHttp("inbox-inject", 3000)) || gHubHost.isEmpty()) {
    setStatus("Inject offline", 1200);
    logf("[INBOX] inject offline");
    return false;
  }
  String topicKey = currentConversationKey();
  String url = hubBaseUrl() + "/api/cardputer/v1/topics/" + urlEncodePathSegment(topicKey) + "/inbox/inject";
  HTTPClient http;
  std::unique_ptr<WiFiClientSecure> secureClient;
  if (!configureHttpClient(http, secureClient, url, 15000)) {
    setStatus("Inject connect failed", 1200);
    logf("[INBOX] inject connect failed");
    return false;
  }
  DynamicJsonDocument doc(1024);
  doc["text"] = bodyText;
  doc["sender_kind"] = "human";
  doc["sender_name"] = "Serial smoke";
  doc["source"] = "cardputer_serial_inject";
  String payload;
  serializeJson(doc, payload);
  http.addHeader("Content-Type", "application/json");
  if (!gDeviceToken.isEmpty()) {
    http.addHeader("Authorization", "Bearer " + gDeviceToken);
  }
  int code = http.POST(payload);
  String response = code > 0 ? http.getString() : "";
  http.end();
  if (code < 200 || code >= 300) {
    setStatus("Inject HTTP " + String(code), 1400);
    logf("[INBOX] inject http=%d body=%s", code, response.c_str());
    return false;
  }
  logf("[INBOX] inject ok chars=%d", bodyText.length());
  return fetchLatestInboxMessage(true, speakAfter);
}

bool saveVoiceNoteMetadata(const VoiceNote& note) {
  fs::FS* fs = activeVoiceFs();
  if (!fs) {
    return false;
  }
  DynamicJsonDocument doc(768);
  doc["id"] = note.id;
  doc["audio_path"] = note.audioPath;
  doc["title"] = note.title;
  doc["preview"] = note.preview;
  doc["sample_rate"] = note.sampleRate;
  doc["duration_ms"] = note.durationMs;
  doc["assistant"] = note.assistant;

  File meta = fs->open(note.metaPath, "w");
  if (!meta) {
    return false;
  }
  serializeJson(doc, meta);
  meta.close();
  return true;
}

bool persistWavFile(const String& path, const uint8_t* header, size_t headerLen, const uint8_t* audioBytes,
                    size_t audioLen) {
  fs::FS* fs = activeVoiceFs();
  if (!gStorageReady || !ensureVoiceStorage()) {
    return false;
  }
  File file = fs->open(path, "w");
  if (!file) {
    return false;
  }
  size_t writtenHeader = file.write(header, headerLen);
  size_t writtenBody = file.write(audioBytes, audioLen);
  file.close();
  return writtenHeader == headerLen && writtenBody == audioLen;
}

bool persistFileToFile(File& src, File& dst, size_t bytesToCopy) {
  uint8_t buffer[1024];
  size_t copied = 0;
  while (copied < bytesToCopy) {
    size_t chunk = bytesToCopy - copied;
    if (chunk > sizeof(buffer)) {
      chunk = sizeof(buffer);
    }
    size_t readBytes = src.read(buffer, chunk);
    if (readBytes == 0) {
      return false;
    }
    size_t written = dst.write(buffer, readBytes);
    if (written != readBytes) {
      return false;
    }
    copied += readBytes;
  }
  return copied == bytesToCopy;
}

bool persistWavFromPcmFile(const String& outPath, const String& pcmPath, uint32_t sampleRate, size_t audioLen) {
  fs::FS* fs = activeVoiceFs();
  if (!gStorageReady || !ensureVoiceStorage()) {
    return false;
  }
  File src = fs->open(pcmPath, "r");
  if (!src) {
    return false;
  }
  File dst = fs->open(outPath, "w");
  if (!dst) {
    src.close();
    return false;
  }

  uint8_t header[44];
  writeWavHeader(header, static_cast<uint32_t>(audioLen), sampleRate);
  bool ok = dst.write(header, sizeof(header)) == sizeof(header) && persistFileToFile(src, dst, audioLen);
  src.close();
  dst.close();
  if (!ok) {
    fsRemove(*fs, outPath);
  }
  return ok;
}

void rememberVoiceNote(const String& title, const String& preview, const uint8_t* header, size_t headerLen,
                       const uint8_t* audioBytes, size_t audioLen, uint32_t sampleRate, bool assistant) {
  fs::FS* fs = activeVoiceFs();
  if (!gStorageReady || !ensureVoiceStorage()) {
    return;
  }
  uint64_t totalBytes = activeStorageTotalBytes();
  uint64_t usedBytes = activeStorageUsedBytes();
  size_t requiredBytes = headerLen + audioLen + 2048;
  if (totalBytes > 0 && usedBytes + requiredBytes >= totalBytes) {
    logf("[VOICE] skip note storage used=%llu total=%llu required=%u",
         static_cast<unsigned long long>(usedBytes),
         static_cast<unsigned long long>(totalBytes),
         static_cast<unsigned>(requiredBytes));
    return;
  }
  VoiceNote note;
  note.id = makeVoiceNoteId(assistant);
  note.audioPath = voiceAudioPath(note.id);
  note.metaPath = voiceMetaPath(note.id);
  note.title = makeVoiceNoteTitle(assistant, audioLen, sampleRate);
  note.preview = trimPreview(preview);
  note.sampleRate = sampleRate;
  note.durationMs = sampleRate ? static_cast<uint32_t>((audioLen / 2U) * 1000ULL / sampleRate) : 0;
  note.assistant = assistant;

  if (!persistWavFile(note.audioPath, header, headerLen, audioBytes, audioLen)) {
    return;
  }
  if (!saveVoiceNoteMetadata(note)) {
    fsRemove(*fs, note.audioPath);
    return;
  }
  gVoiceNotes.push_back(note);
  sortVoiceNotesNewestFirst();
  pruneVoiceNotes();
  gSelectedVoiceNote = 0;
}

void rememberVoiceNoteFromPcmFile(const String& title, const String& preview, const String& pcmPath,
                                  size_t audioLen, uint32_t sampleRate, bool assistant) {
  fs::FS* fs = activeVoiceFs();
  if (!gStorageReady || !ensureVoiceStorage() || !fs || !fsExists(*fs, pcmPath)) {
    return;
  }
  uint64_t totalBytes = activeStorageTotalBytes();
  uint64_t usedBytes = activeStorageUsedBytes();
  size_t requiredBytes = 44 + audioLen + 2048;
  if (totalBytes > 0 && usedBytes + requiredBytes >= totalBytes) {
    logf("[VOICE] skip note storage used=%llu total=%llu required=%u",
         static_cast<unsigned long long>(usedBytes),
         static_cast<unsigned long long>(totalBytes),
         static_cast<unsigned>(requiredBytes));
    return;
  }

  VoiceNote note;
  note.id = makeVoiceNoteId(assistant);
  note.audioPath = voiceAudioPath(note.id);
  note.metaPath = voiceMetaPath(note.id);
  note.title = makeVoiceNoteTitle(assistant, audioLen, sampleRate);
  note.preview = trimPreview(preview);
  note.sampleRate = sampleRate;
  note.durationMs = sampleRate ? static_cast<uint32_t>((audioLen / 2U) * 1000ULL / sampleRate) : 0;
  note.assistant = assistant;

  if (!persistWavFromPcmFile(note.audioPath, pcmPath, sampleRate, audioLen)) {
    return;
  }
  if (!saveVoiceNoteMetadata(note)) {
    fsRemove(*fs, note.audioPath);
    return;
  }
  gVoiceNotes.push_back(note);
  sortVoiceNotesNewestFirst();
  pruneVoiceNotes();
  gSelectedVoiceNote = 0;
}

uint16_t readLe16(const uint8_t* p) {
  return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}
