# Public source validation

Checked on **2026-10-16**. This record describes the publication candidate;
it does not certify a fresh physical installation.

| Check | Result |
| --- | --- |
| Generic firmware build, without private provisioning | PASS, ESP32-S3 / 8 MB / dual OTA |
| Build with pinned libraries and PlatformIO Core 6.1.19 | PASS |
| App flash usage | 2,067,161 / 3,145,728 bytes, 65.7% of one OTA app slot |
| Static RAM usage | 113,104 / 327,680 bytes, 34.5% |
| Bridge dependency audit | No reported vulnerabilities in the installed dependency set |
| Bridge security policy tests | PASS |
| Security boundary regressions | PASS, 14 tests; see [security review](SECURITY-REVIEW.md) |
| Firmware URL/path policy host test | PASS |
| Gateway interruption regression tests | PASS, 3 tests: early close, silent handshake, HTTP while gateway unavailable |
| Bridge mock smoke | PASS: topics, history, text, voice media, stream/replay, idempotency, auth and OTA endpoints |
| Realtime protocol contract smoke | PASS, synthetic |
| Turn delivery integration | PASS, 25 synthetic cases |
| New setup guide local links | PASS |

The firmware toolchain reported existing Arduino UART and IRremote pragma warnings, but
completed the build successfully. Runtime and audio quality are not established
by compilation or mock tests.

Before publication, a local scan checked tracked source/history and new files
against credential patterns and the maintainer's current local device/bridge
credentials. It found no matches. This bounded scan is not a complete security
audit. Private configs, recordings, runtime state and provisioned binaries are
excluded from this publication.

Remaining checks: USB flash of a freshly provisioned public build, boot/version
readback, on-device text and push-to-talk round trips, and setup on another host.
There is no prebuilt public firmware release in this publication.
