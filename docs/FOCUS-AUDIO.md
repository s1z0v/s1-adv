# Optional Focus audio

Bridge plugin 0.3.0 includes six ready-made Focus cues: `start`, `break` and
`reflection` in English and Russian. They are PCM16, mono, 16 kHz WAV files,
33–63 seconds each. The exact combined size is **9,935,646 bytes** (9.48 MiB).
The compressed plugin is about 8.4 MiB. The cues do not need Whisper, TTS,
an API key or a model call.

## Installation and playback

Install the plugin and configure your bridge normally. The library is bundled
with the plugin, so no separate audio download command or privileged installer
is needed on the server. The bridge verifies the six checksums once on startup
and exposes the cues through its existing authenticated asset API:

- Manifest: `GET /api/cardputer/assets/manifest`
- Files: `GET /api/cardputer/assets/file/{en,ru}/{start,break,reflection}.wav`
- Authentication: the configured device's Bearer token, as for other assets.

The manifest provides each file's path, language, size, duration and SHA-256.
On firmware with Focus audio synchronization, the device downloads missing
cues onto its **SD card**, under `/pomodoro/audio/{en,ru}/`. These files are
not linked into the firmware image or stored in its 8 MB flash. Leave at least
10 MiB free for the cues, plus space for temporary downloads and backups.

Use the device's **Focus audio on/off** setting to control playback. Language
selection, Russian fallback and preserving replaced SD files are handled by
the matching firmware. Installing this plugin alone does not update firmware,
write to an attached device or turn its playback on. See the current firmware
release notes for device support. Host download tests are not proof of physical
SD writing or speaker playback.

## Personal overrides and disabling distribution

The library stays in the read-only plugin package. It is not copied into private
recordings/state. Existing private assets take precedence at the same relative
path, for example:

```text
<assets.rootDir>/<assets.deviceClass>/audio/en/start.wav
```

The plugin does not overwrite those files. They continue to use the normal
asset size limits and authentication. To omit the bundled cues from this
bridge entirely, set the following in its private configuration and restart
the intended bridge:

```json
{ "assets": { "bundledFocusAudio": false } }
```

Merge that property into the existing `assets` object; keep its other paths.
This server setting controls distribution of bundled cues. It does not delete
files already on SD or change the device's playback setting. Private assets
remain available. `s1-adv doctor` reports bundled Focus availability separately
from speech-provider dependencies and ordinary text delivery.

The six owner-supplied cues are redistributed under the project's MIT license.
No personal server configuration or authentication material is included.
