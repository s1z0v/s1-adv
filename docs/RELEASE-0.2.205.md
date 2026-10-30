# 0.2.205-dev — Pocket Synth ADV audio-path fix

Responds to the owner's physical report of hiss, broken/weak melodies and poor
synth sound in 0.2.204. Existing keys, octaves, six voices, four sounds, sustain,
scale coaches and all unrelated applications/provisioning remain intact.
This release fixes identified software risks; actual acoustic acceptance must
still be confirmed on the owner's ADV after installation.

## Scheduling and hardware path

The previous UI-loop producer could queue only 2 × 256 / 22050 = **23.2 ms**
of source PCM at a time. Display DMA, keyboard/I2C work and SD-backed diagnostics
can leave it without a refill. DMA also buffers sound, so 23.2 ms is a source
queue budget, not a measured acoustic dropout threshold on this device.

One bounded, lazy **4096-byte-stack, priority-3 producer** now generates PCM
independently of the UI and feeds the existing M5 Speaker task. It uses
**48 kHz mono signed 16-bit** PCM, matching the ADV's default speaker rate,
with three static 512-sample buffers (**3072 bytes**) and dedicated channel 6.
A short critical-section mailbox carries validated immutable controls; only
the producer mutates its DSP state/PCM. No UI rendering, logging, SD, TLS,
heap allocation or per-sample floating point occurs in the producer.

Before starting, it checks the M5Unified ADV profile: **I2S1, BCK 41, WS 43,
DATA 42, 48 kHz mono**, not buzzer/DAC mode. M5Unified retains ownership of
ES8311 clock/register initialization. No codec/GPIO/driver/master-volume
rewrites or risky shared-audio reconfiguration were introduced.

## Cleaner synthesized signal

- Linear interpolation replaces nearest-index sine lookup. Measured generated
  steady-organ residual SNR improves from **43.0 dB to 68.2 dB**, after removing
  the expected harmonics. This is a digital PCM measurement, not acoustic SNR.
- Harmonic generation is limited to **6 kHz** and followed by a gentle low-pass
  for the small speaker; presets remain distinct rather than arbitrary noise.
- Attack is a sample-rate-independent **5 ms**; gain changes are slewed.
  Piano/Bell still decay over about 1.5/0.75 s at the new rate. Release remains
  short (Organ ~43 ms, other full-envelope voices up to ~171 ms).
- Full chords retain fixed headroom; no automatic master-volume increase.
  Very low notes can still be weak on a tiny speaker; octave-up is available.

## Ownership and failure safety

No notes means the producer sleeps, without an endless zero-PCM queue. It stays
ready for the next key until exit/panic/another audio owner. Cancellation stops
only channel 6, and the caller waits for both producer acknowledgement and
queue release before capture, Realtime, playback, OTA or mode transitions.
A 100-ms stop timeout refuses the requested handoff instead of tearing down a
live buffer. Faults require keys to be released; held notes are not auto-replayed.
The existing M5 audio task, voice/TLS, SD content, private VLC defaults, OTA
layout and installed bootloader are preserved.

## Verification and acceptance

All **63 standalone host scripts passed** (external user-ROM harness excluded),
plus UI-feature and release-delivery smokes. Host tests execute the actual producer with threaded FreeRTOS/speaker shims:
continuous chords survive **300 ms with no UI servicing**, buffer pointers
remain intact through asynchronous stop, and 30 stop/restart cycles pass.
Tests cover invalid hardware profiles, allocation/queue rejection, stop timeout,
clock wrap, sustain/releases, silent idle, UI ownership and blocked capture/
playback/Realtime handoffs. Core/renderer tests cover 100,000 randomized steps,
A440 frequency, oscillator error <4/32767, distinct non-clipping PCM and bounds.

These are host/build/OTA checks, not an acoustic claim. After updating, compare
**Soft Piano** using **Q/E/T** (middle-register C/E/G) individually and together;
then Bell/Organ. Confirm whether hiss, dropouts or missing notes remain, along
with the chosen sound/octave/gain. No physical installation is implied by OTA
publication. Full controls: [POCKET-SYNTH.md](POCKET-SYNTH.md).
