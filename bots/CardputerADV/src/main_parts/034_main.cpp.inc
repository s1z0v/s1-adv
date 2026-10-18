// These writers run on the UI thread. Reserve their bounded workspace before
// TLS fragments the heap; recording and SD storage never share this buffer.
alignas(4) uint8_t gHttpStageBuffer[kHttpStageChunkBytes];
bool gHttpStageInUse = false;
struct HttpStageLease {
  bool acquired;
  HttpStageLease() : acquired(!gHttpStageInUse) { if (acquired) gHttpStageInUse=true; }
  ~HttpStageLease() { if (acquired) gHttpStageInUse=false; }
  HttpStageLease(const HttpStageLease&)=delete;
  HttpStageLease& operator=(const HttpStageLease&)=delete;
  explicit operator bool() const { return acquired; }
  uint8_t* get() { return gHttpStageBuffer; }
};

bool writeClientAll(WiFiClient& client, const String& text, const char* label) {
  return writeClientAll(client, reinterpret_cast<const uint8_t*>(text.c_str()), text.length(), label);
}

bool writeClientAllStaged(WiFiClient& client, const uint8_t* data, size_t length, const char* label) {
  HttpStageLease stage;
  if (!stage) { setHttpDiag(String(label) + ": staging busy"); return false; }
  size_t written = 0;
  unsigned long deadline = millis() + 45000;
  unsigned long lastProgress = millis();

  while (written < length && millis() < deadline) {
    if (WiFi.status() != WL_CONNECTED) {
      setHttpDiag(String(label) + ": wifi lost");
      logf("[HTTP] staged wifi lost label=%s written=%u total=%u",
           label,
           static_cast<unsigned>(written),
           static_cast<unsigned>(length));
      break;
    }
    if (!client.connected()) {
      setHttpDiag(String(label) + ": disconnected");
      break;
    }

    size_t chunk = length - written;
    if (chunk > kHttpStageChunkBytes) {
      chunk = kHttpStageChunkBytes;
    }
    memcpy(stage.get(), data + written, chunk);
    size_t sent = client.write(stage.get(), chunk);
    if (sent == 0) {
      if (millis() - lastProgress > 3000) {
        setHttpDiag(String(label) + ": stalled");
        logf("[HTTP] staged stalled label=%s written=%u total=%u",
             label,
             static_cast<unsigned>(written),
             static_cast<unsigned>(length));
        break;
      }
      pumpBlockingNetworkUi();
      continue;
    }
    written += sent;
    if (strcmp(label,"voice_body")==0) gVoiceRequestProgress=static_cast<uint8_t>(written*100ULL/length);
    lastProgress = millis();
    if ((written % (8 * 1024)) == 0 || written == length) {
      if (strcmp(label,"voice_body")==0)
        setStatus("Uploading voice " + String(static_cast<unsigned>(written * 100ULL / length)) + "%");
      setHttpDiag(String(label) + ": " + String(static_cast<unsigned>(written / 1024)) + "k/" +
                  String(static_cast<unsigned>(length / 1024)) + "k");
    }
    pumpBlockingNetworkUi();
  }

  if (written != length) {
    setHttpDiag(String(label) + ": short " + String(static_cast<unsigned>(written)) + "/" +
                String(static_cast<unsigned>(length)));
    logf("[HTTP] staged short write label=%s written=%u total=%u",
         label,
         static_cast<unsigned>(written),
         static_cast<unsigned>(length));
    return false;
  }
  setHttpDiag(String(label) + ": ok " + String(static_cast<unsigned>(length / 1024)) + "k");
  return true;
}

bool writeClientAllFileStaged(WiFiClient& client, File& file, size_t length, const char* label) {
  HttpStageLease stage;
  if (!stage) { setHttpDiag(String(label) + ": staging busy"); return false; }
  size_t written = 0;
  uint32_t readMs = 0, writeMs = 0, uiMs = 0;
  unsigned long deadline = millis() + 90000;
  unsigned long lastProgress = millis();

  while (written < length && millis() < deadline) {
    if (WiFi.status() != WL_CONNECTED) {
      setHttpDiag(String(label) + ": wifi lost");
      return false;
    }
    if (!client.connected()) {
      setHttpDiag(String(label) + ": disconnected");
      return false;
    }
    size_t chunk = length - written;
    if (chunk > kHttpStageChunkBytes) {
      chunk = kHttpStageChunkBytes;
    }
    uint32_t phaseMs = millis();
    size_t readBytes = file.read(stage.get(), chunk);
    readMs += millis() - phaseMs;
    if (readBytes == 0) {
      break;
    }
    size_t sentFromStage = 0;
    while (sentFromStage < readBytes && millis() < deadline) {
      if (WiFi.status() != WL_CONNECTED) {
        setHttpDiag(String(label) + ": wifi lost");
        return false;
      }
      if (!client.connected()) {
        setHttpDiag(String(label) + ": disconnected");
        return false;
      }
      phaseMs = millis();
      size_t sent = client.write(stage.get() + sentFromStage, readBytes - sentFromStage);
      writeMs += millis() - phaseMs;
      if (sent == 0) {
        if (millis() - lastProgress > 5000) {
          setHttpDiag(String(label) + ": stalled");
          return false;
        }
        pumpBlockingNetworkUi();
        continue;
      }
      sentFromStage += sent;
      written += sent;
      if (strcmp(label,"voice_body")==0) gVoiceRequestProgress=static_cast<uint8_t>(written*100ULL/length);
      lastProgress = millis();
      if ((written % (8 * 1024)) == 0 || written == length) {
        if (strcmp(label,"voice_body")==0)
          setStatus("Uploading voice " + String(static_cast<unsigned>(written * 100ULL / length)) + "%");
        setHttpDiag(String(label) + ": " + String(static_cast<unsigned>(written / 1024)) + "k/" +
                    String(static_cast<unsigned>(length / 1024)) + "k");
      }
      phaseMs = millis();
      pumpBlockingNetworkUi();
      uiMs += millis() - phaseMs;
    }
  }

  if (written != length) {
    setHttpDiag(String(label) + ": short " + String(static_cast<unsigned>(written)) + "/" +
                String(static_cast<unsigned>(length)));
    return false;
  }
  logf("[VOICE_TIMING] bytes=%u sd_ms=%u socket_ms=%u ui_ms=%u", static_cast<unsigned>(length), readMs, writeMs, uiMs);
  setHttpDiag(String(label) + ": ok " + String(static_cast<unsigned>(length / 1024)) + "k");
  return true;
}

bool connectHubClient(WiFiClient& client, const char* reason, uint32_t readTimeoutSec) {
  if (!ensureWifiForHttp(reason)) {
    setHttpDiag(String(reason ? reason : "?") + ": wifi unavailable");
    return false;
  }
  for (uint8_t attempt = 0; attempt < kHttpConnectRetries; ++attempt) {
    client.stop();
    delay(30);
    if (attempt > 0) {
      ensureWifiForHttp(reason);
      delay(150);
    }
    if (client.connect(gHubHost.c_str(), gHubPort)) {
      client.setTimeout(readTimeoutSec);
      if (!hubUsesTls()) {
        client.setNoDelay(true);
      }
      setHttpDiag(String(reason ? reason : "?") + ": connect ok");
      logf("[HTTP] connect ok reason=%s attempt=%u ip=%s",
           reason ? reason : "?",
           static_cast<unsigned>(attempt + 1),
           WiFi.localIP().toString().c_str());
      return true;
    }
    setHttpDiag(String(reason ? reason : "?") + ": connect fail");
    logf("[HTTP] connect fail reason=%s attempt=%u wifi=%d ip=%s",
         reason ? reason : "?",
         static_cast<unsigned>(attempt + 1),
         static_cast<int>(WiFi.status()),
         WiFi.localIP().toString().c_str());
  }
  return false;
}

String escapeJsonString(const String& raw) {
  String out;
  out.reserve(raw.length() + 16);
  for (size_t i = 0; i < raw.length(); ++i) {
    char c = raw[i];
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<uint8_t>(c) >= 0x20) {
          out += c;
        }
        break;
    }
  }
  return out;
}

String authHeaderLine() {
  if (gDeviceToken.isEmpty()) {
    return "X-Device-Id: " + gDeviceId + "\r\n";
  }
  return "Authorization: Bearer " + gDeviceToken + "\r\n" +
         "X-Device-Token: " + gDeviceToken + "\r\n" +
         "X-Device-Id: " + gDeviceId + "\r\n";
}
