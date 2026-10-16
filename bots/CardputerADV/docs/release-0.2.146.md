# 0.2.146-dev — Realtime entry, microphone UI and companion pacing repair

Baseline: owner-confirmed eyes/automatic OTA on 0.2.145-dev, firmware `6c66f0a`,
checkpoint `cardputer-baseline-0.2.145-owner-confirmed`. On the owner's subsequent
request, the companion Bridge repair was deployed before publishing this exact
previously built UI binary (`01b611d`) at 2026-08-30 04:47:16Z. No USB flash.
Downloaded SHA/size verified; OTA event4876 queued. Hardware acceptance pending.

- OpenClaw menu: Realtime is first, Pulse second; all previous entries retained.
  Ctrl+1..7 selects a submenu entry; unchanged 1..7 selects a group.
- Menu Realtime opens the existing session path, without toggle/commit behavior
  on repeated selection. Pulse menu selection leaves Realtime explicitly.
- Two equal horizontal microphone bars share the same real PCM level in
  Realtime and normal G0 recording on the existing SD/chunk path. UI-only fast
  attack/soft release; zero on stale data (250ms) or mic-off; no FFT, heap,
  driver/transport/pacing changes. Meter state is eight bytes.
- RAM-only fallback still records one asynchronous full buffer, without an
  incremental completion API. Its meter remains empty rather than reading
  unfinished DMA memory or inventing activity. Its capture path is unchanged.
- Realtime contains no clock: MIC/WAIT/TALK/READY/LINK uses an alphabetic font
  below the heading instead of the numeric Font7 at overlapping coordinates.

Preview: `adv_cardputer/output/playwright/cardputer-146-mic-preview.html` and PNG.
Browser checks: all rectangles inside 240x135; two bars equal at silence,
speech, full-scale, and mic-off. Firmware primitives tested independently.
Tests: `scripts/realtime_ui_smoke.py` compiles actual menu/PCM functions with
host stubs; `tests/mic_input_meter_test.cpp`; launcher shortcuts; existing
UI, Realtime state, and release-delivery smoke suites.

## Long-response fault — companion fix, owner acceptance pending

Owner: counted to 16 with interruptions, then returned Home. Session
`rt_1122dbaeed23` on actual firmware `0.2.145-dev`, git `6c66f0a`:
- 2026-08-30 03:45:38Z first audio, 742ms after speech stop.
- 03:45:42Z response completed, output tokens 506 / audio tokens 391,
  pacing queue 666240 bytes. This was not the earlier token-budget failure.
- 03:45:56Z device WebSocket closed abnormally (1006), session lifetime 21.159s.
- 03:46:13Z device requested manifest again; this alone does not prove a reboot.

Close1006 alone did not identify reset versus network/heartbeat. Subsequent
actual Bridge-source host reproduction found unbounded30ms/20ms PCM delivery
queues seconds of audio ahead of pong: the old code closes at21.120s, matching
the observed21.159s closely. This is not evidence of an Inbox interruption.

Bridge commit `2f676bde5` caps monotonic audio lead at320ms while retaining
30/20 catch-up after scheduling pauses. PCM, DMA, firmware buffers and heartbeat
are untouched.24/60sec transport fixtures now drain exactly; injected absent
pong still disconnects.60sec is transport-only: firmware's separate45sec total
awaiting timeout is unchanged. Live OpenAI canary completed23.55sec/full20,
1130400 PCM bytes with identical input/output SHA; first audio1412ms.

Gate READY for single-owner canary entry only, not an owner-confirmed fix:
repeat count-to20 on the device and check complete speech, no Home exit, and
return to listening. No USB serial port was available during diagnosis.
Full evidence: `adv_cardputer/output/cardputer-0.2.146/pacing-gate/`.
Server rollback +145 manifest backup:
`/var/lib/openclaw-cardputer-bridge/release-backups/0.2.146-pacing/`.
