# Security review, 2026-10-16

Scope: S1-ADV source, bridge dependencies, HTTP/WS authorization boundaries,
OTA/media transport, setup provisioning, gateway routing and deployment
templates. This is a maintainer review with local attack regression tests,
not an independent penetration test or a guarantee that no vulnerabilities exist.

The firmware security source version is **0.2.146-security.1**. It is based on
the public 0.2.146 development source; it does not claim features from a separate
device build. Publishing source does not update an already flashed device.

## Findings and changes

| Finding | Impact | Fix |
| --- | --- | --- |
| Unauthenticated feed JSON `null`, compatibility null payload, malformed upgrade URL authority | Bridge process termination, availability loss | Validate frame shape; route with a fixed URL base; contain compatibility handler failures |
| Compatibility route bypassed the main failed-auth limiter; connections were unbounded | Brute-force and resource exhaustion exposure | Shared auth buckets on all WS routes, origin policy, per-IP/global connection caps |
| Internal OTA enqueue relied on the peer being loopback | A local reverse proxy could make a remote request appear local | Disabled by default; separate admin token plus device token; reject forwarded headers; Nginx blocks `/internal/` |
| Shared setup Wi-Fi password and no CSRF check | Nearby attacker could change credentials/bridge endpoint during setup | Random password per setup boot, displayed on device; AP-interface restriction; random CSRF token; bounded form values |
| Download URLs received from manifests/media could carry the device token to another origin; HTTP/debug TLS bypasses existed | Credential theft, MITM, malicious OTA on an insecure transport | Verified TLS required; same configured HTTPS origin for authenticated downloads; no insecure realtime mode; OTA/asset path checks |
| Legacy WebServer multipart boundary allocation and unsafe response header construction | Stack corruption and header splitting risk | Project-local boundary/terminator backports and CR/LF rejection; bounded request lines and 4 KiB provisioning bodies |
| Costly authenticated operations and media processing lacked common bounds | Resource exhaustion with a device token | Request start/concurrency limits; FFmpeg input format/protocol restrictions, 120 s media and 30 s process caps; bounded TTS output; remove raw upload temp files |
| eSpeak text was passed in its option position | Text beginning with options could alter CLI behavior | Explicit `--` separator before speech text |
| Persisted topic mapping overrode new config; generated sessions hardcoded `main` | Intended agent isolation/remapping could be ineffective | Config session mapping is authoritative, old topic caches revoked on remap, created sessions retain the selected agent |
| Placeholder/reused tokens and permissive new state-file modes | Weak credential setup and local credential exposure | Reject short/placeholder/duplicate/gateway-reused device tokens; private new directories/files and service umask |

The WebServer backport targets the upstream reports
[GHSA-8cmm-3887-r32j](https://github.com/espressif/arduino-esp32/security/advisories/GHSA-8cmm-3887-r32j)
and [GHSA-5476-9jjq-563m](https://github.com/espressif/arduino-esp32/security/advisories/GHSA-5476-9jjq-563m).
The current parser implementation was inspected directly. No exploit was sent
to a physical Cardputer.

## Verification

- The feed `null` regression first reproduced process exit on the old source.
- `npm run test:boundaries`: 14 passing tests, including process survival,
  proxy/admin denial, auth/connection/request caps, agent preservation, session
  remapping and denial of an uploaded playlist's internal HTTP fetch.
- Security policy tests, 3 gateway interruption tests, full bridge mock smoke,
  compatibility smoke and realtime contract smoke pass.
- Firmware URL/path policy tests and ESP32-S3 / 8 MB build pass. Build output
  selects project-local `WebServer 2.0.0-s1adv.1`.
- `npm audit` reports no known dependency vulnerabilities at review time.
- Source/history credential scan is bounded by known patterns and local current
  credentials; a clean result cannot detect every possible secret format.

## Trust boundaries that remain

A valid device token can send requests to its configured OpenClaw agent. If
that agent can execute host commands or read private data, those capabilities
remain reachable through the agent. Use a dedicated restricted agent for shared
hardware; a topic allowlist is not a sandbox. See OpenClaw's
[security model](https://docs.openclaw.ai/gateway/security) and
[tool policy](https://docs.openclaw.ai/gateway/config-tools/tool-policy).

OTA verifies the HTTPS server and image SHA-256. It is not an independently
signed firmware trust chain. A compromised bridge/publisher can serve malicious
firmware. This build does not provision secure-boot or flash-encryption eFuses;
physical flash/NVS extraction can reveal embedded credentials. Keep provisioned
binaries and the device private; rotate a lost device's token.

The Arduino ESP32 framework remains on a legacy version for compatibility.
Specific WebServer backports do not establish that all bundled ESP-IDF code is
free of vulnerabilities. Physical provisioning, Wi-Fi/TLS, audio, OTA and
rollback still require device testing after this source update.
