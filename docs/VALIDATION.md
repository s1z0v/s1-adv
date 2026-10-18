# Public source validation

## Firmware skills and native deployment, plugin 0.3.3, 2026-10-19

ClawHub published source `fd8f4de`, tag `bridge-v0.3.3`, as **ESP32 S1-ADV**.
The 33-file artifact is 4,523,373 bytes; SHA-256 is
`55e48e9b34e90951274134dde93af4636d4394bb83e7197b48c9a3a6604cc7c5`.
The current aggregate automated scan reports **Clean**, with source-linked
metadata and no signed build provenance. This is not a security guarantee.
Earlier 0.3.2 received Review concerning optional credential paths; 0.3.3
explicitly documents process privileges, provider destinations, WIF and the
disabled legacy OAuth fast lane. No scanner checks were bypassed.

The package contains setup skill `s1-adv` and workflow skill `s1-adv-firmware`.
Both passed frontmatter validation. OpenClaw 2026.8.1 on Node 22.23.1 installed
the exact ClawHub package, discovered both skills as eligible/model-visible and
user-invocable, and retained the private device identity and OTA candidate.
All 33 installed file hashes matched the registry artifact's file manifest.
The Gateway-managed child serves loopback; a restricted proxy preserves the
existing external HTTPS origin. The old standalone listener is stopped.
Old uncertain requests/history/recordings remain preserved in private storage;
they were not automatically replayed into the distinct new session.

The runtime change in 0.3.2 preserved firmware BUILDING status through the durable
outbox. Only its own correlated reply updates a job, and a status/final answer
does not release the lane without exact terminal proof. All 113 host tests,
security policy checks, text/voice smoke, Realtime contract and dependency audit
passed. The later 0.3.3 changes only packaging, skills and documentation; its
12 installer/lifecycle checks and package inspection passed. Bridge/firmware CI
passed for both release source commits. CI also runs the durable outbox suite
explicitly, including restart, uncertain sends, terminal fencing and status cases.

Five sequential checks against the owner's configured real Gateway passed:
three text and two synthetic spoken requests through the actual STT provider.
Each produced its own answer and exact terminal `ok` receipt. Retrying the first
ID did not create another outbox record. Voice acceptance took about 3.8–5.0 s,
with final replies in about 6.8–9.1 s; the first cold text took about 17.6 s.
Configured TTS returned 52,800 bytes of 12 kHz mono PCM. Local and external
authenticated health, asset/topic routes and the existing OTA candidate's full
size/SHA were checked after the native upgrade. These are host/runtime results,
not microphone, speaker, keyboard or display acceptance.

USB boot logs separately identified the owner's installed firmware as 0.2.171
with its expected source commit and a valid OTA slot. USB host-control requests
did not produce command receipts in that session, and an Inbox transport error
was observed. Physical end-to-end acceptance therefore remains pending; five
server checks must not be presented as five physical-device canaries.

## English-only default audio and catalog name, plugin 0.3.1, 2026-10-19

The displayed plugin name is **ESP32 S1-ADV**. Its description names the actual
target, M5Stack Cardputer ADV with ESP32-S3, and its OpenClaw AI text/voice,
Focus and optional firmware/OTA capabilities. The package `openclaw-s1-adv`,
runtime ID `s1-adv`, commands and configuration identity stay compatible.

Only three English cues (5,112,916 bytes) belong to the default plugin archive
and built-in manifest. Russian WAVs were removed from the main source tree and
archive. The [optional download guide](../extras/focus-audio/README.md) points
to their preserved original bytes at `bridge-v0.3.0`, with SHA-256 metadata.
No installer or background process follows those links automatically. Private
overrides and manually installed Russian files remain available; updates do
not delete files already on SD.

All 74 boundary, 12 installer/release/lifecycle and 3 upstream tests pass, as
do the three integration smokes and dependency audit. Plugin Inspector against
OpenClaw 2026.10.4 reports zero API issues. The actual package has 31 files,
4,519,592 compressed bytes, and only the three English WAVs. All three optional
Russian URLs were downloaded and matched their original checksums.

ClawHub published `bridge-v0.3.1`, source `d13d260`, under the displayed name
**ESP32 S1-ADV**, with an aggregate automated scan of **Clean**. Its artifact
SHA-256 is `963fb261b41db3ccc77bfac4aedbb80310ff7b4517d524e4d4b70e185a5c6270`.
Both bridge and firmware CI jobs passed for that source. Existing package/runtime
IDs were retained so installs and private configuration keep their identity.

Native ClawHub upgrade on the isolated OpenClaw 2026.10.4 / Node 26.1.0 profile
passed. All 31 installed files matched the qualified source. The authenticated
default manifest and downloads contained three complete English WAVs with
matching checksums; built-in Russian URLs returned 404. Ordinary upstream and
delivery readiness remained true. Manually installed language assets are covered
separately by the host tests. Physical SD writing/playback is not claimed here.

## Focus audio delivery, plugin 0.3.0, 2026-10-19

The optional library contains six English/Russian PCM16 mono 16 kHz WAV cues,
9,935,646 bytes in total. Their original SHA-256 values are recorded in the
packaged `assets/focus-audio/manifest.json`; the package check verifies every
file, and only these six WAV paths are allowed in the public artifact.
The bridge verifies bundled bytes once at startup and serves the library
without copying it into private state or firmware flash.

Host tests fetch all six files through the actual authenticated HTTP routes
and verify response size, SHA-256 and language. Anonymous manifest/file requests
are refused. Unknown paths are not exposed. Other cases cover a personal
override without overwriting it, disabling bundled distribution, corrupted
bytes and an invalid manifest path. Doctor reports the library independently
of Whisper/TTS availability. Physical SD download, the device's on/off setting
and speaker playback remain firmware acceptance checks, not host-test results.

The complete boundary suite has 74 passing cases; installer/release/lifecycle
has 12 and upstream interruption has 3. All three integration smokes pass, as
do package inspection, dependency audit and the existing security property
harness. Plugin Inspector against OpenClaw 2026.10.4 reports zero API issues.

ClawHub published the source commit `abcd59e`, tag `bridge-v0.3.0`, with
34 files and artifact SHA-256
`17945ac6a7d160f7fe863aaaa3c463b1838dbbfb65a165bb9cde3f599d61c001`.
Its aggregate automated scan reports **Clean**; this is not an independent
security guarantee. The artifact is source-linked, without signed build
provenance. The unchanged archive was installed natively on the isolated
OpenClaw 2026.10.4 / Node 26.1.0 profile. All 34 installed files matched the
qualified source. Its authenticated HTTP routes returned all six complete
WAVs with matching checksums, while anonymous downloads were refused and
upstream/delivery readiness remained true.

Publishing used the documented
[upload-url/storage-id/ticket transport](https://docs.openclaw.ai/clawhub/http-api). CLI
0.23.3 selected direct multipart above the API's documented 4 MB cap and got
HTTP 413. An isolated copy with only that client threshold corrected used
the existing staged flow; server validation/security checks and package bytes
were retained. Installing a local directory also skipped dependency setup on
this native CLI, so the public source instructions now build and install a
reviewed archive. Native archive installation resolved the dependencies.

## Community plugin and portable setup, 2026-10-18

The bridge package is `openclaw-s1-adv@0.2.0`, native plugin ID `s1-adv`.
Local Node host tests cover private/dry-run setup, native config targeting,
agent routing, build/release ownership and source/hash fences, lifecycle races,
HTTP/WS authorization, audio ownership/remapping, upload cleanup and storage
budgets. The final boundary suite has 70 tests; installer/release/lifecycle has
12; gateway interruption has 3. Mock, opted-in compatibility and Realtime
contract smokes pass. Package allowlist and dependency audit are checked too.
These are different checks, not one large certification count.

Turn ownership tests cover overlapping requests in one session, late replies
after HTTP timeout, restart/idempotent retry, opaque Gateway run receipts and
tool commentary. Matching uses the persisted Gateway run ID rather than the
first assistant message after a timestamp. Focused cases also cover
legacy final-chat events, duplicate transports, an in-flight opaque receipt and
answers that repeat their own or a neighboring request's text.

The durable outbox serializes dispatch per exact Gateway session until an exact
`agent.wait` terminal receipt. Tests cover disk-before-RPC ordering, restart with
no resend, alias sessions, bounded admission, pinned unfinished ACKs, independent
duplicate-ID fencing, observation-only retries and correlated terminal failures.
Both small and large legacy migrations keep HTTP observable and report an
explicit delivery hold. Quiescence alone is never used as completion evidence.
The packaged [upgrade runbook](../bridge/TURN-OUTBOX.md) describes exact audits and
fresh-state alternatives that preserve old history.

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

Native qualification also covered official OpenClaw `2026.10.4` with Node
`26.1.0` in a second isolated profile, without copying model accounts. Native
install, private init, exact-runtime enable and doctor passed. Two overlapping
turns used a synthetic local model provider, received pending receipts, then
their own Inbox answers and exact terminal receipts. Idempotent retries returned
the original answers/sequence numbers. This checks the real Gateway contract,
not model quality or external-provider latency. The qualification was repeated
after native installation from ClawHub, using the published `9e32044` artifact.
All 26 installed source files matched the registry's SHA-256 manifest. The older
Gateway qualified the same source with two actual model turns through its existing
configured provider. Both hosts returned their own Inbox answers, exact terminal
receipts and unchanged replies on retry. The old occupied label was retained to
exercise session creation without adopting its existing session.

ClawHub published `openclaw-s1-adv@0.2.0` from tag `bridge-v0.2.0`. The downloaded
artifact SHA-256 equals the locally qualified package:
`54734b98da74dbff4a86067266098394f7f157d4a457af9deeb6585b749cef58`.
Registry classification is **Review**, not a security certification; see the
[disclosed audit status](SECURITY-REVIEW-2026-10-18.md#registry-review-status).

The official Gateway qualification was stopped by its initial 1,536 MiB test
cgroup ceiling. The repeat passed with a 2,560 MiB ceiling. These are test-host
limits for the full Gateway, not a measured bridge memory requirement. Production
Gateway service configuration was not used as the test profile or restarted.

ClawHub package validation against the OpenClaw 2026.10.4 API reported no
contract issues. Static API validation remains separate from the native tests.
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
