bool handlePetKey(char key, const Keyboard_Class::KeysState& keys) {
  char lowerKey = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (keys.enter || keys.space || key == '\n' || key == '\r' || key == ' ') {
    return applyPetCare(suggestedPetAction());
  }
  if (lowerKey == 'f') {
    return applyPetCare(PetCareAction::Feed);
  }
  if (lowerKey == 'p') {
    return applyPetCare(PetCareAction::Play);
  }
  if (lowerKey == 'c') {
    return applyPetCare(PetCareAction::Clean);
  }
  if (lowerKey == 's') {
    return applyPetCare(PetCareAction::Sleep);
  }
  if (lowerKey == 'm') {
    return applyPetCare(PetCareAction::Medicine);
  }
  if (lowerKey == 'd') {
    return applyPetCare(PetCareAction::Discipline);
  }
  if (lowerKey == 'h') {
    return applyPetCare(PetCareAction::Hunt);
  }
  if (lowerKey == 'e') {
    return applyPetCare(PetCareAction::Explore);
  }
  if (lowerKey == 'r') {
    updatePetMood();
    setStatus(String(petMoodName(gPet.mood)) + " " + petAgeText(), 1000);
    return true;
  }
  return false;
}

bool copyFileBetweenFs(fs::FS& fromFs, fs::FS& toFs, const String& path) {
  if (!fsExists(fromFs, path)) {
    return false;
  }
  if (fsExists(toFs, path)) {
    return true;
  }
  File src = fromFs.open(path, "r");
  if (!src) {
    return false;
  }
  File dst = toFs.open(path, "w");
  if (!dst) {
    src.close();
    return false;
  }
  uint8_t buffer[1024];
  bool ok = true;
  while (src.available()) {
    size_t readBytes = src.read(buffer, sizeof(buffer));
    if (readBytes == 0) {
      break;
    }
    if (dst.write(buffer, readBytes) != readBytes) {
      ok = false;
      break;
    }
  }
  src.close();
  dst.close();
  if (!ok) {
    fsRemove(toFs, path);
  }
  return ok;
}

void migrateLittleFsVoiceNotesToSd() {
  if (!gSdReady || !gLittleFsReady || !ensureVoiceStorageOn(SD) || !LittleFS.exists(kVoiceDir)) {
    return;
  }
  File dir = LittleFS.open(kVoiceDir);
  if (!dir || !dir.isDirectory()) {
    return;
  }
  uint16_t copied = 0;
  while (true) {
    File file = dir.openNextFile();
    if (!file) {
      break;
    }
    String path = file.path();
    bool regular = !file.isDirectory();
    file.close();
    if (!regular || path.indexOf("__active_") >= 0 ||
        (!path.endsWith(kVoiceMetaExt) && !path.endsWith(kVoiceAudioExt))) {
      continue;
    }
    if (copyFileBetweenFs(LittleFS, SD, path)) {
      ++copied;
    }
  }
  if (copied > 0) {
    logf("[SD] migrated %u voice files from LittleFS", static_cast<unsigned>(copied));
  }
}

void initStorage() {
  Serial.println("[BOOT] storage: LittleFS begin");
  gLittleFsReady = LittleFS.begin(true);
  if (!gLittleFsReady) {
    pushError("LittleFS init failed.");
  }

  Serial.println("[BOOT] storage: SD begin");
  gSdSpi.begin(kSdSckPin, kSdMisoPin, kSdMosiPin, kSdCsPin);
  gSdReady = SD.begin(kSdCsPin, gSdSpi, kSdFrequencyHz);
  if (gSdReady && SD.cardType() == CARD_NONE) {
    SD.end();
    gSdReady = false;
  }
  if (gSdReady) {
    ensureVoiceStorageOn(SD);
    ensurePomodoroStorageOn(SD);
    logf("[SD] ready type=%u total=%lluMB used=%lluMB pins=sck%u miso%u mosi%u cs%u",
         static_cast<unsigned>(SD.cardType()),
         static_cast<unsigned long long>(SD.totalBytes() / (1024ULL * 1024ULL)),
         static_cast<unsigned long long>(SD.usedBytes() / (1024ULL * 1024ULL)),
         static_cast<unsigned>(kSdSckPin),
         static_cast<unsigned>(kSdMisoPin),
         static_cast<unsigned>(kSdMosiPin),
         static_cast<unsigned>(kSdCsPin));
    // Keep boot deterministic: migration can stall on corrupted LittleFS/SD metadata.
    logf("[SD] LittleFS voice migration skipped on boot");
  } else {
    logf("[SD] not mounted; using LittleFS fallback");
  }

  if (gOtaBootApplyMode) {
    Serial.println("[BOOT] storage: OTA minimal mode");
    gStorageReady = gSdReady || gLittleFsReady;
    gStorageLabel = activeVoiceStorageLabel();
    if (!gStorageReady) {
      setStatus("Storage unavailable", 1000);
    }
    return;
  }

  gStorageReady = gSdReady || gLittleFsReady;
  gStorageLabel = activeVoiceStorageLabel();
  if (!gStorageReady) {
    setStatus("Storage unavailable", 1000);
    return;
  }
  Serial.println("[BOOT] storage: minimal ready");
  ensureVoiceStorage();
  if (!gSdReady && gLittleFsReady) {
    ensurePomodoroStorageOn(LittleFS);
  }
  pushSystem("Storage: " + gStorageLabel);
  appendRuntimeLog("BOOT", "storage background deferred", false);
}

bool remountSdStorage(const char* reason) {
  if (!gSdReady) {
    return false;
  }
  logf("[SD] remount reason=%s", reason ? reason : "-");
  SD.end();
  delay(120);
  gSdSpi.begin(kSdSckPin, kSdMisoPin, kSdMosiPin, kSdCsPin);
  gSdReady = SD.begin(kSdCsPin, gSdSpi, kSdFrequencyHz);
  if (gSdReady && SD.cardType() == CARD_NONE) {
    SD.end();
    gSdReady = false;
  }
  if (gSdReady) {
    ensureVoiceStorageOn(SD);
    ensurePomodoroStorageOn(SD);
    gStorageReady = true;
    gStorageLabel = "sd";
    logf("[SD] remount ok freq=%u", static_cast<unsigned>(kSdFrequencyHz));
    return true;
  }
  gStorageReady = gLittleFsReady;
  gStorageLabel = activeVoiceStorageLabel();
  logf("[SD] remount failed");
  return false;
}

bool startMic() {
  M5Cardputer.Speaker.end();
  auto micCfg = M5Cardputer.Mic.config();
  micCfg.sample_rate = kMicSampleRate;
  micCfg.magnification = 64;
  micCfg.noise_filter_level = 64;
  micCfg.dma_buf_len = 128;
  micCfg.dma_buf_count = 8;
  micCfg.task_priority = 1;
  M5Cardputer.Mic.config(micCfg);
  return M5Cardputer.Mic.begin();
}

void startRealtimeMic() {
  M5Cardputer.Speaker.end();
  auto micCfg = M5Cardputer.Mic.config();
  micCfg.sample_rate = kRealtimeInputSampleRate;
  micCfg.magnification = 64;
  micCfg.noise_filter_level = 64;
  // DMA transfer granularity is independent from our 30 ms network frames.
  // Keep the capture task/driver footprint at the ordinary mic baseline.
  micCfg.dma_buf_len = 128;
  micCfg.dma_buf_count = 8;
  micCfg.task_priority = 3;
  M5Cardputer.Mic.config(micCfg);
  M5Cardputer.Mic.begin();
}

void stopMic(bool restartSpeaker = true) {
  M5Cardputer.Mic.end();
  if (restartSpeaker) initSpeaker();
}

size_t writeRecordedBytes(File& file, const uint8_t* bytes, size_t length) {
  size_t total = 0;
  while (total < length) {
    const size_t chunk = min<size_t>(kRecordWriteBytes, length - total);
    const size_t written = file.write(bytes + total, chunk);
    total += written;
    if (written != chunk) break;
  }
  return total;
}

void handleRecordingStorageFailure() {
  gRecording = false;
  stopMic(false);
  cancelVoicePreconnect();
  endVoiceWifiPerformance();
  gRecordInflightChunks.clear();
  // Preserve the original file, including every byte accepted by the filesystem.
  // Do not retry an ambiguous card write or silently upload a truncated request.
  if (gActiveRecordFile) {
    gActiveRecordFile.flush();
    const size_t size = gActiveRecordFile.size();
    if (size >= 44) {
      uint8_t header[44];
      writeWavHeader(header, (size - 44) & ~size_t(1), kMicSampleRate);
      if (gActiveRecordFile.seek(0)) gActiveRecordFile.write(header, sizeof(header));
    }
    gActiveRecordFile.close();
  }
  const String retainedPath = gActiveRecordPath;
  gRecordingToFile = false;
  gActiveRecordPath = "";
  gActiveRecordBytes = gActiveRecordCommittedBytes = gActiveRecordExpectedBytes = 0;
  gRecordedSamples = 0;
  initSpeaker();
  setVoiceDiag("voice: SD write failed");
  setFaceMode(FaceMode::Error);
  const String error = "SD recording failed. File kept on SD. Hold G0 to retry.";
  pushLine("ERR", error, LineKind::Error);
  showVoiceRequestError(error);
  setStatus("SD write failed; retry G0", 10000);
  logf("[VOICE] record failed; mic stopped; connection canceled; retained=%s", retainedPath.c_str());
}

void flushCompletedRecordChunksToFile(size_t completedCount) {
  for (size_t i = 0; i < completedCount && !gRecordInflightChunks.empty(); ++i) {
    uint8_t chunkIndex = gRecordInflightChunks.front();
    gRecordInflightChunks.pop_front();
    updateVoiceLevelFromSamples(gRecordChunkBuffers[chunkIndex], kRecordChunkSamples);
    if (gActiveRecordFile) {
      size_t written = writeRecordedBytes(gActiveRecordFile,
          reinterpret_cast<const uint8_t*>(gRecordChunkBuffers[chunkIndex]), kRecordChunkBytes);
      gActiveRecordBytes += written;
      gActiveRecordCommittedBytes += written;
      if (written != kRecordChunkBytes) {
        gRecordFileWriteFailed = true;
        gRecording = false;
        setHttpDiag("record fs short " + String(static_cast<unsigned>(written)) + "/" +
                    String(static_cast<unsigned>(kRecordChunkBytes)));
        logf("[VOICE] record fs short write=%u expected=%u",
             static_cast<unsigned>(written),
             static_cast<unsigned>(kRecordChunkBytes));
        setStatus("Record FS failed", 1400);
        setFaceMode(FaceMode::Error);
        return;
      }
    }
  }
}

bool queueRecordChunk(uint8_t chunkIndex) {
  return M5Cardputer.Mic.record(gRecordChunkBuffers[chunkIndex], kRecordChunkSamples, kMicSampleRate);
}

void serviceRecordingToFile(bool refill) {
  if ((!gRecording && refill) || !gRecordingToFile) {
    return;
  }
  static uint32_t sessionStartMs = 0, lastServiceMs = 0, maxGapMs = 0, lastReportMs = 0;
  const uint32_t now = millis();
  if (sessionStartMs != gRecordStartMs) {
    sessionStartMs = gRecordStartMs;
    lastServiceMs = lastReportMs = now;
    maxGapMs = 0;
  }
  maxGapMs = max<uint32_t>(maxGapMs, now - lastServiceMs);
  lastServiceMs = now;
  if (now - lastReportMs >= 1000U) {
    lastReportMs = now;
    logf("[VOICE_REC] ms=%u bytes=%u max_service_gap_ms=%u canvas=%d",
         static_cast<unsigned>(now - gRecordStartMs), static_cast<unsigned>(gActiveRecordBytes),
         static_cast<unsigned>(maxGapMs), gCanvasSpriteActive);
  }
  size_t micQueued = M5Cardputer.Mic.isRecording();
  if (gRecordInflightChunks.size() > micQueued) {
    flushCompletedRecordChunksToFile(gRecordInflightChunks.size() - micQueued);
  }
  if (gRecordFileWriteFailed) {
    handleRecordingStorageFailure();
    return;
  }
  if (!refill) {
    return;
  }
  while (gRecordInflightChunks.size() < 2) {
    uint8_t chunkIndex = gRecordNextChunkIndex;
    gRecordNextChunkIndex = (gRecordNextChunkIndex + 1) % kRecordChunkBufferCount;
    bool alreadyInflight = false;
    for (uint8_t inflight : gRecordInflightChunks) {
      if (inflight == chunkIndex) {
        alreadyInflight = true;
        break;
      }
    }
    if (alreadyInflight) {
      continue;
    }
    if (!queueRecordChunk(chunkIndex)) {
      break;
    }
    gRecordInflightChunks.push_back(chunkIndex);
  }
}
