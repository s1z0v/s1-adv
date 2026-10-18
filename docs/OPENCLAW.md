# Install the S1-ADV OpenClaw integration

S1-ADV includes a community OpenClaw plugin and the same bridge as a standalone
Node.js service. Use the plugin for Gateway-managed startup and setup commands,
or follow the [manual service guide](OPENCLAW-MANUAL.md). The plugin is maintained
by the S1-ADV project; it is not an official bundled OpenClaw module.

## Requirements

- An existing working OpenClaw installation with its supported Node.js runtime.
  Node.js 22+ is the standalone bridge minimum. OpenClaw 2026.10.4 itself requires
  Node.js 24.16+ within the 24.x line, or Node.js 26.1+.
- A Cardputer ADV with S1-ADV firmware and 2.4 GHz Wi-Fi.
- A selected OpenClaw agent. Prefer a dedicated restricted `cardputer` agent.
- One device identity per bridge instance, with separate private storage for each device.
- A device-reachable HTTPS origin, with a certificate trusted by the firmware.
  The default CA is ISRG Root X1. The raw bridge stays on loopback.
- Optional speech providers and optional firmware-build permissions, configured
  separately. There is no shared hosted bridge or bundled model account.

The declared minimum plugin API is 2026.7.2-beta.1. See
[validation](VALIDATION.md) for the exact versions actually exercised; a minimum
API declaration is not proof that every newer or older Gateway works.

## Install from ClawHub

The community preview is **ESP32 S1-ADV**, distributed as
[openclaw-s1-adv 0.3.1](https://clawhub.ai/plugins/openclaw-s1-adv).
On a current OpenClaw installation:

```bash
openclaw plugins install clawhub:openclaw-s1-adv@0.3.1
```

The package includes local process execution and optional firmware
source/build/publish/OTA capabilities. Inspect
the [registry audit](https://clawhub.ai/plugins/openclaw-s1-adv/security-audit?version=0.3.1)
and [maintainer review](SECURITY-REVIEW-2026-10-18.md), then make an explicit trust
decision for this exact artifact. This is a community package with source-linked
metadata, not an official module or a signed build attestation. Firmware automation
remains off until separately provisioned. Setup below is still required.

## Alternative: install from reviewed source

```bash
git clone --branch bridge-v0.3.1 https://github.com/srg0/s1-adv.git
cd s1-adv/bridge
npm pack --ignore-scripts
openclaw plugins install ./openclaw-s1-adv-0.3.1.tgz
```

Review OpenClaw's local-plugin trust prompt. Installation alone does not start a
network service. There are no npm install hooks, automatic model downloads or
root installation scripts. The published artifact contains source, templates and
the three optional English [Focus audio cues](FOCUS-AUDIO.md),
not the maintainer's configuration, credentials or personal firmware binary.

Use the archive for this source route: native directory installs on some
OpenClaw versions copy the plugin without installing its dependencies. The
native archive installer resolves the declared runtime dependencies.

Recent OpenClaw releases also require capability consent. Review this exact
artifact's native report and source: the integration registers its CLI, setup
skill and bridge service. If a noninteractive install requests consent, repeat
the same reviewed command with `--accept-capabilities`. A local archive/path may
also require `--force` to acknowledge its source. These are separate reviews;
`--yes` does not approve capabilities. See
[OpenClaw capability consent](https://docs.openclaw.ai/plugins/manage-plugins#capability-consent).

If you need a dedicated agent, inspect `openclaw agents add --help`, then create
one with a private workspace and the tool permissions appropriate to your device.
For example:

```bash
openclaw agents add cardputer --workspace "$HOME/.openclaw/workspace-cardputer"
```

Configure its model/auth using your installed OpenClaw workflow. Do not copy a
rotating OAuth profile into a second independently writable credential store.
Setup refuses to apply a route to a nonexistent agent. To deliberately use your
existing private agent instead, choose `--agent main`; possession of the device
token then grants access to that agent and its permitted tools.

For ordinary chat, set that agent's `tools` to
`{ "profile": "minimal", "deny": ["*"] }` using your installed schema and native
config validation. Do not replace the whole agents configuration. See the
[security review](SECURITY-REVIEW-2026-10-18.md) for the exact privilege boundary,
storage limits and migration requirements. Building firmware needs a separately
reviewed tool/OS policy; the chat-only setting deliberately grants no build tools.

## Preview and create private settings

```bash
openclaw s1-adv init --agent cardputer --public-url https://YOUR_BRIDGE
# Review paths, agent and capabilities, then create private files:
openclaw s1-adv init --agent cardputer --public-url https://YOUR_BRIDGE --apply
```

Replace `YOUR_BRIDGE` with your HTTPS hostname. Add `--gateway-config PATH` or
`--state-dir PATH` for a custom installation. For an external secret provider,
use `--gateway-token-file PATH` or an environment SecretRef; never put a token
on the command line or in a chat. JSON5 OpenClaw configuration is supported.

By default, setup creates `~/.openclaw/s1-adv/` with:

| File | Purpose |
| --- | --- |
| `config.json` | Loopback bridge, selected agent, private gateway token and unique device token |
| `firmware.env` | Device provisioning; set Wi-Fi privately or use device setup |
| `openclaw-plugin-config.json` | Reviewable plugin-entry template |

The directory is private; generated files are mode 0600. Repeating setup retains
the existing device token and configuration. It does not overwrite your agents,
channels, provider settings, OAuth files, firewall or reverse proxy.

## Enable and verify

```bash
openclaw s1-adv enable --config "$HOME/.openclaw/s1-adv/config.json"
# Review the exact plugin-entry change, then save it:
openclaw s1-adv enable --config "$HOME/.openclaw/s1-adv/config.json" --apply
# Restart the intended Gateway when ready to load the service:
openclaw gateway restart
openclaw s1-adv doctor --config "$HOME/.openclaw/s1-adv/config.json"
```

`enable` saves a private backup first and changes only this plugin's entry and,
when present, its membership in the existing plugin allowlist. It does not
restart anything itself. Global plugin disablement remains your choice.
The bridge child starts/stops with the Gateway, as the Gateway user. Runtime
logs redact configured tokens/passwords; configuration and recordings remain
private host data. A failed bridge process is reported for diagnosis.

Your Gateway may request approval of the bridge's newly generated identity.
Use `openclaw devices list` and approve that exact request; do not approve every
pending device. Preserve the identity under the bridge data directory.

Doctor separates configuration, HTTP, upstream connection, audio dependencies
and firmware automation. A healthy HTTP server is not a model answer or a
successful physical installation. Verify one typed question and its answer.

## TLS and device setup

The bridge listens on `127.0.0.1:31889` by default. Configure your own TLS reverse
proxy using [the Nginx template](nginx-cardputer.conf.example), preserving
WebSocket upgrades and blocking `/internal/`. Set trusted proxy addresses only
for your actual proxy. Do not expose the raw OpenClaw Gateway.

Use [the USB guide](FLASHING.md) to build for ESP32-S3 with 8 MB flash. The private
`firmware.env` has the matching device ID, token and topic; keep it outside Git.
The device setup portal can supply Wi-Fi and bridge settings. Then verify a
keyboard response, followed by ordinary push-to-talk if speech is configured.

## Optional speech and firmware automation

Ordinary voice requires STT and TTS on the host. The sample selects local Whisper
and eSpeak; these are dependencies, not included binaries or models. Follow
[the local speech recipe](OPENCLAW-VOICE.md). Realtime remains off until its
provider authentication and model are explicitly configured. A ChatGPT/OpenClaw
model login alone does not imply a usable audio endpoint.

For voice/text requests that modify firmware, provision the
[optional firmware workflow](OPENCLAW-MANUAL.md#optional-autonomous-firmware-workflow).
It requires your writable fork, Python/PlatformIO, private provisioning and
appropriate agent tool/exec permissions. These rights are not enabled by basic
plugin installation. The bridge checks capability before accepting such work.

## Give this to your OpenClaw agent

```text
Set up S1-ADV from https://github.com/srg0/s1-adv for my Cardputer ADV.
Read docs/OPENCLAW.md, docs/FLASHING.md and the packaged s1-adv setup skill.
Inspect my actual OpenClaw version/configuration before changes. Install the
reviewed bridge/ plugin using the native OpenClaw plugin installer. Use a
working dedicated restricted cardputer agent; preserve my other agents/channels.
Run s1-adv init in preview mode, then apply the private settings authorized by
this setup request. Never print tokens or provider credentials. Use my existing
host authentication; do not duplicate rotating OAuth stores. Review and enable
only this plugin entry. Arrange verified HTTPS reachability and keep the raw
Gateway private. Run doctor, one real agent round trip and a device text test.
If I request local speech, install/configure the documented providers and test
STT/TTS separately. If I request autonomous firmware work, provision the reviewed
build/publish/verify wrappers against my own fork and exact branch, with only
the agent file/exec/push permissions needed. Do not promise firmware execution
while those capabilities are unavailable. Build and flash using my private
device provisioning. Record exact source, artifact hash, boot version and
observed device reply. Keep Realtime off until ordinary chat/voice is verified.
```

For manual settings and a service-user installation, use
[the standalone guide](OPENCLAW-MANUAL.md). A directory of instructions alone
cannot serve the device endpoints. No Hermes/Kermes adapter is claimed.
