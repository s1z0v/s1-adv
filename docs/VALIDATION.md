# Public source validation

## Community plugin and portable setup, 2026-10-18

The bridge package is `openclaw-s1-adv@0.2.0`, native plugin ID `s1-adv`.
Local Node host tests cover private/dry-run setup, native config targeting,
agent routing, build/release ownership and source/hash fences, lifecycle races,
HTTP/WS authorization, audio ownership/remapping, upload cleanup and storage
budgets. The final boundary suite has 49 tests; installer/release/lifecycle has
12; gateway interruption has 3. Mock, opted-in compatibility and Realtime
contract smokes pass. Package allowlist and dependency audit are checked too.
These are different checks, not one large certification count.

Turn ownership tests cover overlapping requests in one session, late replies
after HTTP timeout, restart/idempotent retry, opaque Gateway run receipts and
tool commentary. Matching uses the persisted Gateway run ID rather than the
first assistant message after a timestamp. Thirteen focused cases also cover
legacy final-chat events, duplicate transports, an in-flight opaque receipt and
answers that repeat their own or a neighboring request's text.

On a second Linux host, the tarball was installed with the native OpenClaw
installer in an isolated profile. OpenClaw `2026.7.2-beta.1` and Node `22.23.0`
loaded the plugin and started its bridge. Setup/enable/doctor and the real
upstream connection were exercised. A real text response returned HTTP 200
in 34.036 s. The first cold turn exceeded the HTTP wait but later appeared in
the durable event queue; this is not a low-latency guarantee. The final native
package also returned a real text answer with a 205,782-byte spoken-reply WAV
in 101.444 s; its authenticated download matched SHA-256, appeared in the
asset manifest and had the required current-session ownership metadata.

A synthetic 66,256-byte WAV went through local Whisper and the actual agent.
The pending receipt arrived in 19.598 s; its later assistant answer appeared
in the authenticated event queue. Separate eSpeak TTS returned 107,862 PCM
bytes in 0.033 s. Speech tests use synthetic host audio, not the physical mic.
The pinned Whisper build was v1.9.5 (`d1be6fde11ac6e0407606b4e42fe72d34add8037`),
multilingual base model SHA-256
`60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`.

ClawHub package validation against the OpenClaw 2026.10.4 API reported no
contract issues. Static API validation is not a runtime test of that version.
Firmware wrapper host tests use a disposable tiny image to exercise refusal
and publication fences; they do not count as an ESP32 build or hardware proof.
A real ESP32-S3/8 MB build also passed on that host through the generated
private wrapper, using PlatformIO Core 6.1.19 and clean source commit
`1dd76864f21fc4661ffb1ed9509b4b43ff050f0c` (firmware `0.2.166-dev`).
The isolated OTA publisher and authenticated manifest/file smoke passed:
1,991,424 bytes, SHA-256
`bf398201410cf5e0f2c08a9ebe635f8cd7a7d2b46c0a1d53d4d969e775e83c1a`.
The release lock was released only after byte verification. This candidate
was private and was not offered to the maintainer's physical device.

Fresh-owner HTTPS/device provisioning, USB boot readback, physical audio/OTA
and the separate firmware stability canaries remain distinct acceptance.

The security property harness reports one million generated transitions for
its bounded admission/proxy checks and a small OTA persistence model. It makes
no billion-combination, exhaustive-state or release-certificate claim.
See the [current security review](SECURITY-REVIEW-2026-10-18.md).


## Source recovery, 2026-10-17

Source `0.2.147-security.1` restores the released procedural eye changes on
top of the public security fixes. The portable generic firmware build passed
with PlatformIO Core 6.1.19: app flash 1,910,309 / 3,145,728 bytes (60.7%), static
RAM 111,176 / 327,680 bytes (33.9%).

On Linux, the recovered UI and release wiring checks, firmware transport policy
host test, and actual eye renderer check passed. The renderer covers 15,360
geometry cases, all six skins, blink/wrap and bounded drawing operations.
PNG conversion is optional on macOS; Linux retains native PPM previews.
These checks also run in the firmware CI job.

Source provenance and the source-before-OTA workflow are recorded in
[source continuity](SOURCE-SYNC.md). No device installation is claimed.

## Earlier publication checks

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

At that publication checkpoint, fresh USB/boot, physical text/push-to-talk and
second-host setup were still pending. The later community-plugin qualification
above records the second-host work; it does not replace physical-device checks.
There was no prebuilt public firmware release in that source-only publication.
