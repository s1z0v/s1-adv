  mbedtls_sha256_context shaCtx;
  mbedtls_sha256_init(&shaCtx);
  mbedtls_sha256_starts(&shaCtx, 0);
  WiFiClient* stream = http.getStreamPtr();
  uint32_t written = 0;
  uint32_t lastLogged = 0;
  uint32_t lastByteMs = millis();
  while (written < expectedSize) {
    size_t available = stream ? stream->available() : 0;
    if (!available) {
      if (!http.connected()) {
        break;
      }
      if (millis() - lastByteMs > 60000) {
        esp_ota_abort(otaHandle);
        mbedtls_sha256_free(&shaCtx);
        http.end();
        finishTransferUi("download stalled", false);
        setHttpDiag("ota: stalled");
        return fail("stream stalled " + String(static_cast<unsigned>(written)));
      }
      updateTransferUi(written, expectedSize, "receiving");
      delay(2);
      continue;
    }

    size_t toRead = min(available, kOtaIoBufferBytes);
    toRead = min<uint32_t>(static_cast<uint32_t>(toRead), expectedSize - written);
    int readBytes = stream->readBytes(gOtaIoBuffer, toRead);
    if (readBytes <= 0) {
      delay(1);
      continue;
    }

    otaErr = esp_ota_write(otaHandle, gOtaIoBuffer, static_cast<size_t>(readBytes));
    if (otaErr != ESP_OK) {
      esp_ota_abort(otaHandle);
      mbedtls_sha256_free(&shaCtx);
      http.end();
      finishTransferUi("flash write failed", false);
      return fail("write err " + String(static_cast<int>(otaErr)) +
                  " at " + String(static_cast<unsigned>(written)));
    }
    mbedtls_sha256_update(&shaCtx, gOtaIoBuffer, static_cast<size_t>(readBytes));
    written += static_cast<uint32_t>(readBytes);
    lastByteMs = millis();
    updateTransferUi(written, expectedSize, "receiving + flashing");
    if (written == expectedSize || written - lastLogged >= 256UL * 1024UL) {
      lastLogged = written;
      otaLog("direct flash " + String(static_cast<unsigned>(written / 1024)) + "k/" +
             String(static_cast<unsigned>(expectedSize / 1024)) + "k", false);
    }
    delay(1);
  }

  uint8_t hash[32];
  mbedtls_sha256_finish(&shaCtx, hash);
  mbedtls_sha256_free(&shaCtx);
  http.end();

  if (written != expectedSize) {
    esp_ota_abort(otaHandle);
    finishTransferUi("flash short", false);
    return fail("short write " + String(static_cast<unsigned>(written)) +
                "/" + String(static_cast<unsigned>(expectedSize)));
  }

  String actualSha = bytesToHex(hash, sizeof(hash));
  actualSha.toLowerCase();
  String expectedSha = gOtaManifest.sha256;
  expectedSha.toLowerCase();
  if (actualSha != expectedSha) {
    esp_ota_abort(otaHandle);
    finishTransferUi("SHA mismatch", false);
    return fail("sha mismatch expected=" + expectedSha.substring(0, 12) +
                " actual=" + actualSha.substring(0, 12));
  }

  bool ok = finishOtaApply(otaHandle, next, written, expectedSize);
  if (!ok) {
    return fail("direct flash failed");
  }
  return true;
}

String urlEncodePathSegment(const String& raw) {
  static const char* hex = "0123456789ABCDEF";
  String out;
  out.reserve(raw.length() + 8);
  for (size_t i = 0; i < raw.length(); ++i) {
    uint8_t c = static_cast<uint8_t>(raw[i]);
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '~') {
      out += static_cast<char>(c);
    } else {
      out += '%';
      out += hex[(c >> 4) & 0x0F];
      out += hex[c & 0x0F];
    }
  }
  return out;
}
