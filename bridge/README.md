# PulseOS OpenClaw bridge

Node.js companion service between Cardputer ADV and an existing OpenClaw gateway.
Start with the complete [OpenClaw setup guide](../docs/OPENCLAW.md).

```bash
npm ci
cp config.example.json config.json
# Edit config.json locally; replace both token placeholders.
npm start
```

The default listens on loopback port 31889. Add a TLS reverse proxy for remote
devices. Configuration and persistent `data/` contain secrets and private history.

```bash
npm run test:security
npm run test:upstream
npm run smoke
npm run smoke:realtime-contract
```

Smoke tests use local mock services and generated tones. They need FFmpeg but
do not need model-provider credentials. Optional live provider scripts require
explicit local configuration and can incur usage costs.

See [architecture](../docs/ARCHITECTURE.md) for endpoints and trust boundaries.
Firmware publishing is documented in [flashing](../docs/FLASHING.md).
