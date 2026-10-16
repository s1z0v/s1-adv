# Troubleshooting

| Symptom | Check |
| --- | --- |
| No USB port | Use a data cable, hold G0, press Reset, release G0; list ports again |
| Upload or boot fails | ESP32-S3 target, 8 MB flash and included dual OTA partitions |
| Device opens setup | Provision Wi-Fi, bridge URL and token; or configure private `.env` before building |
| Wi-Fi fails | 2.4 GHz coverage and credentials; captive portals need site-specific support |
| Bridge returns 503 | Proxy upstream, bridge listening port, service logs and gateway connection |
| Service says active but no port listens | Check gateway handshake; update bridge client with bounded connection timeout, then restart only the bridge |
| TLS error | Correct hostname, port 443 and certificate chain rooted in firmware's trusted CA |
| 401 or 403 | Device token, device ID and topic allowlist agree on both sides |
| Topics work but no reply | Gateway pairing, scopes, session key, provider authentication and actual upstream readiness |
| Text works, voice fails | FFmpeg, STT binary/model, TTS binary and their service-user permissions |
| OTA appears successful | Verify rebooted version on the device; a download or queued event is insufficient |

Start with `/status`, then capture the serial monitor at 115200 baud. For the
bridge, inspect `journalctl -u openclaw-cardputer-bridge -n 100` on systemd hosts.
Redact SSIDs, private messages, tokens, endpoint details and audio before sharing
logs. A private device binary can contain your Wi-Fi password and token.

After a bridge outage, repeat a short text request once service and gateway
connectivity recover. Do not assume a request reached the agent merely because
the device displayed a waiting animation.

For a bug report include board model, firmware version, commit, OpenClaw version,
which phase fails, and a minimal redacted reproduction. Do not upload state.json,
gateway config, `.env`, provisioned firmware or private voice recordings.
