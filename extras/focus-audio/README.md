# Optional Russian Focus audio

The default ESP32 S1-ADV plugin includes English audio only. Russian cues are
optional downloads; the plugin and installer never fetch these links automatically.

Save the following original WAV files onto your SD card, keeping their names:

| Download | SD path | Bytes |
| --- | --- | ---: |
| [start.wav](https://raw.githubusercontent.com/s1z0v/s1-adv/bridge-v0.3.0/bridge/assets/focus-audio/ru/start.wav) | `/pomodoro/audio/ru/start.wav` | 1,746,218 |
| [break.wav](https://raw.githubusercontent.com/s1z0v/s1-adv/bridge-v0.3.0/bridge/assets/focus-audio/ru/break.wav) | `/pomodoro/audio/ru/break.wav` | 1,061,138 |
| [reflection.wav](https://raw.githubusercontent.com/s1z0v/s1-adv/bridge-v0.3.0/bridge/assets/focus-audio/ru/reflection.wav) | `/pomodoro/audio/ru/reflection.wav` | 2,015,374 |

Total: **4,822,730 bytes** (4.60 MiB), PCM16 mono 16 kHz. SHA-256 values and
durations are in [manifest-ru.json](manifest-ru.json). The original bytes remain
available at the preserved `bridge-v0.3.0` source tag; no Russian WAV is included
in the current plugin archive or main source tree.

Alternatively, put these files in your private bridge library at
`<assets.rootDir>/<assets.deviceClass>/audio/ru/`. They then appear in your
authenticated asset manifest, like any other manually added audio. Existing
personal files are not deleted or replaced by a plugin update.

Playback and language selection require compatible Focus firmware. Use its
audio on/off setting; copying files alone does not start playback.
These owner-supplied cues use the project's [MIT license](../../LICENSE).
