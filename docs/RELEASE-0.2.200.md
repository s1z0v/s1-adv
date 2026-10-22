# 0.2.200-dev — Internet Radio

**Media → Internet Radio** adds Wi-Fi MP3 radio with the main clock/Pulse
screen's dark blue palette, white clock, cyan/violet thin rings and a live
play/pause indicator. The rings show stream activity, not a measured spectrum.
The main Home clock itself is unchanged.

## Tuning and controls

- Up/Down or W/S: choose a genre. Left/Right or A/D: choose a station within it.
  The Cardputer arrow-key punctuation (`; . , /`) also works.
- Enter/Space: play or pause. Pausing closes the live stream; resuming rejoins
  the live broadcast rather than continuing a recording.
- L: language/station filter **ALL → EN/INT → RU**. Empty genres are skipped.
  EN/INT includes international instrumental stations. RU means a
  Russian-language station/service, not a guarantee about every track.
- +/-: volume, clamped to 0–100%. Escape: stop and return Home. Tab: launcher.
- Changing station/genre/filter while playing retunes automatically, but waits
  for the previous worker and queued audio to release. Browsing while paused
  does not start playback. Opening the app also does not autoplay.

Seven genre groups: **Jazz, Funk/Soul, Rock, Electro/House, Chill, Lounge,
Russian mix**. Eighteen presets (17 distinct streams) include Sonic Universe,
Instrumental Jazz, Funky Radio, Seven Inch Soul, Radio Paradise, Indie Pop Rocks,
Nashe Radio, Rock FM, Beat Blender, DEF CON, cliqhop IDM, Groove Salad, Lush,
101.ru Chill Out, Secret Agent, Illinois Street Lounge and Russkie Pesni.

There is no fabricated “AI music” category: no suitable verified AI-specific
stream is included in this release. AI-generated music is not a codec/standard
radio genre. Existing electronic/chill stations may of course play it.

## Streaming and resource safety

A single dedicated FreeRTOS worker owns its public HTTP MP3 socket, decoder and
bounded buffers. It never uses bridge/device credentials, SD, Preferences or
UI state. It handles bounded HTTP redirects, chunked transfer and ICY metadata
skipping. It validates each destination's public IPv4 address and rejects
private/loopback destinations, userinfo URLs, unsupported MIME/encoding and
malformed framing. No authenticated bridge/OTA TLS policy is changed.

The pinned CC0 `lieff/minimp3` decoder is vendored at upstream commit
`ea99364f61c14656440e8d77e9c233ccf3124633`; attribution/license are in
`src/vendor/`. Mono/stereo MP3 is decoded and queued to speaker channel 7,
with two alternating buffers and the installed M5Unified ownership contract.
Cancellation never deletes a running task or frees queued PCM. If the speaker
fails to release a buffer, the worker retains ownership instead of risking a
use-after-free. Allocation/task/network/decoder errors are visible and do not
start an endless retry loop; Enter retries explicitly.

While streaming/stopping, background inbox, logs, OTA, Realtime, file playback
and microphone capture cannot borrow the speaker or streaming RAM. Keypad,
clock drawing, battery, Pomodoro timer/lamp and alarm checks stay serviced.
Navigation/alarms wait for the worker to release. Starting voice stops radio;
press/hold voice again once it has stopped. The memory guard does not mistake
an owned radio allocation for an idle-heap failure.

## Scope and verification

This first release uses curated **direct public HTTP MP3** endpoints, not an
unbounded live directory. HTTPS-only/AAC/HLS/playlist streams, track-title display,
custom URL editing, saved favorites and background playback on another app are
not implemented. Selection lives in RAM; ordinary device volume behavior is
preserved. Streams are third-party services and can be unavailable by network,
region or later endpoint changes. Plain public radio traffic is not private.

Server probes fetched real audio/mpeg data and confirmed MP3 decoding for all
17 distinct preset URLs on 2026-10-22. This proves server-side availability at
that time, not reception on the Cardputer's Wi-Fi.

Host checks compile the actual catalog/controller/renderer, HTTP/ICY parsers,
vendored decoder and streaming worker with AddressSanitizer/UndefinedBehaviorSanitizer.
They cover genre/language/station wrap, bounded non-overlapping UI, play/pause/
volume, asynchronous retuning/navigation, resource gates, malformed framing,
20,000 parser fuzz cases, real generated mono/stereo MP3, PCM pointer lifetime,
threaded cancellation and resource cleanup. All 53 standalone host scripts
passed (full regression run plus focused retests after aligning the dedicated
speaker-channel fixtures). The external-ROM harness was excluded because it
requires a user-supplied ROM.

Firmware publication, device installation and physical audio/keypad acceptance
are distinct. Physical radio playback, sound quality, long-session stability,
RAM headroom, reconnect behavior and Wi-Fi jitter remain device acceptance checks.
No installation, radio transmission, storage erase, partition or bootloader change
is performed by this feature release.
