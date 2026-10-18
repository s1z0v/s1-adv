  String turnId = makeClientTurnId("voice");
  setStatus("Uploading voice...");
  render();
  gLastRenderMs = millis();
  appendRuntimeLog("VOICE", "upload start bytes=" + String(static_cast<unsigned>(dataSize)) +
                            " ctx=" + currentConversationKey() +
                            " turn=" + turnId, true);
  int statusCode = -1;
  String response;
  bool transportOk = false;
  bool prevRenderPump = gBlockingRenderPumpEnabled;
  gBlockingRenderPumpEnabled = true;
  gLastBlockingRenderPumpMs = 0;
  pumpBlockingNetworkUi();
  if (gRecordingToFile) {
    setHttpDiag("voice_pcm: raw file " + String(static_cast<unsigned>(dataSize / 1024)) + "k");
    transportOk = postRawVoiceTurn(nullptr, pcmUploadPath, dataSize, turnId, statusCode, response, true);
  } else {
    setHttpDiag("voice_pcm: raw ram " + String(static_cast<unsigned>(dataSize / 1024)) + "k");
    transportOk = postRawVoiceTurn(reinterpret_cast<const uint8_t*>(gRecordBuffer), "", dataSize,
                                   turnId, statusCode, response);
  }
  gBlockingRenderPumpEnabled = prevRenderPump;
  finishVoiceTurn();
  if (gRecordingToFile) {
    // Upload and voice-note history share this finalized WAV. Retain it.
    gRecordingToFile = false;
    gActiveRecordPath = "";
    gActiveRecordBytes = 0;
    gActiveRecordCommittedBytes = 0;
    gActiveRecordExpectedBytes = 0;
  } else {
    releaseRecordBuffer();
  }

  return finishVoiceSubmission(transportOk, statusCode, response, pcmUploadPath, dataSize);
}

// Ordinary capture and an explicit operator retry share receipt/error handling.
// A 2xx response alone must never leave the device on THINK indefinitely.
bool finishVoiceSubmission(bool transportOk, int statusCode, const String& response,
                           const String& pcmUploadPath, size_t dataSize) {
  if (!transportOk || statusCode <= 0) {
    String transportError = gLastHttpDiag;
    if (transportError.isEmpty()) {
      transportError = statusCode <= 0 ? HTTPClient::errorToString(statusCode) : String("unknown");
    }
    pushError("Voice transport failed: " + transportError);
    showVoiceRequestError("No delivery receipt. Open chat before retrying." +
        String(pcmUploadPath.isEmpty()?"":" Recording kept in Voice Notes."));
    if (!pcmUploadPath.isEmpty()) pushSystem("Recording kept in Voice Notes.");
    setFaceMode(FaceMode::Error);
    setStatus("Voice transport failed", 2200);
    setVoiceDiag("voice: transport " + String(statusCode));
    logf("[VOICE] raw upload failed code=%d err=%s bytes=%u",
         statusCode,
         transportError.c_str(),
         static_cast<unsigned>(dataSize));
    return false;
  }

  if (statusCode < 200 || statusCode >= 300) {
    showVoiceRequestError("Server could not accept the request. Recording kept in Voice Notes.");
    logf("[VOICE] HTTP error status=%d body=%s", statusCode, response.c_str());
    if (statusCode == 504) {
      pushError("Assistant reply timeout.");
      setStatus("Assistant timeout", 2200);
      setVoiceDiag("voice: assistant timeout");
    } else {
      pushError("Voice HTTP error: " + String(statusCode));
      setStatus("Voice turn failed", 2000);
      setVoiceDiag("voice: http " + String(statusCode));
    }
    if (!response.isEmpty()) {
      pushError(response);
    }
    setFaceMode(FaceMode::Error);
    setHttpDiag("voice: http " + String(statusCode));
    return false;
  }

  DynamicJsonDocument resp(4096);
  gVoiceReplyNotifyUntilMs = millis() + 600000U;
  auto err = deserializeJson(resp, response);
  if (err) {
    showVoiceRequestError("Could not read the server receipt. Open chat to check delivery.");
    pushError("Could not parse voice reply.");
    setFaceMode(FaceMode::Error);
    setStatus("Voice parse failed", 2000);
    setVoiceDiag("voice: json parse failed");
    logf("[VOICE] JSON parse failed body=%s", response.c_str());
    return false;
  }

  String transcript = resp["transcript"] | resp["text"] | "";
  String reply = resp["reply"] | resp["full_text"] | "";
  String shortText = resp["short_text"] | "";
  String deviceActionsJson;
  if (!resp["device_actions"].isNull()) {
    serializeJson(resp["device_actions"], deviceActionsJson);
  }
  if (reply.isEmpty()) {
    reply = shortText;
  }
  logf("[VOICE] transcript=%s", transcript.c_str());
  logf("[VOICE] reply=%s", reply.c_str());
  if (!transcript.isEmpty()) {
    pushUser(transcript);
    setVoiceDiag("voice: transcript ok");
  }
  if (resp["pending"] | false) {
    gVoiceReplyPending = true;
    gAssistantPendingVisible = false;
    gVoiceReplyAfterSeq = resp["after_seq"] | 0;
    const uint32_t receiptSeq=resp["reply_seq"] | 0;
    if(receiptSeq>gInboxLastSeq) gInboxLastSeq=receiptSeq;
    gVoiceReplyPendingMs = millis();
    gLastInboxAutoPollMs = 0;
    pushSystem("Request accepted. Reply will arrive in chat.");
    setFaceMode(FaceMode::Idle);
    setStatus("Request accepted", 1500);
    M5Cardputer.Speaker.tone(1047,90);
    showVoiceNotice(transcript, true);
    // A transport acknowledgement is not an assistant answer and never TTS.
    return true;
  }
  gVoiceReplyPending = false;
  gAssistantPendingVisible = false;
  setFaceMode(FaceMode::Idle);
  const uint32_t replySeq = resp["reply_seq"] | 0;
  if (replySeq > gInboxLastSeq) gInboxLastSeq = replySeq;
  if (!reply.isEmpty()) {
    appendAssistantReply(reply);
    showVoiceNotice(reply, false);
    gQueuedVoiceReplySpeech = cleanReplyForDevice(reply);
  } else {
    setFaceMode(FaceMode::Idle);
    setStatus("No reply", 1200);
    showVoiceNotice("Server returned no text. Open chat to check.", false);
  }
  if (!deviceActionsJson.isEmpty()) {
    executeOrDeferDeviceActionsJson(deviceActionsJson);
  }
  return true;
}

void syncClockFromNtp(bool force) {
  ensureBangkokTimezone();
  if (!gWifiReady) {
    return;
  }
  uint32_t now = millis();
  if (gLastTimeSyncAttemptMs != 0 && !gTimeValid) {
    if (hasValidSystemTime()) {
      gTimeValid = true;
      gLastTimeSyncMs = now;
      persistRtcFromSystemTime();
      setStatus("Clock synced", 1000);
      logf("[TIME] synced epoch=%lu", static_cast<unsigned long>(time(nullptr)));
      return;
    }
    if (now - gLastTimeSyncAttemptMs < 8000) {
      return;
    }
    logf("[TIME] sync timed out");
  }
  if (!force) {
    if (gTimeValid && gLastTimeSyncMs != 0 && millis() - gLastTimeSyncMs < kTimeResyncMs) {
      return;
    }
    if (gLastTimeSyncAttemptMs != 0 && millis() - gLastTimeSyncAttemptMs < kTimeSyncRetryMs) {
      return;
    }
  }

  gLastTimeSyncAttemptMs = now;
  gTimeValid = hasValidSystemTime();
  if (gTimeValid) {
    gLastTimeSyncMs = now;
    return;
  }
  configTzTime(kBangkokTz, "time.google.com", "pool.ntp.org", "time.cloudflare.com");
  setStatus("Clock sync...", 700);
}
