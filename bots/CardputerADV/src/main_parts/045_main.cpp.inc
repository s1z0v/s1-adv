bool handleLibraryKey(char key, const Keyboard_Class::KeysState& keys) {
  char lowerKey = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (lowerKey == 'r') {
    scanAudioAssets();
    setStatus("Library rescanned", 900);
    return true;
  }
  if (lowerKey == 'f') {
    setUiMode(UiMode::AudioFolders);
    return true;
  }
  int folderCount = audioAssetCountForCurrentFolder();
  if (gAudioAssets.empty() || folderCount == 0) {
    return lowerKey == 'r' || lowerKey == 'f';
  }
  if (key == ',' || key == ';') {
    moveSelectedAudioAssetInFolder(-1);
    setStatus("Asset " + String(audioAssetRankInCurrentFolder(gSelectedAudioAsset) + 1) + "/" + String(folderCount), 500);
    return true;
  }
  if (key == '.' || key == '/') {
    moveSelectedAudioAssetInFolder(1);
    setStatus("Asset " + String(audioAssetRankInCurrentFolder(gSelectedAudioAsset) + 1) + "/" + String(folderCount), 500);
    return true;
  }
  if (keys.enter || keys.space || key == '\n' || key == '\r' || key == ' ') {
    if (gPlaybackActive) {
      stopPlaybackStream();
      gPlaybackActive = false;
      setStatus("Playback stopped", 800);
      return true;
    }
    clampSelectedAudioAssetToFolder();
    if (!startPlaybackStreamFromWavFile(gAudioAssets[gSelectedAudioAsset].path, "asset: " + gAudioAssets[gSelectedAudioAsset].title)) {
      setStatus("Asset play failed", 1200);
    }
    return true;
  }
  return false;
}

bool handleAudioFoldersKey(char key, const Keyboard_Class::KeysState& keys) {
  char lowerKey = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (lowerKey == 'r') {
    scanAudioAssets();
    setStatus("Folders rescanned", 900);
    return true;
  }
  if (gAudioFolders.empty()) {
    rebuildAudioFolders();
  }
  if (key == ',' || key == ';') {
    gSelectedAudioFolder = max<int>(0, gSelectedAudioFolder - 1);
    setStatus(audioFolderLabel(gAudioFolders[gSelectedAudioFolder].category), 700);
    return true;
  }
  if (key == '.' || key == '/') {
    gSelectedAudioFolder = min<int>(static_cast<int>(gAudioFolders.size()) - 1, gSelectedAudioFolder + 1);
    setStatus(audioFolderLabel(gAudioFolders[gSelectedAudioFolder].category), 700);
    return true;
  }
  if (keys.enter || keys.space || key == '\n' || key == '\r' || key == ' ') {
    gSelectedAudioFolder = clampValue<int>(gSelectedAudioFolder, 0, max<int>(0, static_cast<int>(gAudioFolders.size()) - 1));
    gAudioFolderFilter = gAudioFolders.empty() ? "" : gAudioFolders[gSelectedAudioFolder].category;
    clampSelectedAudioAssetToFolder();
    setUiMode(UiMode::Library);
    return true;
  }
  return false;
}

bool handleNotesKey(char key, const Keyboard_Class::KeysState& keys) {
  char lowerKey = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (!gNotesScanned) {
    scanNotes();
  }

  if (keys.ctrl && lowerKey == 's') {
    if (gNotesMode == NotesMode::Edit && !gNoteInputBuffer.isEmpty()) {
      appendLineToActiveNote(gNoteInputBuffer);
      gNoteInputBuffer = "";
    }
    gNotesMode = NotesMode::View;
    gNotesStatus = "Saved";
    return true;
  }

  if (gNotesMode == NotesMode::Edit) {
    if (keys.enter || key == '\n' || key == '\r') {
      appendLineToActiveNote(gNoteInputBuffer);
      gNoteInputBuffer = "";
      return true;
    }
    if (keys.del || key == '\b') {
      if (!gNoteInputBuffer.isEmpty()) {
        removeLastUtf8Char(gNoteInputBuffer);
      }
      return true;
    }
    if (keys.ctrl && (lowerKey == 'x' || lowerKey == 'q')) {
      gNotesMode = NotesMode::View;
      gNotesStatus = "View mode";
      return true;
    }
    if (key >= 32 && key < 127 && gNoteInputBuffer.length() < static_cast<int>(kMaxNoteInputChars)) {
      gNoteInputBuffer += translateInputChar(key);
      return true;
    }
    return false;
  }

  if (lowerKey == 'r') {
    scanNotes();
    setStatus("Notes rescanned", 700);
    return true;
  }
  if (lowerKey == 'n') {
    return createNewNote();
  }
  if (lowerKey == 'e') {
    return openSelectedNote(NotesMode::Edit);
  }
  if (lowerKey == 'l' || keys.del || key == '\b') {
    gNotesMode = NotesMode::List;
    gNoteInputBuffer = "";
    gNotesStatus = "List";
    return true;
  }

  if (gNotesMode == NotesMode::List) {
    if (gNotes.empty()) {
      return lowerKey == 'r' || lowerKey == 'n';
    }
    if (key == ',' || key == ';') {
      gSelectedNote = max<int>(0, gSelectedNote - 1);
      gNoteListScrollOffset = max<int>(0, gSelectedNote - 2);
      setStatus(gNotes[gSelectedNote].name, 600);
      return true;
    }
    if (key == '.' || key == '/') {
      gSelectedNote = min<int>(static_cast<int>(gNotes.size()) - 1, gSelectedNote + 1);
      gNoteListScrollOffset = max<int>(0, gSelectedNote - 2);
      setStatus(gNotes[gSelectedNote].name, 600);
      return true;
    }
    if (keys.enter || keys.space || key == '\n' || key == '\r' || key == ' ') {
      return openSelectedNote(NotesMode::View);
    }
    return false;
  }

  if (key == ',' || key == ';') {
    gNoteScrollOffset = max<int>(0, gNoteScrollOffset - 1);
    return true;
  }
  if (key == '.' || key == '/') {
    uint32_t lineCount = 0;
    if (!gActiveNotePath.isEmpty()) {
      fs::FS* fs = activeNotesFs();
      if (fs) {
        lineCount = countNoteLines(*fs, gActiveNotePath);
      }
    }
    int maxScroll = max<int>(0, static_cast<int>(lineCount) - 7);
    gNoteScrollOffset = min<int>(maxScroll, gNoteScrollOffset + 1);
    return true;
  }
  if (keys.enter || keys.space || key == '\n' || key == '\r' || key == ' ') {
    return openSelectedNote(NotesMode::Edit);
  }
  return false;
}

bool handleAssetsKey(char key) {
  char lowerKey = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (lowerKey == 'f') {
    fetchRemoteAssetManifest();
    setStatus("Asset manifest fetched", 900);
    return true;
  }
  if (lowerKey == 's') {
    syncAssetsFromManifest();
    return true;
  }
  if (lowerKey == 'r') {
    loadAssetManifestSummary();
    scanAudioAssets();
    setStatus("Assets reloaded", 900);
    return true;
  }
  return false;
}

bool handleOtaKey(char key, const Keyboard_Class::KeysState& keys) {
  if ((!keys.enter && key != '\n' && key != '\r') || keys.ctrl || keys.alt || keys.fn) return false;
  if (gOtaPendingVerify) { setStatus("Verifying installed update", 1200); return true; }
  if (!homeFirmwareUpdateAvailable()) {
    setStatus(gOtaManifest.parsed ? "Firmware is current" : "Checking for updates", 1200);
    return true;
  }
  // One press queues a fresh authenticated check, then applies only its
  // successful result. Escape and all existing power/hash checks still apply.
  gPendingOtaCheckAction = true;
  gPendingOtaApplyAction = true;
  gPendingOtaActionAfterMs = millis() + 100;
  setStatus("Preparing update", 1200);
  appendRuntimeLog("OTA", "install requested by Enter", true);
  return true;
}
