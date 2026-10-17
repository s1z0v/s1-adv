#pragma once
#include <WebSocketsClient.h>
#include <WiFiClientSecure.h>

// TLS is connected by a worker. Protocol events and audio still belong to loopTask.
class RealtimeSocket : public WebSocketsClient {
 public:
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
    _client.status=WSC_HEADER; _lastHeaderSent=millis(); headerLine_="";
    socket->setTimeout(WEBSOCKETS_TCP_TIMEOUT);
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
          if (_client.status!=WSC_HEADER) return;
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
    if (_client.status==WSC_CONNECTED) WebSocketsClient::loop();
  }
 private:
  String headerLine_;
};
