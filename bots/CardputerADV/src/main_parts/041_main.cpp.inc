void flushCompletedRealtimeChunks(size_t completedCount) {
  for (size_t i = 0; i < completedCount && !gRealtimeInflightChunks.empty(); ++i) {
    uint8_t chunkIndex = gRealtimeInflightChunks.front();
    gRealtimeInflightChunks.pop();
    updateVoiceLevelFromSamples(gRealtimeInputBuffers[chunkIndex], kRealtimeInputChunkSamples);
    if (!sendRealtimeAudioChunk(gRealtimeInputBuffers[chunkIndex], kRealtimeInputChunkSamples)) {
      setVoiceDiag("realtime: audio send failed");
      appendRuntimeLog("RT", "audio send failed", true);
      setFaceMode(FaceMode::Error);
      setStatus("Realtime send failed", 1600);
      // Avoid re-entering this drain path from closeRealtimeSession().
      gRealtimeRecording = false;
      gRealtimeInflightChunks.clear();
      M5Cardputer.Mic.end();
      initSpeaker();
      failRealtimeSession("Audio send failed");
      return;
    }
  }
}

void serviceRealtimeRecording(bool refill = true) {
  if (!gRealtimeRecording && gRealtimeInflightChunks.empty()) {
    return;
  }
  size_t micQueued = M5Cardputer.Mic.isRecording();
  if (gRealtimeInflightChunks.size() > micQueued) {
    flushCompletedRealtimeChunks(gRealtimeInflightChunks.size() - micQueued);
  }
  if (!refill || !gRealtimeRecording) {
    return;
  }
  while (gRealtimeInflightChunks.size() < 2) {
    uint8_t chunkIndex = gRealtimeNextChunkIndex;
    gRealtimeNextChunkIndex = (gRealtimeNextChunkIndex + 1) % kRealtimeChunkBufferCount;
    if (gRealtimeInflightChunks.contains(chunkIndex)) {
      continue;
    }
    if (!queueRealtimeChunk(chunkIndex)) {
      break;
    }
    if (!gRealtimeInflightChunks.push(chunkIndex)) {
      break;
    }
  }
}

void stopRealtimeMicNonBlocking() {
  // Forward only chunks that the async mic has already completed. Never poll
  // here: this path runs from Realtime events and must keep keyboard/Escape live.
  serviceRealtimeRecording(false);
  M5Cardputer.Mic.end();
  gRealtimeInflightChunks.clear();
  initSpeaker();
}

void stopRealtimeRecordingForVad() {
  if (!gRealtimeRecording) {
    return;
  }
  gRealtimeRecording = false;
  stopRealtimeMicNonBlocking();
  markRealtimeLatencyOrigin("speech_stop");
  gRealtimeAwaiting = true;
  gRealtimeAwaitingStartedMs = millis();
  gRealtimeRestartAfterPlayback = false;
  setFaceMode(FaceMode::Thinking);
  setStatus("Realtime thinking...");
  setVoiceDiag("realtime: vad stopped");
  appendRuntimeLog("RT", "vad stop record", false);
  logf("[RT] vad stop record free=%u largest=%u",
       static_cast<unsigned>(ESP.getFreeHeap()),
       static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
}

void resetRealtimePlaybackState(bool stopSpeaker) {
  if (stopSpeaker && (gRealtimePlaybackActive || gRealtimePlaybackEverStarted)) {
    M5Cardputer.Speaker.stop();
  }
  gRealtimePlaybackActive = false;
  gRealtimePlaybackFeeding = false;
  gRealtimePlaybackEverStarted = false;
  gRealtimeAudioComplete = false;
  gRealtimeResponseComplete = false;
  gRealtimePlaybackRead = 0;
  gRealtimePlaybackWrite = 0;
  gRealtimePlaybackBufferedBytes = 0;
  // Mic capture and reply playback are half duplex. Do not permanently take
  // 16 KB away from the Wi-Fi driver while it is sending microphone frames.
  // Speaker DMA owns separate copied chunks, so it never references this ring.
  for (auto& block : gRealtimePlaybackBlocks) block.reset();
  gRealtimePlaybackDroppedBytes = 0;
  gRealtimePlaybackNextBuffer = 0;
  gRealtimeReplyBytes = 0;
  gRealtimeLatencyOriginMs = 0;
  gRealtimeFirstAudioDeltaMs = 0;
  gRealtimeLastAudioDeltaMs = 0;
  gRealtimePlaybackStartMs = 0;
  gRealtimePlaybackProgressMs = 0;
  gRealtimeAudioDoneMs = 0;
}

void markRealtimeLatencyOrigin(const char* source) {
  gRealtimeLatencyOriginMs = millis();
  gRealtimeFirstAudioDeltaMs = 0;
  gRealtimePlaybackStartMs = 0;
  logf("[RT][LAT] %s t=%u", source ? source : "commit",
       static_cast<unsigned>(gRealtimeLatencyOriginMs));
}

size_t writeRealtimePlaybackRing(const uint8_t* data, size_t length) {
  if (!data || length == 0 || !gRealtimePlaybackBlocks[0]) {
    return 0;
  }
  const size_t writable = min(length, kRealtimePlaybackRingBytes - gRealtimePlaybackBufferedBytes);
  size_t copied = 0;
  while (copied < writable) {
    const size_t position = (gRealtimePlaybackWrite + copied) % kRealtimePlaybackRingBytes;
    const size_t inBlock = position % kRealtimePlaybackBlockBytes;
    const size_t count = min(writable - copied, kRealtimePlaybackBlockBytes - inBlock);
    memcpy(gRealtimePlaybackBlocks[position / kRealtimePlaybackBlockBytes].get() + inBlock,
           data + copied, count);
    copied += count;
  }
  gRealtimePlaybackWrite = (gRealtimePlaybackWrite + writable) % kRealtimePlaybackRingBytes;
  gRealtimePlaybackBufferedBytes += writable;
  if (writable < length) {
    gRealtimePlaybackDroppedBytes += length - writable;
  }
  return writable;
}

size_t readRealtimePlaybackRing(uint8_t* data, size_t length) {
  if (!data || length == 0 || !gRealtimePlaybackBlocks[0]) return 0;
  const size_t readable = min(length, gRealtimePlaybackBufferedBytes);
  size_t copied = 0;
  while (copied < readable) {
    const size_t position = (gRealtimePlaybackRead + copied) % kRealtimePlaybackRingBytes;
    const size_t inBlock = position % kRealtimePlaybackBlockBytes;
    const size_t count = min(readable - copied, kRealtimePlaybackBlockBytes - inBlock);
    memcpy(data + copied,
           gRealtimePlaybackBlocks[position / kRealtimePlaybackBlockBytes].get() + inBlock, count);
    copied += count;
  }
  gRealtimePlaybackRead = (gRealtimePlaybackRead + readable) % kRealtimePlaybackRingBytes;
  gRealtimePlaybackBufferedBytes -= readable;
  return readable;
}

void scheduleRealtimeListenAfterPlayback() {
  if (!gRealtimeResponseComplete || gRealtimePlaybackActive ||
      gRealtimeRecording || gRealtimeRestartAfterPlayback ||
      !gRealtimeHandsFreeActive || !gRealtimeActive || !gRealtimeConnected) {
    return;
  }
  gRealtimeRestartAfterPlayback = true;
  gRealtimeNextListenMs = millis() + kRealtimeListenRestartDelayMs;
}

void serviceRealtimeListenRestart(uint32_t now) {
  if (gRealtimeRestartAfterPlayback && gRealtimeHandsFreeActive &&
      gRealtimeActive && gRealtimeConnected && !gRealtimeRecording &&
      !gRealtimeAwaiting && !gPlaybackActive &&
      (gRealtimeNextListenMs == 0 || static_cast<int32_t>(now - gRealtimeNextListenMs) >= 0)) {
    gRealtimeRestartAfterPlayback = false;
    logf("[RT] auto restart listening free=%u largest=%u",
         static_cast<unsigned>(ESP.getFreeHeap()),
         static_cast<unsigned>(heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)));
    startRealtimeRecording();
  }
}

void serviceRealtimePlayback() {
  constexpr int kPlaybackChannel = 0;
  const uint32_t now = millis();
  const bool speakerIdle = M5Cardputer.Speaker.isPlaying(kPlaybackChannel) == 0;

  const bool streamStalled = gRealtimeGotAudio && !gRealtimeAudioComplete && speakerIdle &&
                             gRealtimePlaybackBufferedBytes < kRealtimePlaybackChunkBytes &&
                             gRealtimeLastAudioDeltaMs != 0 &&
                             now - gRealtimeLastAudioDeltaMs > kRealtimeStreamStallTimeoutMs;
  const bool speakerStalled = gRealtimeAudioComplete &&
                              gRealtimePlaybackBufferedBytes == 0 && !speakerIdle &&
                              gRealtimePlaybackProgressMs != 0 &&
                              now - gRealtimePlaybackProgressMs > kRealtimeSpeakerStallTimeoutMs;
  const bool terminalEventMissing = gRealtimeAudioComplete && !gRealtimeResponseComplete &&
                                    !gRealtimePlaybackActive && gRealtimeAudioDoneMs != 0 &&
                                    now - gRealtimeAudioDoneMs > kRealtimeTerminalEventGraceMs;
  if (streamStalled || speakerStalled || terminalEventMissing) {
    const char* reason = streamStalled ? "audio stream stalled"
                         : speakerStalled ? "speaker stalled"
                         : "response.done missing";
    logf("[RT] watchdog recovery reason=%s awaiting=%d playback=%d streaming=%d speaker=%d buffered=%u",
         reason, static_cast<int>(gRealtimeAwaiting), static_cast<int>(gPlaybackActive),
         static_cast<int>(gPlaybackStreaming),
         static_cast<int>(M5Cardputer.Speaker.isPlaying(kPlaybackChannel)),
         static_cast<unsigned>(gRealtimePlaybackBufferedBytes));
    setStatus("Realtime recovered", 1400);
    failRealtimeSession(reason);
    return;
  }

  if (gRealtimePlaybackFeeding && speakerIdle && !gRealtimeAudioComplete &&
      gRealtimePlaybackBufferedBytes < kRealtimePlaybackChunkBytes) {
    gRealtimePlaybackFeeding = false;
    appendRuntimeLog("RT", "playback underrun; rebuffer", true);
  }

  // A rebuffered stream may have stopped feeding before its terminal event.
  // Complete the drained turn before the prebuffer early return below.
  if (gRealtimeAudioComplete && gRealtimePlaybackBufferedBytes == 0 && speakerIdle) {
    const bool wasPlaying = gRealtimePlaybackActive;
    gRealtimePlaybackActive = false;
    gRealtimePlaybackFeeding = false;
    gPlaybackActive = false;
    if (wasPlaying) {
      logf("[RT] playback drained audio_done=%d response_done=%d",
           static_cast<int>(gRealtimeAudioComplete),static_cast<int>(gRealtimeResponseComplete));
      setFaceMode(FaceMode::Idle);
      setStatus("Realtime reply finished", 700);
    }
    scheduleRealtimeListenAfterPlayback();
    return;
  }

  if (!gRealtimePlaybackFeeding) {
    const bool enoughPrebuffer = gRealtimePlaybackBufferedBytes >= kRealtimePlaybackPrebufferBytes;
    const bool finalShortBuffer = gRealtimeAudioComplete &&
                                  gRealtimePlaybackBufferedBytes >= sizeof(int16_t);
    if (!enoughPrebuffer && !finalShortBuffer) {
      if (gRealtimeAudioComplete && gRealtimePlaybackBufferedBytes == 1) {
        gRealtimePlaybackRead = (gRealtimePlaybackRead + 1) % kRealtimePlaybackRingBytes;
        gRealtimePlaybackBufferedBytes = 0;
        ++gRealtimePlaybackDroppedBytes;
      }
      if (gRealtimeAudioComplete && gRealtimePlaybackBufferedBytes == 0 &&
          !gRealtimePlaybackEverStarted) {
        gRealtimePlaybackActive = false;
        gPlaybackActive = false;
        scheduleRealtimeListenAfterPlayback();
      }
      return;
    }
    gRealtimePlaybackFeeding = true;
    gRealtimePlaybackActive = true;
    gPlaybackActive = true;
    setFaceMode(FaceMode::Speaking);
    setStatus("Realtime speaking...");
    setVoiceDiag("realtime: half-duplex streaming");
  }

  while (gRealtimePlaybackBufferedBytes >= sizeof(int16_t) &&
         M5Cardputer.Speaker.isPlaying(kPlaybackChannel) < kPlaybackBufferCount) {
    size_t chunk = min(gRealtimePlaybackBufferedBytes, kRealtimePlaybackChunkBytes);
    if (!gRealtimeAudioComplete && chunk < kRealtimePlaybackChunkBytes) {
      break;
    }
    chunk &= ~static_cast<size_t>(1);
    if (chunk == 0) {
      break;
    }
    uint8_t* buffer = gPlaybackStreamBuffers[gRealtimePlaybackNextBuffer];
    const size_t readBytes = readRealtimePlaybackRing(buffer, chunk);
    updatePlaybackAnalyzerFromSamples(reinterpret_cast<const int16_t*>(buffer),
                                      readBytes / sizeof(int16_t),
                                      kRealtimeModelSampleRate);
    const bool firstChunk = M5Cardputer.Speaker.isPlaying(kPlaybackChannel) == 0;
    const bool queued = M5Cardputer.Speaker.playRaw(reinterpret_cast<const int16_t*>(buffer),
                                                     readBytes / sizeof(int16_t),
                                                     kRealtimeModelSampleRate,
                                                     false, 1, kPlaybackChannel, firstChunk);
    if (!queued) {
      appendRuntimeLog("RT", "stream queue failed; closing mode", true);
      setVoiceDiag("realtime: stream queue failed");
      setStatus("Realtime audio recovery", 1400);
      setFaceMode(FaceMode::Error);
      failRealtimeSession("Speaker queue failed");
      return;
    }
    gRealtimePlaybackProgressMs = millis();
    if (!gRealtimePlaybackEverStarted) {
      gRealtimePlaybackEverStarted = true;
      gRealtimePlaybackStartMs = now;
      const uint32_t fromOrigin = gRealtimeLatencyOriginMs == 0
        ? 0 : now - gRealtimeLatencyOriginMs;
      const uint32_t prebufferMs = gRealtimeFirstAudioDeltaMs == 0
        ? 0 : now - gRealtimeFirstAudioDeltaMs;
      logf("[RT][LAT] playback_start from_stop_ms=%u prebuffer_ms=%u received=%u",
           static_cast<unsigned>(fromOrigin),
           static_cast<unsigned>(prebufferMs),
           static_cast<unsigned>(gRealtimeReplyBytes));
    }
    gRealtimePlaybackNextBuffer = (gRealtimePlaybackNextBuffer + 1) % kPlaybackBufferCount;
  }

  const bool playbackFinished = gRealtimeAudioComplete &&
                                gRealtimePlaybackBufferedBytes == 0 &&
                                M5Cardputer.Speaker.isPlaying(kPlaybackChannel) == 0;
  if (playbackFinished && gRealtimePlaybackActive) {
    gRealtimePlaybackActive = false;
    gRealtimePlaybackFeeding = false;
    gPlaybackActive = false;
    setFaceMode(FaceMode::Idle);
    setStatus("Realtime reply finished", 700);
    scheduleRealtimeListenAfterPlayback();
    return;
  }

}

bool enterRealtimeExclusiveMode() {
  if (gRealtimeExclusiveMode) {
    return true;
  }
  if (gRecording || gSubmitting || gThinking || gOtaApplyInProgress) {
    setStatus("Voice path busy", 1000);
    setVoiceDiag("realtime: ordinary voice busy");
    return false;
  }
  if (gPlaybackActive || gPlaybackStreaming) {
    stopPlaybackStream();
    gPlaybackActive = false;
  }
  releaseRecordBuffer();
  releaseTtsBuffer();
  if (gDynamicPlaybackBuffer) {
    free(gDynamicPlaybackBuffer);
    gDynamicPlaybackBuffer = nullptr;
  }
  pauseHubWebSocketForVoice();
  gRealtimePreviousWifiSleep = WiFi.getSleep();
  gRealtimeWifiSleepSaved = true;
  WiFi.setSleep(WIFI_PS_NONE);
  gRealtimeExclusiveMode = true;
  logf("[RT] exclusive enter duplex=half ring=%u prebuffer=%u restart_ms=%u",
       static_cast<unsigned>(kRealtimePlaybackRingBytes),
       static_cast<unsigned>(kRealtimePlaybackPrebufferBytes),
       static_cast<unsigned>(kRealtimeListenRestartDelayMs));
  return true;
}

void leaveRealtimeExclusiveMode(const String& reason) {
  resetRealtimePlaybackState(true);
  // The speaker task/DMA was allocated between persistent TLS buffers during
  // the reply. Release that idle allocation before the next HTTPS handshake.
  // Audio entry points begin it again when there is actual sound to play.
  M5Cardputer.Speaker.end();
  gPlaybackActive = false;
  gRealtimeExclusiveMode = false;
  if (gRealtimeWifiSleepSaved) {
    WiFi.setSleep(gRealtimePreviousWifiSleep);
    gRealtimeWifiSleepSaved = false;
  }
  resumeHubWebSocketAfterVoice();
  logf("[RT] exclusive leave reason=%s", reason.c_str());
}

void resetRealtimeTurnState() {
  gRealtimeText = "";
  gRealtimeGotAudio = false;
  resetRealtimePlaybackState(true);
}

void closeRealtimeSession(const String& reason) {
  gPendingRealtimeStart=false;
  gRealtimeVadStopPending=false;
  ++gRealtimeDialGeneration; // Cancelled workers dispose their sockets on completion.
  const bool wasActive = gRealtimeActive;
  const bool wasConnected = gRealtimeConnected;
  if (gRealtimeRecording) {
    gRealtimeRecording = false;
    stopRealtimeMicNonBlocking();
  }
  gRealtimeInflightChunks.clear();
  // Clear transport-visible state before disconnect so a synchronous
  // WStype_DISCONNECTED callback cannot re-enter teardown.
  gRealtimeActive = false;
  gRealtimeConnected = false;
  gRealtimeAwaiting = false;
  if (wasConnected) {
    DynamicJsonDocument doc(128);
    doc["type"] = "close";
    String payload;
    serializeJson(doc, payload);
    sendRealtimeTextFrame(payload);
  }
  if (wasActive || wasConnected) {
    gRealtimeWs.disconnect();
  }
  gRealtimeStartAfterReady = false;
  gRealtimeHandsFreeActive = false;
  gRealtimeRestartAfterPlayback = false;
  gRealtimeNextListenMs = 0;
  gRealtimeSmokeAudioPending = false;
  gRealtimeSmokeActive = false;
  gRealtimeSmokeTextPending = false;
  gRealtimeSmokeAudioStreaming = false;
  gRealtimeSmokeAudioChunkIndex = 0;
  gRealtimeSmokeAudioNextMs = 0;
  gRealtimeAuthPending = false;
  gRealtimeAuthDueMs = 0;
  gRealtimeGotAudio = false;
  gRealtimeBinaryAudio = false;
  gRealtimeBinaryModelSequenceSeen = false;
  gRealtimeMicSequence = 0;
  gRealtimeExpectedModelSequence = 0;
  gRealtimeSessionId = "";
  gRealtimeExtraHeaders = "";
  gRealtimeWs.setExtraHeaders();
  leaveRealtimeExclusiveMode(reason);
  setVoiceDiag("realtime: " + reason);
}

void failRealtimeSession(const String& reason) {
  if (reason == "Audio send failed") gNetworkRecovery.streamLost(millis());
  else if (reason == "TLS connect failed -1" || reason == "TLS connect failed 0")
    gNetworkRecovery.failure(millis());
  // A transport failure must remain visible after teardown and status expiry.
  gRealtimeUiError = reason.substring(0, 160);
  appendRuntimeLog("RT", "failed: " + gRealtimeUiError, true);
  closeRealtimeSession(reason);
  setFaceMode(FaceMode::Error);
  setStatus("Realtime: " + gRealtimeUiError);
}
