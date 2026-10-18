# S1-ADV Cardputer Bridge

A community OpenClaw plugin and standalone Node.js bridge for M5Stack Cardputer
ADV. It provides authenticated text/voice, device events and OTA endpoints for
[your S1-ADV firmware](https://github.com/srg0/s1-adv). No hosted account or model
subscription is included. Full guide:
[OpenClaw setup](https://github.com/srg0/s1-adv/blob/main/docs/OPENCLAW.md).

## Plugin setup

Requirements: OpenClaw, Node.js 22+, a working selected agent and a device-facing
HTTPS hostname. The minimum declared plugin API is 2026.7.2-beta.1; consult the
repository validation record for the exact tested host versions.

From a reviewed clone of `srg0/s1-adv`:

```bash
openclaw plugins install ./bridge
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

## Review and verification

There are no install/postinstall scripts or automatic root/model downloads.
The artifact allowlist excludes config, state, recordings and dependency caches.
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
