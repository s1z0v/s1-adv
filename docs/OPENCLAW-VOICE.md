# Optional local speech providers

Start with a verified text round trip. The bridge's example selects
`local-whisper` for speech recognition and eSpeak for synthesized replies.
These run on your host and do not need an OpenAI API key. Your OpenClaw agent
still needs its own configured model/authentication. Cloud STT/TTS and Realtime
use separate provider credentials; enabling the plugin does not supply them.

## Debian/Ubuntu example

Review these commands and use the privileges appropriate to your host. The
plugin installer does not execute them automatically.

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends build-essential cmake git ffmpeg espeak-ng
mkdir -p "$HOME/.local/share/s1-adv"
cd "$HOME/.local/share/s1-adv"
git clone --branch v1.9.5 --depth 1 https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j2 --config Release
sh models/download-ggml-model.sh base
./build/bin/whisper-cli -m models/ggml-base.bin -f samples/jfk.wav
```

The pinned release is
[whisper.cpp v1.9.5](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5).
Review its [build/model instructions](https://github.com/ggml-org/whisper.cpp)
and the model download source before installing. Use multilingual `base`, not
`base.en`, when the device should accept Russian or other supported languages.
Record the installed revision and model checksum for your deployment.

In private `config.json`, set absolute paths, replacing `YOUR_HOME`:

```json
{
  "omnibotShim": {
    "sttProvider": "local-whisper",
    "sttLocalBin": "/YOUR_HOME/.local/share/s1-adv/whisper.cpp/build/bin/whisper-cli",
    "sttLocalModel": "/YOUR_HOME/.local/share/s1-adv/whisper.cpp/models/ggml-base.bin",
    "sttLocalLanguage": "auto",
    "sttLocalThreads": 2,
    "ttsFallbackProvider": "espeak",
    "ttsFallbackBin": "espeak-ng"
  }
}
```

Merge these fields into your configuration; do not replace the other sections.
A literal `~` is not expanded in JSON paths. The service user must be able to
read the model and execute the binaries. The hardened standalone systemd
example blocks `/home` and `/root`; install its binaries/model under an allowed
system/data path instead. Gateway-plugin mode runs as the Gateway user and can
use that user's private installation.

Run `openclaw s1-adv doctor --config /ABSOLUTE/PRIVATE/config.json` after restarting
the intended bridge. Confirm provider files/binaries, then test a short recorded
phrase and synthesized response. Keep the original language for recognition;
reply language defaults to English unless explicitly requested otherwise.
Whisper CPU latency depends on model size and host resources. Report upload,
recognition, agent wait and playback separately when diagnosing latency.
