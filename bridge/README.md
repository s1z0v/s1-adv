# ESP32 S1-ADV

![S1-ADV: voice, AI and firmware on a real M5Stack Cardputer ADV](https://raw.githubusercontent.com/srg0/s1-adv/d13d260a6da91636924c2a0286bf1f8955701709/docs/assets/s1-adv-hero.jpg)

A community OpenClaw plugin and standalone Node.js bridge for the ESP32-S3 based
M5Stack Cardputer ADV. Connect the handheld to your own AI agent for authenticated
text/voice chat, device events and optional firmware build/OTA workflows with
[your S1-ADV firmware](https://github.com/srg0/s1-adv). No hosted account or model
subscription is included. Full guide:
[OpenClaw setup](https://github.com/srg0/s1-adv/blob/main/docs/OPENCLAW.md).

**Video walkthrough coming soon:** [YouTube @s1z0v](https://www.youtube.com/@s1z0v).
[Project repository](https://github.com/srg0/s1-adv) ·
[Security review](https://github.com/srg0/s1-adv/blob/main/docs/SECURITY-REVIEW-2026-10-18.md).

One device identity per instance is enforced. Use separate private storage for
other devices. Ordinary chat can use an agent with all host tools denied;
firmware-building rights are separate and explicitly provisioned.

## A pocket interface for your own AI agent

Keep your OpenClaw agent on your own server and carry its keyboard, microphone
and speaker in your pocket. ESP32 S1-ADV connects the ESP32-S3 Cardputer ADV to
that agent through an authenticated HTTP/WebSocket service.

- **Text and push-to-talk voice:** send questions and tool requests, receive
  replies in chat and Inbox, and add spoken responses with your configured STT/TTS.
- **Optional self-updating firmware:** ask your explicitly authorized agent for
  a change, build and verify its source, then deliver a candidate over Wi-Fi OTA.
  The user confirms installation on the device. Build status and update notices
  keep the handheld informed; these rights are off until you provision them.
- **Self-hosted service:** a private device token, your HTTPS address and your
  existing agent/provider configuration. No shared cloud bridge or included AI account.
- **Useful offline hardware:** S1-ADV firmware also includes a Focus timer,
  notes, clocks and SD audio. Three English Focus cues are included in this plugin;
  extra languages remain optional downloads.

Works with **M5Stack Cardputer ADV, ESP32-S3, 8 MB flash**. Other ESP32 boards
need a compatible firmware port; installing this plugin alone does not add one.
Realtime voice needs separate provider setup and remains experimental.

## Plugin setup

Accepted turns use a durable per-session queue. A pending receipt means the reply
will continue through Inbox; it is not the final agent answer. Upgrading old
bridge state can require a delivery audit before new work is allowed. Read the
[delivery and upgrade guide](https://github.com/srg0/s1-adv/blob/main/bridge/TURN-OUTBOX.md).

Requirements: OpenClaw with the Node.js runtime supported by that release, a
working selected agent and a device-facing HTTPS hostname. Node.js 22 is the
standalone bridge minimum; newer OpenClaw releases require a newer runtime.
The minimum declared plugin API is 2026.7.2-beta.1; consult the
repository validation record for the exact tested host versions.

Review the native install-source and capability prompts for this exact artifact.
If your release requests explicit noninteractive consent, repeat that reviewed
install with `--accept-capabilities`; local archives/paths can also require
`--force` for source acknowledgement. Do not treat `--yes` as capability consent.

Install the published plugin on your intended OpenClaw host:

```bash
openclaw plugins install clawhub:openclaw-s1-adv@0.3.3
```

Or install a reviewed source archive (tag `bridge-v0.3.3` for this release):

```bash
cd bridge
npm pack --ignore-scripts
openclaw plugins install ./openclaw-s1-adv-0.3.3.tgz
# Prefer a dedicated restricted agent; create/configure it in OpenClaw first.
openclaw s1-adv init --agent cardputer --public-url https://YOUR_BRIDGE
openclaw s1-adv init --agent cardputer --public-url https://YOUR_BRIDGE --apply
openclaw s1-adv enable --config "$HOME/.openclaw/s1-adv/config.json"
openclaw s1-adv enable --config "$HOME/.openclaw/s1-adv/config.json" --apply
# Restart your intended Gateway when ready:
openclaw gateway restart
openclaw s1-adv doctor --config "$HOME/.openclaw/s1-adv/config.json"
```

Installation does not start a service until explicitly enabled. `init` previews
without writes; `--apply` creates private mode 0600 files. It preserves existing
configuration and device identity on repeat. `enable` previews the exact plugin
entry, then optionally saves that entry/allowlist membership with a private
backup. It does not restart the Gateway or change your agents/channels.

Use `--gateway-config PATH`, `--state-dir PATH`, `--port NUMBER` for custom
installations. An explicit `--agent main` selects your existing private agent
instead. A device token permits access to that selected agent's tools; keep it
private and restrict shared devices. Setup refuses nonexistent agent routes.

Private storage has a default 256 MiB admission budget and 128 MiB free-space
floor. Full storage refuses new persistent work with HTTP 507; it does not erase
your recordings. Legacy multi-device stores require migration. Generated speech
without current topic/session ownership is not served.

The bridge runs as the Gateway user on 127.0.0.1:31889, starts/stops with the
Gateway and stores recordings/history outside the plugin package. Keep the
Gateway private. Use your own TLS proxy for Cardputer HTTPS/WSS access and approve
only the exact bridge identity if your Gateway requires pairing. Doctor checks
HTTP and upstream separately; a real model/device round trip is still required.

## Manual installation

```bash
cd bridge
npm ci --ignore-scripts
node scripts/setup.mjs init --agent cardputer --public-url https://YOUR_BRIDGE
node scripts/setup.mjs init --agent cardputer --public-url https://YOUR_BRIDGE --apply
CARDPUTER_BRIDGE_CONFIG="$HOME/.openclaw/s1-adv/config.json" npm start
```

You can instead edit `config.example.json` by hand. Replace token placeholders,
choose the existing agent/session, set private absolute data paths and preserve
its identity file. See the
[service/TLS templates](https://github.com/srg0/s1-adv/blob/main/docs/OPENCLAW-MANUAL.md).
The setup skill is guidance; it cannot host the endpoints by itself.

## Optional capabilities

- Three bundled English Focus cues (4.88 MiB total) are available through
  the authenticated asset manifest for download onto SD. Playback is optional
  in matching firmware; nothing is added to the firmware flash. Private files
  at the same path take precedence. Russian cues are separate
  [optional downloads](https://github.com/srg0/s1-adv/blob/main/extras/focus-audio/README.md)
  and are never downloaded automatically. See the
  [Focus audio guide](https://github.com/srg0/s1-adv/blob/main/docs/FOCUS-AUDIO.md).
- Ordinary voice needs configured STT/TTS. See the
  [local speech recipe](https://github.com/srg0/s1-adv/blob/main/docs/OPENCLAW-VOICE.md).
  FFmpeg, Whisper/models and eSpeak are installed separately; missing audio
  dependencies are reported without preventing an ordinary text diagnosis.
- Realtime and direct fast-lane modes default off and require separate provider
  configuration. OpenClaw text authentication does not imply audio access.
- Autonomous firmware requests default off. Provision a writable fork, explicit
  branch, private Python/PlatformIO environment and reviewed agent permissions:

```bash
openclaw s1-adv firmware --config /ABSOLUTE/PRIVATE/config.json \
  --repo-dir /ABSOLUTE/FIRMWARE/FORK --branch main \
  --python-bin /ABSOLUTE/VENV/bin/python
# Review, then repeat with --apply.
```

Generated private build/publish/smoke commands use those configured paths in both
plugin and standalone modes. They require a clean reviewed source commit, one
release lock, the exact pushed commit, an image below the OTA slot limit and
matching served bytes. They neither switch/reset checkouts nor grant extra agent
permissions. An unconfigured workflow returns a clear unavailable response,
not a promise that work started. The build and provisioning may contain secrets;
never attach a personal candidate or config to a public release.

## Ask your OpenClaw agent to change firmware

Two agent skills are bundled: **s1-adv** for setup and diagnosis, and
**s1-adv-firmware** for implementing features and publishing verified OTA updates.
After the optional firmware workflow is configured, use an ordinary OpenClaw
chat: "Use s1-adv-firmware. Add [my feature] to my Cardputer ADV, test it, build
and publish an OTA update. I will confirm installation on the device."
The agent uses your private paths and fork. A skill does not grant permissions
or require any desktop chat binding. See the
[firmware request guide](https://github.com/srg0/s1-adv/blob/main/docs/OPENCLAW.md#ask-openclaw-for-a-new-firmware-feature).

## Review and verification

This is executable host code, **not a sandbox**. The bridge child inherits the
Gateway user's OS access and environment. A restricted chat agent limits that
agent's tools; it does not restrict the bridge process's file or environment
access. Use a dedicated OS account/container where stronger isolation is needed.

Credential and network boundaries:

- The private Gateway token authenticates to your configured loopback WS or
  verified WSS Gateway. The device receives a separate device token, not that key.
- Selected OpenAI STT/TTS/Realtime paths use `OPENAI_API_KEY` and send their
  audio/text to OpenAI's HTTPS endpoints. Optional Gemini STT uses its configured
  provider key. These paths can incur provider charges.
- Optional OpenAI WIF reads only the explicitly configured subject-token file
  or environment value and exchanges it at `https://auth.openai.com/oauth/token`.
  Realtime is off in a fresh installation.
- The legacy direct fast lane is off by default. Its optional Codex OAuth mode
  can read **and refresh** the selected host auth profile. Review its path and
  identity before enabling it; avoid competing credential writers. Ordinary
  OpenClaw chat delegates model authentication to the Gateway instead.
- Optional firmware commands execute reviewed local tools against your chosen
  checkout. Skills do not grant these permissions. Keep all configuration and
  provisioning outside the package, and never share a provisioned image.

There are no install/postinstall scripts or automatic root/model downloads.
The artifact allowlist excludes private config, state, recordings and dependency
caches. Its only bundled WAV files are the three reviewed English Focus cues.
All plugin/service code is in this package for review. Disable/uninstall through
OpenClaw when needed; private configuration is retained for an intentional
backup/revocation decision. Do not delete identity/state as a troubleshooting
shortcut.

From the source repository:

```bash
npm ci --ignore-scripts
npm run test:install
npm run test:security
npm run test:boundaries
npm run test:upstream
npm run smoke
npm run smoke:realtime-contract
```

Tests use isolated fixtures/local services and generated audio; they do not
prove hardware acceptance. The
[validation record](https://github.com/srg0/s1-adv/blob/main/docs/VALIDATION.md)
separates source tests, package inspection, native host installation and device
observations. Issues and maintenance:
[github.com/srg0/s1-adv](https://github.com/srg0/s1-adv/issues).
