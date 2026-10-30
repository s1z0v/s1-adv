# 0.2.204-dev — Pocket Synth

**Tab → Games → Pocket Synth** adds an immediately playable, offline instrument
on the ADV keyboard and built-in speaker. No SD assets, samples, network,
new dependencies, audio downloads or additional application task are needed.
All existing apps, including Chess Mind, Internet Radio and private VLC Remote,
remain available. No provisioning, partitions, bootloader or TLS/auth changes.

## Play and learn

- **25 chromatic keys / two octaves plus top C** visible together. Default
  C3–C5, with octave shifts giving an overall **C2–C7** range.
- Lower row: `Z S X D C V G B H N J M`; upper: `Q 2 W 3 E R 5 T 6 Y 7 U I`.
  On-screen piano keys show their physical key and light up when held.
- **Six-voice polyphony** with explicit note-on/off, short attack/release,
  sustain toggle and panic. Hardware keyboard rollover is not assumed proved.
- Four additive presets: **Soft Piano**, **Bell**, **Organ**, **Chiptune**.
  Soft Piano is a generated timbre, not an acoustic piano sample library.
- Optional **C-major, C-natural-minor and C-major-pentatonic scale coaches**:
  the next note/key is highlighted, correct new presses advance; free playing
  remains possible and wrong notes are neither silenced nor pitch-corrected.
- `-/=` octave; `[/]` sound; `,/.` instrument-only gain; Space sustain;
  Backspace silence; Enter coach; Tab menu; Esc exit. Release musical keys
  after sound/octave/owner changes before playing again. No automatic playback.

## Bounded audio and coexistence

22,050-Hz mono fixed-point additive PCM, A4=440 Hz, six fixed voice slots,
flash sine/phase tables, Nyquist-limited harmonic inclusion and headroom for a
full chord. Three 256-sample int16 buffers total 1,536 bytes; the synth core
is under 256 bytes. At most two PCM submissions per UI service, on dedicated
virtual channel 6 using the existing M5 speaker task. No render-loop allocation
or per-sample floating point. Buffer rotation and drain-on-stop preserve queued
pointer lifetime; silence does not requeue forever. Ten-second per-voice safety
limit plus a release tail bounds a lost-release or unattended sustain.

The foreground instrument pauses heavy background polling/TLS/SD work. Input,
G0/Ctrl+V/double-Ctrl voice, alarm, idle/screen-off and OTA boot guard remain
serviced. Synth stops before capture, external file playback, OTA and mode
changes; all musical keys must be released before resuming, preventing stale
replay after voice/menu interruptions. Focus tones/cues do not steal its audio.
The existing master volume and saved device preferences are not modified.

## Verification scope

All **62 standalone host scripts passed** (external user-ROM harness excluded),
plus the device UI-feature and release-delivery smoke scripts.
New ASan/UBSan tests run the actual core, full-snapshot chord input, renderer and
PCM producer: all keys/octaves/presets/coaches, release/sustain/panic, gain,
100,000 randomized operations, watchdog, asynchronous-stop buffer lifetime,
competing audio/network/UI owners and 240×135 layout bounds. Generated audio
checks prove four distinct non-silent, non-clipping outputs and the A4=440-Hz
fundamental, independently of the phase-increment formula. Existing actual
capture/reply-storage/focus-cue tests also verify synth handoff/priority.

Hardware installation, perceived sound/latency, actual key rollover and
owner acceptance are separate from host tests/build/OTA delivery and are not
claimed by publication. See [POCKET-SYNTH.md](POCKET-SYNTH.md) for Russian usage.
