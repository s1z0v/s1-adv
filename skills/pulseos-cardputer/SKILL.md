---
name: pulseos-cardputer
description: Help set up or troubleshoot the M5Stack Cardputer ADV firmware and standalone bridge for an existing OpenClaw gateway.
---

# PulseOS Cardputer ADV setup

Use the checked-out source at https://github.com/srg0/pulseos-cardputer.
Read README.md, docs/OPENCLAW.md, docs/FLASHING.md and docs/TROUBLESHOOTING.md.

Inspect the installed gateway version, actual workspace and session routing.
Use the bridge/ Node service; the skill alone provides no network adapter.
Preserve existing agent/channel settings and use a dedicated Cardputer session.
Store gateway and device tokens only in private local files. Keep provider
credentials and OAuth stores on the gateway host. Never print them or copy
rotating OAuth profiles to a second writer.

Configure the device's bridge host, port, ID, token and topic to match the local
bridge config. Remote access needs verified TLS. Build using scripts/cardputer.py
for ESP32-S3 and 8 MB flash. Never use a 2 MB legacy partition layout or flash
an app-only firmware.bin at 0x0.

Run the synthetic bridge smoke and security tests, authenticated topics/history
checks and one actual device text round trip. Add STT/TTS only after text works.
Realtime provider setup is optional and remains disabled unless requested.
Report separate evidence for build, flash, boot and actual device reply.
Do not claim successful installation from a healthy HTTP endpoint alone.
