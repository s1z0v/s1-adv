# Connect PulseOS to your OpenClaw

The integration is a **standalone Node.js bridge** plus an optional setup skill.
It is not an npm OpenClaw plugin, so `openclaw plugins install` is not the
installation path. The skill alone cannot provide the network endpoints.

## 1. Prepare OpenClaw

Use your existing OpenClaw installation. Check `openclaw --version` and confirm
that a normal agent conversation works. The bridge uses the gateway WebSocket
protocol, including `sessions.send`, `chat.history` and session subscriptions.
Compatibility is exercised against the included mock and the maintainer's
gateway; arbitrary future gateway releases may need adapter changes.

Keep the gateway on loopback (normally `ws://127.0.0.1:18789`) when bridge and
gateway share a host. Obtain its existing gateway token through your local
OpenClaw configuration. Do not copy provider API keys or OAuth stores to the
Cardputer, and do not create competing OAuth refresh stores for this bridge.

## 2. Install the bridge

Requirements: Node.js **22+**, npm; FFmpeg for smoke tests/media conversion.

```bash
cd bridge
npm ci
cp config.example.json config.json
chmod 600 config.json
```

Edit the local `config.json`:

| Field | Set it to |
| --- | --- |
| `upstream.url` | Your gateway WebSocket URL |
| `upstream.token` | Your existing gateway token, stored only on this host |
| `devices[0].device_id` | `cardputer-adv-01`, matching the firmware build |
| `devices[0].device_token` | A unique random device token |
| `devices[0].topics` / `default_topic_key` | `cardputer:main` |
| `topics[0].topic_key` | `cardputer:main`, matching firmware `DEFAULT_TOPIC_KEY` |
| `topics[0].session_key` | Your selected agent session, default `agent:main:cardputer` |

Treat possession of a device token as permission to speak to that agent. A
topic allowlist does not restrict the agent's tools. For a shared device or a
gateway with powerful host tools, create a dedicated restricted `cardputer`
agent and set the session key to `agent:cardputer:main`. Configure its tool
policy/sandbox in your installed OpenClaw version; check with
`openclaw security audit`. Session creation preserves that configured agent.

Generate a device token locally, for example with `openssl rand -hex 32`.
Paste it into `config.json` and your private firmware `.env`, never into a chat
or issue. Use a different token for each device.

Run from the `bridge` directory:

```bash
npm start
```

The bridge creates a local identity under `data/`. Your gateway may require
approval of this newly connected device. Inspect `openclaw devices --help`,
then use its list/approve workflow for the request belonging to this bridge.
Preserve the identity file between restarts.

## 3. Make the bridge reachable

The example binds to `127.0.0.1:31889`. Put it behind a TLS reverse proxy on
your bridge host. See [Nginx example](nginx-cardputer.conf.example).
Install the service using [the systemd template](openclaw-cardputer-bridge.service.example),
replacing paths, creating its unprivileged service user and granting only the
required directory access. With that template, set `stateDir`, `assets.rootDir`,
`assets.logsDir`, `firmware.rootDir` and every `media.*Dir` path under
`/var/lib/cardputer/`, then create those directories owned by `cardputer`.
Keep `config.json` readable by that user only. The protected service cannot
write inside `/opt` or read `/root`. These are templates, not an automatic root install.

The Cardputer must be able to reach the proxy, and the proxy must forward
WebSocket upgrades. It must replace client-supplied forwarding headers;
set `security.trustedProxyAddresses` to the actual proxy addresses if needed.
Do not expose the raw OpenClaw gateway publicly. The template uses Let's
Encrypt, compatible with the firmware's ISRG Root X1 CA.

Firmware bridge connections require verified HTTPS/WSS, including on a LAN.
Custom HTTPS ports are supported. The gateway connection may use WS only on
loopback; a remote gateway requires WSS. Browser WebSocket origins are denied
unless explicitly listed in `security.allowedOrigins`.

The `/internal/` namespace is blocked by the Nginx template. Local automatic
OTA enqueue is disabled by default. If deliberately needed, set
`security.internalOtaEnabled: true` and supply a separate random admin token
through `CARDPUTER_INTERNAL_OTA_TOKEN` in the service environment (or private
`security.internalOtaToken`). The enqueue script needs this admin token as well
as the device token. Forwarded requests are rejected. Never put the admin token
on the Cardputer.

## 4. Verify before flashing

```bash
curl --fail https://YOUR_BRIDGE/healthz
```

Use `python3 scripts/check_bridge.py https://YOUR_BRIDGE` from the repository
root for authenticated topics and history checks. It asks for the device
token through a hidden terminal prompt and does not log the token or history
text. Health means the HTTP service is live; the upstream-ready field and an
actual round trip confirm the agent path.

Then follow [firmware flashing](FLASHING.md). The default sample session is a
dedicated Cardputer session, with no personal Telegram IDs.

## Voice

Start with text. Ordinary voice uses `omnibotShim.sttProvider` and
`ttsFallbackProvider`. The example selects local Whisper and eSpeak. Install
`whisper-cli`, a compatible model and eSpeak on the bridge host, then set their
actual paths in the config; install FFmpeg as well. Other supported provider
routes require their own server-side credentials and may incur charges.
Review the source/configuration before enabling them.

`realtimeVoice.enabled` and `fastLane.enabled` are off by default. Realtime voice
requires separate provider authentication and a compatible model. It is an
advanced experiment, not required for OpenClaw text or ordinary voice.

## Optional agent skill

Find your actual OpenClaw workspace, then copy the skill there:

```bash
mkdir -p /path/to/openclaw-workspace/skills
cp -R skills/pulseos-cardputer /path/to/openclaw-workspace/skills/
```

Run these commands from the repository root. Open a new agent session or follow
your version's skill refresh workflow. See the official
[OpenClaw skills guide](https://docs.openclaw.ai/tools/skills).
This only installs documentation for the agent; install/start the bridge above.

## Give this to your OpenClaw agent

```text
Help me set up PulseOS on my M5Stack Cardputer ADV from this repository:
https://github.com/srg0/pulseos-cardputer

Read README.md, docs/OPENCLAW.md and docs/FLASHING.md from the checked-out source.
Use the bridge/ service in this repository and my existing OpenClaw gateway.
Inspect my installed gateway version and configuration before changing anything.
Create a dedicated Cardputer session and a device token in private local files.
Keep the gateway token and model credentials on the server. Never print secrets.
Configure a bridge address reachable from my 2.4 GHz Wi-Fi, with verified TLS
for remote access. Preserve my other agent and channel settings.
Install the optional skills/pulseos-cardputer skill into my actual agent workspace.
Run local bridge smoke/security checks, then check authenticated topics/history.
Prepare a private firmware .env matching the bridge device ID, token and topic.
Build for ESP32-S3 / 8 MB with scripts/cardputer.py. Let me connect the device
for the USB flash and report the exact port and build result.
Finally test one typed question and one ordinary push-to-talk response on the
device. Report what was actually observed and any remaining hardware steps.
Keep realtime voice off until the basic OpenClaw route works.
```

No Hermes/Kermes adapter is shipped or claimed by this project.
