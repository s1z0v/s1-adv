void drainRecordingToFile() {
  unsigned long deadline = millis() + kRecordDrainTimeoutMs;
  while (millis() < deadline) {
    serviceRecordingToFile(false);
    if (M5Cardputer.Mic.isRecording() == 0 && gRecordInflightChunks.empty()) {
      return;
    }
    yield();
    delay(4);
  }
  serviceRecordingToFile(false);
}

void startRecording() {
  const uint32_t captureRequestedMs = millis();
  serviceVoicePreconnect();
  if (gVoiceDialBusy) { setStatus("Connection finishing; try voice again", 1200); return; }
  if (gRealtimeDialBusy) { setStatus("Connection finishing; try voice again", 1200); return; }
  if (gVoiceReplySpeechBusy) { setStatus("Reply voice preparing; Esc cancels", 1000); return; }
  if (gInboxHttpBusy) { setStatus("Network finishing; try voice again",900); return; }
  if (gRealtimeExclusiveMode || gRealtimeActive) {
    logf("[VOICE] start blocked by realtime exclusive mode");
    setStatus("Exit Realtime first", 900);
    setVoiceDiag("voice: realtime owns audio");
    return;
  }
  if (gRecording || gSubmitting || gThinking || gPlaybackActive) {
    logf("[VOICE] start ignored rec=%d submit=%d think=%d play=%d", gRecording, gSubmitting,
         gThinking, gPlaybackActive);
    return;
  }
  if (!gWifiReady || gHubHost.isEmpty()) {
    pushError("Hub is not configured for voice.");
    setFaceMode(FaceMode::Error);
    setStatus("Voice unavailable", 1500);
    setVoiceDiag("voice: no wifi/hub");
    logf("[VOICE] start blocked wifi=%d hub=%s", gWifiReady, gHubHost.c_str());
    return;
  }
  if (!gPlaybackActive && gTtsBuffer) {
    releaseTtsBuffer();
  }
  dismissVoiceNotice();
  cancelVoicePreconnect(); // A new capture never retains an old reply/dial socket.
  gVoiceCaptureUpload.reset();
  struct PreparationScope {
    PreparationScope() { gVoiceCapturePreparing = true; }
    ~PreparationScope() { gVoiceCapturePreparing = false; }
    void finish() { gVoiceCapturePreparing = false; }
  } preparation;
  setStatus("Loading voice...", 0);
  render(); // First feedback precedes SD open and I2S setup; REC means capture.
  if (gRecordFileWriteFailed) {
    cancelVoicePreconnect();
    if (!remountSdStorage("record retry")) {
      showVoiceNotice("SD unavailable. Check the card and retry.", false);
      setStatus("SD unavailable", 5000);
      return;
    }
    gRecordFileWriteFailed = false;
  }
  gRecordedSamples = 0;
  gVoiceLevel8 = 36;
  gMicInputMeter.reset();
  pulseButtonPress();

  gRecordingToFile = !gRecordFileWriteFailed && gStorageReady && ensureVoiceStorage();
  if (!gRecordingToFile && gRecordFileWriteFailed) {
    appendRuntimeLog("VOICE", "record fs disabled; using ram", true);
    logf("[VOICE] record fs disabled; using ram");
  }
  if (gRecordingToFile) {
    fs::FS* fs = activeVoiceFs();
    gActiveRecordPath = recordingAudioPath(makeVoiceNoteId(false));
    gActiveRecordFile = gActiveRecordPath.isEmpty() ? File() : fs->open(gActiveRecordPath, "w+");
    if (gActiveRecordFile) {
      gActiveRecordFile.setBufferSize(kRecordWriteBytes);
      uint8_t header[44]; writeWavHeader(header, 0, kMicSampleRate);
      if (gActiveRecordFile.write(header, sizeof(header)) != sizeof(header)) {
        gActiveRecordFile.close(); fsRemove(*fs, gActiveRecordPath);
      }
    }
    if (!gActiveRecordFile) {
      gRecordFileWriteFailed = true;
      handleRecordingStorageFailure();
      return;
    } else {
      gActiveRecordBytes = 0;
      gActiveRecordCommittedBytes = 0;
      gActiveRecordExpectedBytes = 0;
      gRecordInflightChunks.clear();
      gRecordNextChunkIndex = 0;
    }
  }

  if (!gRecordingToFile) {
    logHeapStats("voice-start");
    if (!ensureRecordBuffer()) {
      pushError("Audio buffer allocation failed.");
      setFaceMode(FaceMode::Error);
      setStatus("No audio buffer", 1500);
      setVoiceDiag("voice: record buffer failed");
      logf("[VOICE] audio buffer allocation failed");
      gRecording = false;
      return;
    }
  }

  const uint32_t storageReadyMs = millis();
  beginVoiceWifiPerformance();
  auto failCaptureStart = [&]() {
    gRecording = false;
    stopMic(false);
    if (gActiveRecordFile) gActiveRecordFile.close();
    if (gRecordingToFile && gActiveRecordBytes == 0 && !gActiveRecordPath.isEmpty()) {
      fs::FS* fs = activeVoiceFs();
      if (fs) fsRemove(*fs, gActiveRecordPath);
    }
    gRecordInflightChunks.clear();
    gRecordingToFile = false; gActiveRecordPath = "";
    gActiveRecordBytes = gActiveRecordCommittedBytes = gActiveRecordExpectedBytes = 0;
    releaseRecordBuffer(); endVoiceWifiPerformance(); initSpeaker();
    preparation.finish();
    setFaceMode(FaceMode::Error);
    setStatus("Microphone unavailable", 3000);
    showVoiceRequestError("Microphone did not start. Hold G0 to retry.");
  };
  if (!startMic()) { failCaptureStart(); return; }
  gRecording = true; // Mic is initialized; the first accepted buffer proves capture.
  gRecordStartMs = millis();
  bool captureQueued = false;
  if (gRecordingToFile) {
    serviceRecordingToFile();
    if (gRecordFileWriteFailed) { preparation.finish(); return; }
    captureQueued = !gRecordInflightChunks.empty();
    setVoiceDiag("voice: recording fs");
  } else {
    captureQueued = M5Cardputer.Mic.record(gRecordBuffer, gRecordCapacitySamples, kMicSampleRate);
    setVoiceDiag("voice: recording");
  }
  if (!captureQueued) { failCaptureStart(); return; }
  preparation.finish();
  beginVoiceRequestUi();
  setFaceMode(FaceMode::Listening);
  setStatus("Recording");
  render();
  if (gRecordingToFile) beginVoiceCaptureUpload();
  logf("[VOICE] recording started mode=%s init_ms=%u sd_ms=%u mic_ms=%u frame_ms=%u canvas=%d",
       gRecordingToFile ? "file" : "ram", static_cast<unsigned>(millis() - captureRequestedMs),
       static_cast<unsigned>(storageReadyMs - captureRequestedMs),
       static_cast<unsigned>(gRecordStartMs - storageReadyMs),
       static_cast<unsigned>(millis() - gRecordStartMs), gCanvasSpriteActive);
  if (gG0VoiceHeld) Serial.printf("[VOICE_LATENCY] g0_mic_ms=%u g0_rec_frame_ms=%u network_wait=%d\n",
      static_cast<unsigned>(gRecordStartMs - gG0VoiceRequestedMs),
      static_cast<unsigned>(millis() - gG0VoiceRequestedMs), captureRequestedMs != gG0VoiceRequestedMs);
}

void writeWavHeader(uint8_t* h, uint32_t dataSize, uint32_t sampleRate) {
  uint32_t fileSize = 36 + dataSize;
  uint32_t byteRate = sampleRate * 2;
  uint16_t blockAlign = 2;

  h[0] = 'R'; h[1] = 'I'; h[2] = 'F'; h[3] = 'F';
  h[4] = fileSize & 0xFF;
  h[5] = (fileSize >> 8) & 0xFF;
  h[6] = (fileSize >> 16) & 0xFF;
  h[7] = (fileSize >> 24) & 0xFF;
  h[8] = 'W'; h[9] = 'A'; h[10] = 'V'; h[11] = 'E';
  h[12] = 'f'; h[13] = 'm'; h[14] = 't'; h[15] = ' ';
  h[16] = 16; h[17] = 0; h[18] = 0; h[19] = 0;
  h[20] = 1; h[21] = 0;
  h[22] = 1; h[23] = 0;
  h[24] = sampleRate & 0xFF;
  h[25] = (sampleRate >> 8) & 0xFF;
  h[26] = (sampleRate >> 16) & 0xFF;
  h[27] = (sampleRate >> 24) & 0xFF;
  h[28] = byteRate & 0xFF;
  h[29] = (byteRate >> 8) & 0xFF;
  h[30] = (byteRate >> 16) & 0xFF;
  h[31] = (byteRate >> 24) & 0xFF;
  h[32] = blockAlign & 0xFF;
  h[33] = (blockAlign >> 8) & 0xFF;
  h[34] = 16; h[35] = 0;
  h[36] = 'd'; h[37] = 'a'; h[38] = 't'; h[39] = 'a';
  h[40] = dataSize & 0xFF;
  h[41] = (dataSize >> 8) & 0xFF;
  h[42] = (dataSize >> 16) & 0xFF;
  h[43] = (dataSize >> 24) & 0xFF;
}

bool parseHttpStatusAndHeaders(
    WiFiClient& client,
    int& statusCode,
    int& contentLength,
    uint32_t& sampleRate,
    uint32_t timeoutMs = 30000) {
  statusCode = 0;
  contentLength = -1;
  sampleRate = kTtsDefaultSampleRate;

  unsigned long deadline = millis() + timeoutMs;
  String line;
  auto readLine = [&](String& out) -> bool {
    out = "";
    while (millis() < deadline) {
      while (client.available() > 0) {
        int raw = client.read();
        if (raw < 0) {
          break;
        }
        char c = static_cast<char>(raw);
        if (c == '\n') {
          return true;
        }
        if (out.length() < 512) {
          out += c;
        }
      }
      if (!client.connected()) {
        return out.length() > 0;
      }
      pumpBlockingNetworkUi();
    }
    return out.length() > 0;
  };

  while (millis() < deadline) {
    if (!readLine(line)) {
      break;
    }
    line.trim();
    if (line.isEmpty() || !line.startsWith("HTTP/")) {
      continue;
    }

    int firstSpace = line.indexOf(' ');
    if (firstSpace >= 0) {
      statusCode = line.substring(firstSpace + 1).toInt();
    }
    logf("[HTTP] status line=%s", line.c_str());

    while (readLine(line)) {
      if (line == "\r" || line.length() == 0) {
        break;
      }
      String header = line;
      header.trim();
      String lower = header;
      lower.toLowerCase();
      if (lower.startsWith("content-length:")) {
        contentLength = header.substring(15).toInt();
      } else if (lower.startsWith("x-audio-sample-rate:")) {
        sampleRate = static_cast<uint32_t>(header.substring(20).toInt());
      }
    }

    if (statusCode == 100) {
      statusCode = 0;
      contentLength = -1;
      sampleRate = kTtsDefaultSampleRate;
      continue;
    }
    return statusCode > 0;
  }

  return false;
}

bool writeClientAll(WiFiClient& client, const uint8_t* data, size_t length, const char* label) {
  size_t written = 0;
  unsigned long deadline = millis() + 45000;
  unsigned long lastProgress = millis();
  while (written < length && millis() < deadline) {
    if (WiFi.status() != WL_CONNECTED) {
      setHttpDiag(String(label) + ": wifi lost");
      logf("[HTTP] wifi lost during write label=%s written=%u total=%u",
           label,
           static_cast<unsigned>(written),
           static_cast<unsigned>(length));
      break;
    }
    if (!client.connected()) {
      break;
    }
    size_t chunk = length - written;
    if (chunk > kHttpWriteChunkBytes) {
      chunk = kHttpWriteChunkBytes;
    }
    size_t sent = client.write(data + written, chunk);
    if (sent == 0) {
      if (millis() - lastProgress > 3000) {
        setHttpDiag(String(label) + ": stalled");
        logf("[HTTP] stalled write label=%s written=%u total=%u",
             label,
             static_cast<unsigned>(written),
             static_cast<unsigned>(length));
        break;
      }
      pumpBlockingNetworkUi();
      continue;
    }
    written += sent;
    lastProgress = millis();
    pumpBlockingNetworkUi();
  }

  if (written != length) {
    setHttpDiag(String(label) + ": short " + String(static_cast<unsigned>(written)) + "/" +
                String(static_cast<unsigned>(length)));
    logf("[HTTP] short write label=%s written=%u total=%u", label,
         static_cast<unsigned>(written), static_cast<unsigned>(length));
    return false;
  }
  setHttpDiag(String(label) + ": ok");
  return true;
}
