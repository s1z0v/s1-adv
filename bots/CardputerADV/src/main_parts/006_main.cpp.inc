template <typename T>
T clampValue(T value, T minValue, T maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

String jsonEscapeLine(String value) {
  value.replace("\\", "\\\\");
  value.replace("\"", "\\\"");
  value.replace("\r", " ");
  value.replace("\n", " ");
  return value;
}

void appendRuntimeLog(const String& area, const String& message, bool persist = false) {
  String compact = String(millis() / 1000) + " " + area + " " + message;
  while (compact.length() > 96) {
    compact.remove(compact.length() - 1);
  }
  gRuntimeLogs.push_back(compact);
  while (gRuntimeLogs.size() > kMaxRuntimeLogLines) {
    gRuntimeLogs.pop_front();
  }
  if (!persist || !gStorageReady) {
    return;
  }
  fs::FS* fs = activeVoiceFs();
  if (!fs || !ensurePomodoroStorageOn(*fs)) {
    return;
  }
  File out = fs->open(kRuntimeLogPath, FILE_APPEND);
  if (!out) {
    return;
  }
  out.print("{\"t\":");
  out.print(millis());
  out.print(",\"area\":\"");
  out.print(jsonEscapeLine(area));
  out.print("\",\"msg\":\"");
  out.print(jsonEscapeLine(message));
  out.println("\"}");
  out.close();
}

void logf(const char* fmt, ...) {
  char buf[768];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  Serial.println(buf);
  appendRuntimeLog("SER", String(buf), false);
}

lgfx::LGFXBase& uiCanvas() {
  return gCanvasSpriteActive ? static_cast<lgfx::LGFXBase&>(gCanvasBuffer)
                            : static_cast<lgfx::LGFXBase&>(M5Cardputer.Display);
}

uint32_t uiSceneKey() {
  return uint32_t(gUiMode) | (uint32_t(gLauncherVisible)<<8) |
    (uint32_t(assistantPulseState())<<9) | (uint32_t(gFocus.state)<<13) |
    (uint32_t(gRealtimeConnected)<<12) | (uint32_t(gRealtimeRecording)<<16) |
    (uint32_t(gRealtimePlaybackActive || gPlaybackActive)<<30) | (uint32_t(gRealtimeAwaiting)<<31) |
    (uint32_t(gLauncherSelection)<<17) | (uint32_t(gLauncherSubSelection)<<21) |
    (uint32_t(gSetupPortalActive)<<25) | (uint32_t(gChatCommandsVisible)<<26) | (uint32_t(gVoiceNoticeVisible)<<27) |
    (uint32_t(gRealtimeScreenVisible)<<28) | (uint32_t(gRealtimeClassicView)<<29);
}

void presentUiFrame() {
  if (gInboxHttpBusy) {
    // Small live indicator; the actual screen and inputs continue updating.
    const uint16_t color = (millis() / 200U) % 2U ? rgb565_local(47,227,255) : rgb565_local(12,60,72);
    uiCanvas().drawFastHLine(226, 1, 10, color);
  }
  if (gCanvasSpriteActive) {
    gCanvasBuffer.pushSprite(0, 0);
    // The sprite is loaned to TLS later. Never free a buffer still owned by DMA.
    M5Cardputer.Display.waitDMA();
  }
  gUiFramePolicy.presented(uiSceneKey());
}

void noteUiInput(const char* source) {
  gUiInputAtMs = millis();
  gUiInputPending = true;
  gUiInputSource = source;
  gLastRenderMs = 0;
}

struct UiFrameTrace {
  uint32_t started = millis();
  ~UiFrameTrace() {
    const uint32_t now = millis();
    if (gUiInputPending) {
      const uint32_t latency = now - gUiInputAtMs;
      if (latency > gUiInputMaxMs) gUiInputMaxMs = latency;
      Serial.printf("[UI_LATENCY] source=%s input_frame_ms=%u render_ms=%u direct=%d network=%d\n",
                    gUiInputSource, latency, now - started, !gCanvasSpriteActive, gInboxHttpBusy);
      gUiInputPending = false;
    }
  }
};

void sampleUiHealth() {
  const uint32_t now = millis();
  if (gUiLastServiceMs && now - gUiLastServiceMs > gUiMaxServiceGapMs) gUiMaxServiceGapMs = now - gUiLastServiceMs;
  gUiLastServiceMs = now;
  if (now - gUiLastMemorySampleMs < 1000U) return;
  gUiLastMemorySampleMs = now;
  gUiMinHeap = min<uint32_t>(gUiMinHeap, ESP.getFreeHeap());
  gUiMinLargest = min<uint32_t>(gUiMinLargest, heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
  gUiMinStack = min<uint32_t>(gUiMinStack, uxTaskGetStackHighWaterMark(nullptr));
}

template<typename F> void traceUiService(const char* name, F&& fn) {
  const uint32_t started = millis();
  fn();
  const uint32_t cost = millis() - started;
  if (cost >= 80U) Serial.printf("[UI_SERVICE] name=%s ms=%u free=%u largest=%u stack=%u\n", name, cost,
      static_cast<unsigned>(ESP.getFreeHeap()),
      static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)),
      static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
}

void prepareNetworkMemory(const char* reason, bool forceTtsBuffer) {
  if (!gRecording && gRecordBuffer) {
    releaseRecordBuffer();
  }
  if (gTtsBuffer && (forceTtsBuffer || !gPlaybackActive)) {
    releaseTtsBuffer();
  }
  yield();
  delay(1);
  logf("[MEM] net prep reason=%s free=%u largest=%u",
       reason ? reason : "http",
       static_cast<unsigned>(ESP.getFreeHeap()),
       static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
}

bool tlsHandshakeNeedsCanvas() {
  return ESP.getFreeHeap()<96U*1024U ||
      heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)<48U*1024U;
}

bool releaseUiCanvasForNetwork(const char* reason) {
  if (!gCanvasSpriteActive) {
    return false;
  }
  M5Cardputer.Display.waitDMA();
  gCanvasBuffer.deleteSprite();
  gCanvasSpriteActive = false;
  yield();
  delay(2);
  logf("[MEM] ui canvas released reason=%s free=%u largest=%u",
       reason ? reason : "net",
       static_cast<unsigned>(ESP.getFreeHeap()),
       static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
  return true;
}

void restoreUiCanvasAfterNetwork() {
  if (gCanvasSpriteActive) {
    return;
  }
  gCanvasBuffer.setPsram(psramFound());
  gCanvasBuffer.setColorDepth(8);
  if (!gCanvasBuffer.createSprite(240, 135)) {
    gCanvasSpriteActive = false;
    logf("[MEM] canvas restore deferred free=%u largest=%u", static_cast<unsigned>(ESP.getFreeHeap()),
         static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    return;
  }
  gCanvasBuffer.setTextWrap(false);
  gCanvasBuffer.setFont(&fonts::Font2);
  gCanvasBuffer.setTextSize(1);
  configureEmojiRendering();
  gCanvasSpriteActive = true;
  gLastRenderMs = 0;
  logf("[MEM] ui canvas restored free=%u largest=%u",
       static_cast<unsigned>(ESP.getFreeHeap()),
       static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
}

String chipIdSuffix() {
  uint64_t chip = ESP.getEfuseMac();
  char buf[13];
  snprintf(buf, sizeof(buf), "%06llx", (unsigned long long)(chip & 0xFFFFFFULL));
  return String(buf);
}

uint16_t compileTimeHubPort() {
  const char* raw = DEFAULT_HUB_PORT_STR;
  if (!raw || !raw[0]) {
    return kDefaultHubPort;
  }
  long parsed = strtol(raw, nullptr, 10);
  if (parsed <= 0 || parsed > 65535) {
    return kDefaultHubPort;
  }
  return static_cast<uint16_t>(parsed);
}

bool temporaryMidaCaptiveEnabled() {
  return TEMP_MIDA_CAPTIVE_AUTOCONNECT && strlen(TEMP_MIDA_WIFI_SSID) > 0 &&
         strlen(TEMP_MIDA_CAPTIVE_LOGIN_URL) > 0;
}

bool usingTemporaryMidaWifi() {
  if (!temporaryMidaCaptiveEnabled()) {
    return false;
  }
  String active = WiFi.status() == WL_CONNECTED ? WiFi.SSID() : "";
  return gWifiSsid == TEMP_MIDA_WIFI_SSID || active == TEMP_MIDA_WIFI_SSID;
}

bool activateTemporaryMidaWifi(const char* reason) {
  if (!temporaryMidaCaptiveEnabled() || gWifiSsid == TEMP_MIDA_WIFI_SSID) {
    return false;
  }
  gWifiSsid = TEMP_MIDA_WIFI_SSID;
  gWifiPassword = "";
  appendRuntimeLog("WIFI", String("temporary MIDA fallback ") + (reason ? reason : "wifi"), true);
  logf("[WIFI] temporary MIDA fallback reason=%s", reason ? reason : "wifi");
  return true;
}

bool isLocalOrPrivateBridgeHost(const String& host) {
  if (host == "localhost" || host == "127.0.0.1" || host.startsWith("192.168.") || host.startsWith("10.")) {
    return true;
  }
  if (!host.startsWith("172.")) {
    return false;
  }
  int firstDot = host.indexOf('.');
  int secondDot = firstDot >= 0 ? host.indexOf('.', firstDot + 1) : -1;
  if (firstDot < 0 || secondDot < 0) {
    return false;
  }
  int secondOctet = host.substring(firstDot + 1, secondDot).toInt();
  return secondOctet >= 16 && secondOctet <= 31;
}

void migrateBridgeEndpoint() {
  // Public builds preserve the endpoint explicitly configured by their owner.
}

bool hubUsesTls() {
  return true;
}

String hubBaseUrl() {
  return String(hubUsesTls() ? "https://" : "http://") + gHubHost + ":" + String(gHubPort);
}

void configureSecureClient(WiFiClientSecure& client) {
  client.setCACert(kTlsRootCaPem);
  client.setHandshakeTimeout(12);
}

bool isTrustedBridgeUrl(const String& url) {
  String origin = hubBaseUrl();
  return transport_security::sameBridgeOrigin(url.c_str(), origin.c_str());
}

const char* tlsVerifyMode() {
#if OPENCLAW_TLS_VERIFY
  return "ca";
#else
  return "insecure";
#endif
}

const char* otaImageStateName(esp_ota_img_states_t state) {
  switch (state) {
    case ESP_OTA_IMG_NEW:
      return "new";
    case ESP_OTA_IMG_PENDING_VERIFY:
      return "pending";
    case ESP_OTA_IMG_VALID:
      return "valid";
    case ESP_OTA_IMG_INVALID:
      return "invalid";
    case ESP_OTA_IMG_ABORTED:
      return "aborted";
    case ESP_OTA_IMG_UNDEFINED:
    default:
      return "undefined";
  }
}

String describeOtaPartition(const esp_partition_t* partition) {
  if (!partition) {
    return "none";
  }
  return String(partition->label) + "@0x" + String(static_cast<uint32_t>(partition->address), HEX) +
         "/" + String(static_cast<unsigned>(partition->size));
}

void otaLog(const String& message, bool persist = true) {
  appendRuntimeLog("OTA", message, persist);
  logf("[OTA] %s", message.c_str());
}

void clearOtaGuardPrefs() {
  gPrefs.begin(kPrefsOtaGuardNs, false);
  gPrefs.clear();
  gPrefs.end();
}

bool readOtaApplyBootRequest() {
  gPrefs.begin(kPrefsOtaGuardNs, true);
  bool requested = gPrefs.getBool("apply_boot", false);
  gPrefs.end();
  return requested;
}

void clearOtaApplyBootRequest() {
  gPrefs.begin(kPrefsOtaGuardNs, false);
  gPrefs.remove("apply_boot");
  gPrefs.remove("apply_target");
  gPrefs.end();
}

void requestOtaApplyBootMode(const String& targetVersion) {
  gPrefs.begin(kPrefsOtaGuardNs, false);
  gPrefs.putBool("apply_boot", true);
  gPrefs.putString("apply_target", targetVersion);
  gPrefs.putString("from", kAppVersion);
  gPrefs.end();
  otaLog("boot apply requested target=" + targetVersion, true);
}

void recordOtaApplyIntent() {
  gPrefs.begin(kPrefsOtaGuardNs, false);
  gPrefs.putString("target", gOtaManifest.version);
  gPrefs.putString("sha", gOtaManifest.sha256);
  gPrefs.putString("from", kAppVersion);
  gPrefs.putString("git", kBuildGitSha);
  gPrefs.putUInt("started", millis());
  gPrefs.end();
}

void beginOtaBootGuard() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  gOtaRunningSlot = running ? String(running->label) : String("-");
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  esp_err_t err = running ? esp_ota_get_state_partition(running, &state) : ESP_ERR_NOT_FOUND;
  if (err == ESP_OK) {
    gOtaBootState = otaImageStateName(state);
  } else {
    gOtaBootState = "no-state";
  }

  gOtaPendingVerify = err == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY;
  gOtaConfirmedThisBoot = false;
  gOtaVerifyStartMs = millis();
  gOtaLastHealthProbeMs = 0;

  gPrefs.begin(kPrefsOtaGuardNs, false);
  String intendedTarget = gPrefs.getString("target", "");
  String intendedFrom = gPrefs.getString("from", "");
  gPrefs.end();
  if (!intendedTarget.isEmpty() && intendedTarget != kAppVersion && !gOtaPendingVerify) {
    appendRuntimeLog("OTA", "boot returned to " + String(kAppVersion) +
                              " after target=" + intendedTarget +
                              " from=" + intendedFrom +
                              " slot=" + gOtaRunningSlot +
                              " state=" + gOtaBootState, true);
    pushError("OTA did not switch to " + intendedTarget);
    setStatus("OTA stayed on " + String(kAppVersion), 1800);
    clearOtaGuardPrefs();
  }

  if (gOtaPendingVerify) {
    gPrefs.begin(kPrefsOtaGuardNs, false);
    uint32_t boots = gPrefs.getUInt("boots", 0) + 1;
    gPrefs.putUInt("boots", boots);
    gPrefs.putString("slot", gOtaRunningSlot);
    gPrefs.putString("boot_version", kAppVersion);
    gPrefs.end();
    appendRuntimeLog("OTA", "pending verify slot=" + gOtaRunningSlot +
                              " boot=" + String(boots), true);
    pushSystem("OTA verify: " + gOtaRunningSlot);
    setStatus("OTA verifying...", 1200);
  } else if (err == ESP_OK && state == ESP_OTA_IMG_VALID) {
    clearOtaGuardPrefs();
  }
  logf("[OTA] running=%s state=%s pending=%d", gOtaRunningSlot.c_str(),
       gOtaBootState.c_str(), static_cast<int>(gOtaPendingVerify));
}
