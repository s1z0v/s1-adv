# PulseOS security

Use a separate random bridge token and an explicit topic allowlist for each
device. Gateway credentials and its persistent device identity stay on the
bridge host. Keep the gateway on loopback; remote devices connect to the bridge
through verified HTTPS/WSS.

Private firmware builds can embed Wi-Fi passwords and device tokens. Never
attach provisioned binaries, `.env`, `bridge/config.json`, `data/`, recordings or
conversation logs to public issues. Rotate any credential that was disclosed.

The public setup uses the OpenClaw gateway for model calls. Optional direct
provider routes are disabled by default. Do not copy rotating OAuth stores into
competing refresh writers. Configure only the agent actions you intend a
handheld client to invoke.

PulseOS is experimental and has not had a complete independent security audit.
See [architecture](docs/ARCHITECTURE.md) and [setup](docs/OPENCLAW.md).
For a vulnerability, use GitHub private reporting if available or contact the
maintainer privately. Do not post credentials or exploit details in public.
