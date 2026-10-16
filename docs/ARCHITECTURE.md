# S1-ADV architecture

The ESP32-S3 owns keyboard input, recording/playback, display, local apps and
OTA application. It stores settings in NVS and optional media on microSD.
It does not run an LLM or hold the OpenClaw gateway's credentials.

The Node bridge authenticates each device with its own token and an explicit
topic allowlist. It translates HTTP/WS calls into the configured OpenClaw
gateway's session protocol. A separate topic key maps to an agent session key;
Telegram is optional and is disabled in the public example.

| Surface | Purpose |
| --- | --- |
| `GET /healthz` | Process liveness and upstream connectivity |
| `GET /api/cardputer/v1/topics` | Allowed topics |
| `GET /api/cardputer/v1/topics/{key}/history` | History pagination |
| `POST /api/device-text-turn` | Device-compatible text round trip |
| `POST /api/device-audio-turn-raw` | Raw microphone turn |
| `WS /api/cardputer/v1/stream` | Live feed and replay |
| `/api/cardputer/assets/*` | Authenticated media library |
| `/api/cardputer/firmware/*` | Authenticated OTA manifest and binary |

The device gets a constrained bridge token. The bridge holds its gateway token
and a persistent gateway device identity. Keep both secrets private and restrict
the service's filesystem access. Remote connections use a TLS reverse proxy.
The firmware's built-in CA is ISRG Root X1; a different certificate chain needs
a deliberate CA bundle change and a fresh build.

Firmware-request automation, external integrations and realtime model routes
exist in the development source but need site-specific services and permissions.
They are outside the basic installation and should not be enabled implicitly.

Firmware implementation is split into ordered `src/main_parts/*.inc` fragments;
`src/main.cpp` includes them as one translation unit. Preserve include order.
This standalone repository contains the Cardputer firmware and the OpenClaw
bridge. The original OmniBot desktop hub and other device targets are outside
its scope. See [Credits](../CREDITS.md) for the original foundation.
