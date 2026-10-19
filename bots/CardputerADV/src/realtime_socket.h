#pragma once
#include <WebSocketsClient.h>
#include <WiFiClientSecure.h>
#include "realtime_frame_gate.h"

static_assert(WEBSOCKETS_MAX_DATA_SIZE == realtime_transport::FrameGate::kMaxPayload,
              "Realtime frame bound must match the WebSockets parser");

// Non-owning view: WebSocketsClient still owns/deletes _client.ssl. Looking up
// the owner slot on every call also makes callbacks that disconnect safe.
class RealtimeFrameClient : public WiFiClient {
 public:
  void bind(WiFiClientSecure** owner) { owner_ = owner; gate_.reset(); lastProgress_ = millis(); }
  int available() override { return static_cast<int>(gate_.available()); }
  int read(uint8_t* output, size_t count) override { return gate_.read(output, count); }
  int read() override { uint8_t byte; return read(&byte, 1) == 1 ? byte : -1; }
  int peek() override { return gate_.peek(); }
  uint8_t connected() override {
    auto* tls = socket();
    return tls && (gate_.available() || tls->connected());
  }
  size_t write(const uint8_t* input, size_t count) override {
    auto* tls = socket(); return tls ? tls->write(input, count) : 0;
  }
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  void flush() override {}
  void stop() override { auto* tls = socket(); if (tls) tls->stop(); }

  // Called only by loopTask, never from available()/the library's wait loop.
  bool pump(uint32_t started) {
    auto* tls = socket();
    uint8_t chunk[256];
    size_t budget = 4096;
    while (tls && !gate_.ready() && gate_.error() == Error::None && budget &&
           millis() - started < 4U) {
      const int present = tls->available();
      if (present <= 0) break;
      size_t take = static_cast<size_t>(present);
      if (take > sizeof(chunk)) take = sizeof(chunk);
      if (take > gate_.wanted()) take = gate_.wanted();
      if (take > budget) take = budget;
      const int got = tls->read(chunk, take);
      if (got <= 0) break;
      gate_.append(chunk, static_cast<size_t>(got));
      budget -= static_cast<size_t>(got);
      lastProgress_ = millis();
    }
    return gate_.error() == Error::None &&
           (!gate_.buffered() || gate_.ready() || millis() - lastProgress_ <= WEBSOCKETS_TCP_TIMEOUT);
  }

 private:
  using Error = realtime_transport::FrameGate::Error;
  WiFiClientSecure** owner_ = nullptr;
  realtime_transport::FrameGate gate_;
  uint32_t lastProgress_ = 0;
  WiFiClientSecure* socket() const { return owner_ ? *owner_ : nullptr; }
};

// TLS is connected by a worker. Protocol events and audio still belong to loopTask.
class RealtimeSocket : public WebSocketsClient {
 public:
  ~RealtimeSocket() override { disconnect(); }
  String newHandshakeKey() {
    uint8_t nonce[16];
    for (auto& byte:nonce) byte=static_cast<uint8_t>(esp_random());
    return base64_encode(nonce,sizeof(nonce));
  }
  unsigned receiveOpcode() const { return _client.cWsHeaderDecode.opCode; }
  size_t receiveLength() const { return _client.cWsHeaderDecode.payloadLen; }
  unsigned receiveHeaderBytes() const { return _client.cWsRXsize; }
  unsigned heartbeatTimeouts() const { return _client.pongTimeoutCount; }
  void adopt(WiFiClientSecure* socket,const String& key) {
    _client.ssl=socket; _client.tcp=socket; _client.cKey=key;
    _client.isSSL=true;
    _client.status=WSC_HEADER; _lastHeaderSent=millis(); headerLine_="";
    // ESP32 WiFiClientSecure takes seconds, unlike Stream's milliseconds.
    socket->setTimeout((WEBSOCKETS_TCP_TIMEOUT+999U)/1000U);
    frameClient_.bind(&_client.ssl);
  }
  void pollConnected() {
    if (!_client.tcp) return; // Never let the library dial on loopTask.
    if (!_client.tcp->connected() && !_client.tcp->available()) {
      clientDisconnect(&_client,"Connection lost"); return;
    }
    if (_client.status==WSC_HEADER) {
      // readStringUntil() can block for seconds on a partial header.
      unsigned budget=1024;
      while (_client.tcp && _client.tcp->available() && budget--) {
        int ch=_client.tcp->read();
        if (ch<0) break;
        if (ch=='\n') {
          String line=headerLine_; headerLine_="";
          handleHeader(&_client,&line);
          if (_client.status!=WSC_HEADER) {
            if (_client.status==WSC_CONNECTED && _client.ssl) {
              _client.tcp=&frameClient_;
            }
            return;
          }
        } else if (ch!='\r') {
          if (headerLine_.length()>=512) {
            clientDisconnect(&_client,"Upgrade header too long"); return;
          }
          headerLine_+=static_cast<char>(ch);
        }
      }
      if (_client.tcp && millis()-_lastHeaderSent>8000U)
        clientDisconnect(&_client,"Upgrade response timeout");
      return;
    }
    if (_client.status==WSC_CONNECTED) {
      // The library consumes one frame per loop. PCM plus text can arrive
      // faster than the display loop, so drain a bounded burst before yielding.
      const uint32_t started=millis();
      for (unsigned frame=0;frame<8;++frame) {
        if (!frameClient_.pump(started)) {
          clientDisconnect(&_client,"Incomplete or invalid WebSocket frame"); return;
        }
        // loop() can reconnect synchronously if EOF occurs after our initial
        // guard. Run only its connected path; dialing belongs to the worker.
        handleClientData();
        if (_client.tcp && _client.status==WSC_CONNECTED) handleHBPing();
        if (_client.tcp && _client.status==WSC_CONNECTED) handleHBTimeout(&_client);
        if (!_client.tcp || _client.status!=WSC_CONNECTED ||
            (!_client.ssl->available() && !_client.tcp->available()) || millis()-started>=4U) break;
      }
    }
  }
 private:
  String headerLine_;
  RealtimeFrameClient frameClient_;
};
