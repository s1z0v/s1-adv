# 0.2.201-dev — Direct Pomodoro lamp preset switching

Focus, break/pause and restoring the original lamp preset now select their
**target directly**, rather than stepping through every intervening preset.
The existing user-selected Focus and Break preset numbers are retained.

## How it works

The owner explicitly approved resending saved lamp settings while preserving
all existing effects. The Cardputer sends one **GL2 type-2 preset-bank packet**
with every cached effect/brightness/speed/scale/other preset byte unchanged and
only the transmitted selected index changed. It does not optimistically edit
the local cache or claim success: the target must be acknowledged by the
lamp's `GL_ONL` presence message. The original preset is restored the same way
when Focus is stopped. Pause continues to use the Break preset.

The existing two idempotent power-on commands and >=520 ms command spacing are
retained. There are no automatic next/previous packets and no scrolling
fallback. Lost acknowledgements, changed lamp IP, manual phone/control edits or
lost presence suspend the lease, as before. Explicit start/resume or enabling
the link permits a new lease; reconnecting alone does not seize the lamp.
Pending manual edits, recording, submission, Realtime and transfers retain priority.

A valid learned preset bank and a current/target index within that bank are
required whenever an effect change is needed. If unavailable, the device says
to sync presets from the phone. Move a lamp preset slider in the phone app once,
then explicitly restart/resume Focus or re-enable its lamp link. No effects are
invented, replaced with red/green defaults, deleted or reordered.

**Important:** the lamp receives its saved bank again and persists it. Newer
phone changes that the Cardputer did not receive could therefore be replaced;
this is the owner's accepted trade-off. Sync from the phone first if it was
edited elsewhere. This is not an atomic compare-and-swap protocol.

## Protocol and datagram safety

Verified against official `AlexGyver/GyverLamp2` source at
`145fbfb99bd732e7a6dc37b8fc77da38245f936f`, `parsing.ino` and `time.ino`:
stock control opcode 6 shares its preset argument with `setTime`'s weekday.
That can alter the lamp clock when NTP is unavailable or the lamp is an AP.
This release does **not** use that opcode. Type 2 carries the selected preset
and correct weekday/hour/minute/second in separate fields.

ESP32 Arduino WiFiUDP automatically splits writes larger than 1460 bytes into
separate UDP packets. A partial bank could damage settings if interpreted by
the lamp. All Cardputer smart-lamp packet sends therefore fail closed above
1460 bytes; direct-selection packet construction enforces the same limit.
An oversized bank is not truncated, split, partially sent or replaced with
fewer effects. Large banks with compact byte values may still fit; a bank that
does not fit reports an error and cannot use this direct path. Manual speed/
scale sends receive the same outgoing size protection.

## Checks and acceptance

Sanitized host checks exercise the actual state machine, UDP service and
packet builder: 1600 original/target combinations and restoration, untouched
preset bytes, separate clock fields, acknowledgement ownership, manual/peer/
clock/transfer guards, dense and oversized banks, and no scrolling/unsafe-opcode
fallback. Existing Focus/pause/shortcut, audio ownership, radio, games, Mesh,
SD, network and OTA regressions also passed: all **54 standalone host scripts**
passed. The user-supplied external-ROM harness was excluded.

This release updates **Cardputer firmware**, not the lamp's firmware. Lamp
firmware, geometry, wiring, Wi-Fi settings and provisioning are not flashed or
changed. Physical lamp switching, persistence and no-intermediate-effect
acceptance remain on-device checks.

## Phuket weather — not included

The checked stock GyverLamp2 source lists weather as TODO; effect 11 is a
placeholder with no weather fetch/rendering. Setting a city ID alone cannot
implement it. Stock vendor pull OTA is not a verified arbitrary custom-image
upload route, and this OpenClaw server has no established safe flashing
connection to the lamp. A custom weather display needs the owner's actual
lamp firmware/board/matrix details and a safe local flash/recovery method.
No weather requests, lamp OTA commands, unverified downloads or lamp flashes
are performed in this update.
