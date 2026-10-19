  if (taskOk != pdPASS) {
    delete rawPayload;
    gActiveTextTurn = "";
    gTextTurnTaskHandle = nullptr;
    gSubmitting = false;
    gThinking = false;
    gAssistantPendingVisible = false;
    pushError("Failed to start send task.");
    setFaceMode(FaceMode::Error);
    setStatus("Send failed", 1500);
  }
}

void processCompletedTextTurn() {
  TextTurnTaskResult* result = nullptr;
  portENTER_CRITICAL(&gTextTurnMux);
  result = gCompletedTextTurn;
  gCompletedTextTurn = nullptr;
  portEXIT_CRITICAL(&gTextTurnMux);
  if (!result) {
    if (gTextTurnAllocationFailed) {
      gTextTurnAllocationFailed=false; gTextTurnTaskHandle=nullptr; gActiveTextTurn="";
      gSubmitting=false; gThinking=false; gAssistantPendingVisible=false;
      pushError("Send: not enough memory");
    }
    return;
  }

  std::unique_ptr<TextTurnTaskResult> done(result);
  gTextTurnTaskHandle = nullptr;
  const String submittedText = gActiveTextTurn;
  gActiveTextTurn = "";
  // The worker has finished. Feedback must paint as accepted/replied, not THINK.
  gSubmitting = false;
  gThinking = false;
  gAssistantPendingVisible = false;

  if (done->hasFirmwareJobStatus)
    applyFirmwareJobState(done->firmwareJobState, done->firmwareJobRequestId);
  if (!done->error.isEmpty()) {
    logf("[TEXT] async error code=%d body=%s", done->statusCode, done->response.c_str());
    pushError(done->error);
    if (done->statusCode <= 0) {
      setHttpDiag("text: " + done->error);
    } else {
      setHttpDiag("text: http " + String(done->statusCode));
    }
    if (!done->response.isEmpty()) {
      pushError(done->response);
    }
    setFaceMode(FaceMode::Error);
    setStatus("Text turn failed", 2000);
  } else if (done->ok && done->pending) {
    acceptPendingAssistantRequest(submittedText, done->reply, done->afterSeq, done->replySeq);
    if (done->frontReplyIsAgent && shouldSpeakAssistantTextReply(done->reply))
      gQueuedVoiceReplySpeech = cleanReplyForDevice(done->reply);
    logf("[TEXT] async accepted receipt_seq=%u", static_cast<unsigned>(done->replySeq));
  } else if (done->ok && done->hasReply) {
    gVoiceReplyPending = false;
    appendAssistantReply(done->reply);
    rememberStoredAssistantSeq(done->replySeq);
    if (gUiMode != UiMode::ChatFull && gUiMode != UiMode::ChatFace)
      showVoiceNotice(done->reply, false);
    // Speech uses the existing cancellable worker. A synchronous HTTPS/TTS
    // request here can stop loopTask for the entire server round-trip.
    if (shouldSpeakAssistantTextReply(done->reply))
      gQueuedVoiceReplySpeech = cleanReplyForDevice(done->reply);
    logf("[TEXT] async reply=%s", done->reply.c_str());
    setStatus("Reply received", 1200);
    if (done->hasDeviceActions) {
      executeOrDeferDeviceActionsJson(done->deviceActionsJson);
    }
  } else if (done->ok) {
    pushSystem("Hub accepted the turn.");
    logf("[TEXT] async accepted without reply");
    if (done->hasDeviceActions) {
      executeOrDeferDeviceActionsJson(done->deviceActionsJson);
    }
    if (!gPlaybackActive) {
      setFaceMode(FaceMode::Idle);
    }
    setStatus("Turn accepted", 1200);
  }

  if (!gPendingTextTurns.empty()) {
    maybeStartNextTextTurn();
    return;
  }

  gSubmitting = false;
  gThinking = false;
  gAssistantPendingVisible = false;
  if (!gRecording && !gPlaybackActive) {
    setFaceMode(FaceMode::Idle);
  }
}

bool stopRecordingAndSend() {
  if (!gRecording) {
    return false;
  }
  gRecording = false;
  gVoiceRequestPhase=VoiceRequestPhase::Sending;
  gVoiceRequestProgress=0;
  pulseButtonPress();

  float elapsed = (millis() - gRecordStartMs) / 1000.0f;
  size_t dataSize = 0;
  String pcmUploadPath;

  setStatus("Finalizing...");
  render();
  gLastRenderMs = millis();

  if (gRecordingToFile) {
    drainRecordingToFile();
    if (gRecordFileWriteFailed) return false; // Failure path already stopped audio and retained the file.
    size_t queuedBeforeStop = M5Cardputer.Mic.isRecording();
    if (queuedBeforeStop > 0 || !gRecordInflightChunks.empty()) {
      logf("[VOICE] dropping tail queued=%u inflight=%u",
           static_cast<unsigned>(queuedBeforeStop),
           static_cast<unsigned>(gRecordInflightChunks.size()));
    }
    stopMic(false);
    gRecordInflightChunks.clear();
    if (gActiveRecordFile) {
      gActiveRecordFile.flush(); // size() uses stat and cannot see buffered tail bytes.
      const size_t fileBytes = gActiveRecordFile.size();
      uint8_t header[44];
      writeWavHeader(header, fileBytes >= 44 ? fileBytes - 44 : 0, kMicSampleRate);
      const bool finalized = fileBytes >= 44 && gActiveRecordFile.seek(0) &&
                             gActiveRecordFile.write(header, sizeof(header)) == sizeof(header);
      gActiveRecordFile.flush();
      gActiveRecordFile.close();
      if (!finalized) {
        cancelVoicePreconnect(); endVoiceWifiPerformance(); initSpeaker();
        gRecordingToFile = false;
        pushError("Voice WAV finalization failed; recording retained on SD.");
        showVoiceRequestError("Could not finalize recording. File kept on SD.");
        setFaceMode(FaceMode::Error);
        setStatus("Record storage failed", 2200); return false;
      }
    }
    fs::FS* fs = activeVoiceFs();
    if (fs && !gActiveRecordPath.isEmpty() && fsExists(*fs, gActiveRecordPath)) {
      File verifyFile = fs->open(gActiveRecordPath, "r");
      if (verifyFile) {
        size_t actualBytes = verifyFile.size() >= 44 ? verifyFile.size() - 44 : 0;
        verifyFile.close();
        if (actualBytes != gActiveRecordBytes) {
          appendRuntimeLog("VOICE", "record size adjusted counter=" +
                                    String(static_cast<unsigned>(gActiveRecordBytes)) +
                                    " file=" + String(static_cast<unsigned>(actualBytes)), true);
          logf("[VOICE] record size adjusted counter=%u file=%u",
               static_cast<unsigned>(gActiveRecordBytes),
               static_cast<unsigned>(actualBytes));
          gActiveRecordBytes = actualBytes;
        }
      }
    }
    gRecordedSamples = gActiveRecordBytes / sizeof(int16_t);
    dataSize = static_cast<uint32_t>(gActiveRecordBytes);
    pcmUploadPath = gActiveRecordPath;
  } else {
    size_t expectedSamples = static_cast<size_t>(elapsed * kMicSampleRate);
    gRecordedSamples = expectedSamples;
    if (gRecordedSamples > gRecordCapacitySamples) {
      gRecordedSamples = gRecordCapacitySamples;
    }
    stopMic(false);
    dataSize = static_cast<uint32_t>(gRecordedSamples * sizeof(int16_t));
  }

  logf("[VOICE] recording stopped elapsed=%.2f samples=%u mode=%s", elapsed,
       static_cast<unsigned>(gRecordedSamples),
       gRecordingToFile ? "file" : "ram");

  if (elapsed < kMinRecordSeconds || gRecordedSamples == 0) {
    cancelVoicePreconnect(); endVoiceWifiPerformance(); initSpeaker();
    setFaceMode(FaceMode::Idle);
    setStatus("Voice turn canceled", 1200);
    logf("[VOICE] canceled: too short");
    dismissVoiceNotice();
    if (gRecordingToFile) {
      fs::FS* fs = activeVoiceFs();
      if (!pcmUploadPath.isEmpty()) {
        if (fs) {
          fsRemove(*fs, pcmUploadPath);
        }
      }
      gRecordingToFile = false;
      gActiveRecordPath = "";
      gActiveRecordBytes = 0;
      gActiveRecordCommittedBytes = 0;
      gActiveRecordExpectedBytes = 0;
    } else {
      releaseRecordBuffer();
    }
    return false;
  }

  if (gRecordingToFile) {
    registerDownloadedVoiceNote(pcmUploadPath, makeVoiceNoteTitle(false, dataSize, kMicSampleRate), "Outbound voice note", false);
  }
  gWifiReady = WiFi.status() == WL_CONNECTED;
  if (!gWifiReady) {
    cancelVoicePreconnect(); endVoiceWifiPerformance(); initSpeaker();
    pushError("Wi-Fi dropped during recording.");
    showVoiceRequestError("Wi-Fi disconnected. Recording kept in Voice Notes.");
    setFaceMode(FaceMode::Error);
    setStatus("Wi-Fi lost", 2000);
    setVoiceDiag("voice: wifi lost");
    logf("[VOICE] wifi lost before upload");
    if (gRecordingToFile) {
      // The original WAV remains saved for replay or retry.
      gRecordingToFile = false;
      gActiveRecordPath = "";
      gActiveRecordBytes = 0;
      gActiveRecordCommittedBytes = 0;
      gActiveRecordExpectedBytes = 0;
    } else {
      releaseRecordBuffer();
    }
    return false;
  }

  gSubmitting = true;
  gThinking = true;
  setFaceMode(FaceMode::Thinking);
  setStatus("Uploading...");
  render();
  gLastRenderMs = millis();
  delay(10);
  pauseHubWebSocketForVoice();
  auto finishVoiceTurn = [&]() {
    gSubmitting = false;
    gThinking = false;
    endVoiceWifiPerformance();
    initSpeaker();
    resumeHubWebSocketAfterVoice();
  };

  if (!gRecordingToFile) {
    uint8_t wavHeader[44];
    writeWavHeader(wavHeader, dataSize, kMicSampleRate);
    rememberVoiceNote("My voice", "Outbound voice note", wavHeader, sizeof(wavHeader),
                      reinterpret_cast<const uint8_t*>(gRecordBuffer), dataSize, kMicSampleRate, false);
  }
  logHeapStats("voice-upload");
