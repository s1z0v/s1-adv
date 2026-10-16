# 0.2.145-dev — delivery and display repair

## Owner-confirmed baseline — 2026-08-30

The owner confirmed that the eyes now render correctly and that delivery and
automatic OTA installation were quick and successful. Realtime is usable and
should now be promoted into the launcher. Preserve this release as the baseline
for the next UI-only iteration; this is not blanket confirmation of G0 latency
or every long-audio/battery edge case.

Confirmed firmware: commit `6c66f0a`, tag `cardputer-adv-v0.2.145-dev`.
Binary SHA256: `afe097a282e2c60ec6533d4366df34aadaa1bcb78b7e594e63db74e05aaab80d`.
Bridge companion: `2917127d7`. The live registry remains on 0.2.145-dev until
another release is explicitly published. Keep transport, pacing and codec intact
while adding menu access and a microphone-only level indicator.

Follow-up from the owner in the same session: a long Realtime count reached 16,
with interruptions, then returned to Home. Cause is not yet established; do not
mark long-response hardware acceptance passed or attribute it to Inbox without
evidence. Eye rendering and automatic OTA remain confirmed successes.

## Original release record

Baseline/rollback: tag `cardputer-adv-v0.2.144-dev`, commit `2c8f5f7`.
Baseline binary SHA256: `2d67598578cce256a6330f9b61cd06e83ccde457d68c9d4e7e659596a22b5615`.
Do not automatically revert the firmware on an unproven acoustic issue; retain
the previous binary/Bridge source and ask the owner before installing rollback.

Firmware:
- G0 native 24kHz PCM16; same fixed 1024-sample DMA buffers (~42.7ms).
- Pending Bridge acknowledgement is silent, not an assistant answer/TTS.
- Inbox: 4s polling while awaiting a reply, 15s normally; sequence dedup;
  persistent pending/unread marker and new-firmware dot on the pulse screen.
- OTA screen schedules a fresh manifest fetch on entry (bounded 4s request).
- Check battery/USB before the clean-updater reboot and after manifest refresh;
  unknown/low unplugged power blocks safely with a charge/USB instruction.
- Update sound: 240ms low A-major PCM chord, soft envelope, once per new version.
- Eyes: explicitly typed native RGB565 upload; no texture, animation, or RAM
  expansion. The old default `uint16_t` upload selected swapped565 and produced
  the exact rainbow noise photographed by the owner.

Bridge companion changes:
- Same persistent S1 session/model/tools/full context for every G0 turn.
  `thinking=low` for simple speech only; development/ambiguous continuation uses
  the session default. No isolated weather route and no clean firmware job fork.
- 10s synchronous wait, then silent pending status plus durable inbox reply.
- Unwrap only the exact Cardputer transport envelope before mirroring it.
  Historical session content is not deleted or truncated.
- Realtime 2048 output tokens and PCM -> audio.done -> response.done fence.
  Codec, native rate, 30/20 pacer and device prebuffer remain unchanged.

Live budget proof (gpt-realtime-2.1, same count-to-20 prompt):
- 240: incomplete/max_output_tokens; output 240 (audio 177); stopped at 9;
  8.85s audio, first audio 987ms.
- 2048: completed; output 605 (audio 484); reached twenty;
  24.2s audio, first audio 830ms.

Persistent S1 context smoke correctly recalled Phuket from the previous turn:
16.8s warm response with low thinking. The first run included an automatic
upstream compaction and answered in 22s; its original test incorrectly relied
on absent history IDs, now corrected to timestamp/content fingerprints.
This is not a claim of Realtime-like G0 latency: STT/model/tools still take time.

Checks: scripts/realtime_state_smoke.py; scripts/release_delivery_smoke.py;
tests/release_delivery_test.cpp; tests/render_uncanny.mjs; companion Bridge
test-turn-delivery.mjs + gate-delivery.mjs. Hardware acoustics, battery sensor
accuracy and fresh boot remain owner-canary checks, not host-test claims.
