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

bool fileManagerBusy() {
  return gRecording || gSubmitting || gPlaybackActive || gRealtimeActive ||
         gInboxHttpBusy || gVoiceReplySpeechBusy || gVoiceDialBusy || gRealtimeDialBusy ||
         gBlockingInputPumpActive || gBootBackgroundActive;
}

void refreshFileManager() {
  gFileDelete.cancel();
  gFileEntries.clear();
  gFilesTruncated = false;
  if (!gSdReady) { gFilesStatus = "Insert SD card"; return; }
  if (fileManagerBusy()) { gFilesStatus = "Storage busy; R to retry"; return; }
  if (!sd_file_manager::validPath(gFilesDir.c_str())) gFilesDir = "/";
  File dir = SD.open(gFilesDir.c_str(), "r");
  if (!dir || !dir.isDirectory()) { gFilesStatus = "Cannot open folder"; return; }
  for (;;) {
    File file = dir.openNextFile();
    if (!file) break;
    String name = filenameFromPath(String(file.path()));
    String path = gFilesDir == "/" ? "/" + name : gFilesDir + "/" + name;
    if (sd_file_manager::directChild(gFilesDir.c_str(), path.c_str())) {
      if (gFileEntries.size() >= sd_file_manager::kMaxEntries) {
        gFilesTruncated = true; file.close(); break;
      }
      gFileEntries.push_back({name, path, static_cast<uint64_t>(file.size()), file.isDirectory()});
    }
    file.close();
  }
  dir.close();
  std::sort(gFileEntries.begin(), gFileEntries.end(), [](const SdFileEntry& a, const SdFileEntry& b) {
    if (a.directory != b.directory) return a.directory;
    return a.name.compareTo(b.name) < 0;
  });
  gSelectedFile = clampValue<int>(gSelectedFile, 0, max<int>(0, static_cast<int>(gFileEntries.size()) - 1));
  gFilesStatus = gFilesTruncated ? "First 128; refresh after cleanup" :
                 gFileEntries.empty() ? "Empty folder" : String(gFileEntries.size()) + " entries";
}

bool handleFileManagerKey(char key, const Keyboard_Class::KeysState& keys) {
  const char lower = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  const bool escape = key == 27 || key == '`' || key == '~' || hasHidKey(keys, kHidKeyEscape);
  if (gFileDelete.pending()) {
    const String path = gFileDelete.path.c_str();
    const bool busy = !gSdReady || fileManagerBusy();
    bool directory = true;
    uint64_t size = 0;
    bool exists = false;
    if (!busy && lower == 'y' && !keys.ctrl && !keys.alt && !keys.fn) {
      File file = SD.open(path.c_str(), "r");
      if (file) { exists = true; directory = file.isDirectory(); size = file.size(); file.close(); }
    }
    const bool confirmed = gFileDelete.confirm(
        lower == 'y' && !keys.ctrl && !keys.alt && !keys.fn ? 'y' : 'n',
        gFilesDir.c_str(), path.c_str(), size, directory, busy || !exists);
    if (confirmed) {
      const bool removed = SD.remove(path.c_str());
      refreshFileManager();
      gFilesStatus = removed ? "File deleted" : "Delete failed";
      if (removed) { gNotesScanned = false; clearEmojiCache(); }
    } else {
      gFilesStatus = lower == 'y' ? "Not deleted: busy or changed" : "Deletion cancelled";
    }
    return true;
  }
  if (keys.tab || keys.ctrl) return false;
  if (escape) {
    if (gFilesDir == "/") setUiMode(UiMode::Home);
    else { gFilesDir = parentDirOf(gFilesDir); gSelectedFile = 0; refreshFileManager(); }
    return true;
  }
  if (lower == 'r') { refreshFileManager(); return true; }
  if (fileManagerBusy()) { gFilesStatus = "Storage busy; R to retry"; return true; }
  if (key == ',' || key == ';') gSelectedFile = max<int>(0, gSelectedFile - 1);
  else if (key == '.' || key == '/')
    gSelectedFile = min<int>(max<int>(0, static_cast<int>(gFileEntries.size()) - 1), gSelectedFile + 1);
  else if (!gFileEntries.empty()) {
    gSelectedFile = clampValue<int>(gSelectedFile, 0, static_cast<int>(gFileEntries.size()) - 1);
    const auto& entry = gFileEntries[gSelectedFile];
    if (keys.enter || key == '\r' || key == '\n') {
      if (entry.directory) { gFilesDir = entry.path; gSelectedFile = 0; refreshFileManager(); }
      else gFilesStatus = "D or Del to delete this file";
    } else if (lower == 'd' || keys.del || key == '\b') {
      if (!gFileDelete.arm(gFilesDir.c_str(), entry.path.c_str(), entry.size, entry.directory))
        gFilesStatus = "Folders cannot be deleted";
    }
  }
  return true;
}
