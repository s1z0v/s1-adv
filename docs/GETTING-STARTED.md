# Your first Cardputer conversation

The complete setup has two independent parts: a bridge beside OpenClaw and
firmware on your Cardputer ADV. Keep the first test small: one typed question.

1. Confirm OpenClaw already answers a normal chat on your host.
2. Follow [OpenClaw and bridge setup](OPENCLAW.md). Confirm the configured conversation is reachable with your device token.
3. Follow [USB flashing](FLASHING.md). Use your own bridge address and device token.
4. Connect the device to Wi-Fi. Check `/status`, then send `Reply with: ready`.
5. Confirm the actual answer on the device. Server health alone is not a successful chat.
6. Add voice only after text works. Hold the device's talk control, speak, release,
   and check both transcript and spoken reply. See [voice setup](OPENCLAW.md#voice).

Allow time for a first build to download the ESP32 toolchain. If USB upload
cannot connect, hold G0, press Reset, release G0, then upload again.

For a blank public build, use the Wi-Fi setup portal shown on the device or
`/setup`. The portal accepts the Wi-Fi network, bridge URL and device token.
The build wrapper also supports an ignored local `.env` file.

[Download the generic firmware](https://github.com/s1z0v/s1-adv/releases/tag/v0.2.201-dev)
or build from source. The generic image has no personal credentials and uses
the installer's default device ID/routing key; see the flashing guide before
writing it. The current firmware includes [Internet Radio](RELEASE-0.2.200.md).

Use a dedicated agent/session for initial tests. OpenClaw actions remain subject
to the permissions you grant that agent. Your device token grants access to the
conversation configured for that device in the bridge config. Telegram forum
topics are not required. The bridge's `topic_key` field is the internal routing
key for this conversation, not an on-device topic feature.

Next: [controls](CONTROLS.md), [architecture](ARCHITECTURE.md),
[troubleshooting](TROUBLESHOOTING.md).
