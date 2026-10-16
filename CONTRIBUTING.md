# Contributing to S1-ADV

Read [the architecture](docs/ARCHITECTURE.md) and use `bots/CardputerADV` for
firmware, `bridge/` for the OpenClaw adapter, and `skills/s1-adv/`
for the optional agent setup skill.

## Verify a change

In `bridge/`, with Node.js 22+ and FFmpeg installed:

```bash
npm ci
npm run test:security
npm run test:upstream
npm run smoke
npm run smoke:realtime-contract
```

From the repository root, with PlatformIO Core 6.1.19 installed in your Python
environment:

```bash
python3 scripts/cardputer.py build
```

Keep changes focused and update user-facing instructions when behavior changes.
Preserve original source and license notices. Never commit private provisioning,
provider credentials, runtime state, recordings or provisioned firmware binaries.
Distinguish compilation and mock checks from observed physical-device behavior.
Current hardware support targets M5Stack Cardputer ADV / ESP32-S3 / 8 MB flash.
