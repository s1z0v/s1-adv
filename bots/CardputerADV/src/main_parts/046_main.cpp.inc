











bool handleLogsKey(char key) {
  char lowerKey = static_cast<char>(tolower(static_cast<unsigned char>(key)));
  if (key == ',' || key == ';') {
    gLogScrollOffset = min<int>(gLogScrollOffset + 1, max<int>(0, static_cast<int>(gRuntimeLogs.size()) - 9));
    return true;
  }
  if (key == '.' || key == '/') {
    gLogScrollOffset = max<int>(0, gLogScrollOffset - 1);
    return true;
  }
  if (lowerKey == 'r') {
    scanAudioAssets();
    loadAssetManifestSummary();
    loadOtaManifestSummary();
    appendRuntimeLog("LOG", "manual refresh", true);
    setStatus("Diagnostics refreshed", 900);
    return true;
  }
  if (lowerKey == 'u') {
    uploadRuntimeLogs();
    return true;
  }
  return false;
}
