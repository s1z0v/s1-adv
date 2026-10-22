---
name: s1-adv
description: Install, configure and diagnose the S1-ADV Cardputer ADV OpenClaw plugin or standalone bridge, with optional private firmware automation.
---

# S1-ADV Cardputer setup

Source and full setup guide:
https://github.com/s1z0v/s1-adv/blob/main/docs/OPENCLAW.md
Read the packaged README first. Check the installed OpenClaw version, actual
configuration/profile, selected agent, workspace and device-reachable HTTPS URL.

Prefer the native plugin installer for bridge/ from a reviewed source or release.
Use `openclaw s1-adv init` to inspect the plan, then apply within the user's
authorized setup request. A dedicated restricted cardputer agent must exist
before applying its route. An explicit --agent main selects the existing private
agent with that agent's permissions; do not silently grant it to shared devices.
Use enable/doctor for plugin settings and separate HTTP/upstream/provider checks.
A Gateway restart is a distinct operation on the intended profile; preserve
other agents/channels and do not reset or import unrelated state.

The plugin hosts a local authenticated service, normally 127.0.0.1:31889. It needs
a verified TLS proxy reachable by the Cardputer. Keep the raw Gateway private.
Store gateway/device tokens only in private local files. Never print them or put
provider credentials on the device. Preserve the generated identity. If pairing
is required, approve only that exact bridge request. Do not duplicate rotating
OAuth profiles into a second credential writer.

Text comes first. A healthy HTTP endpoint or connected upstream is not a model
reply. Verify an actual typed round trip. Local speech requires the documented
Whisper/model, FFmpeg and eSpeak setup; test recognition and playback separately.
Do not infer audio-provider access from a text-model login. Keep Realtime off
until ordinary chat/voice works and separate provider configuration is complete.

For firmware work, first provision the optional reviewed build/publish/smoke
wrappers against the user's own writable fork and explicit branch/remote, with a
Python/PlatformIO environment and private device provisioning. Read/edit/exec/git
permissions remain controlled by the host owner; the setup does not bypass them.
Do not promise firmware execution when capability checks report unavailable.
Review and commit source before build, build one clean exact commit, push that
commit, publish, then verify authenticated served manifest/file size and SHA.
Preserve release locks and dirty work; never reset/switch another checkout to
make a build pass. Personal firmware candidates may embed credentials.

Build/flash with the repository's scripts/cardputer.py for ESP32-S3 / 8 MB flash.
Never flash an app-only firmware.bin at 0x0. Use the USB guide and existing owner
authorization, try automatic entry/reset where supported, then verify actual
boot/source and a device reply. Report code tests, package/native install, model
round trip and hardware acceptance separately.

## Security defaults

Use one device identity per bridge instance and fresh private runtime directories
for each independent owner/device. Start ordinary chat with all host tools denied
under the selected dedicated agent's tool policy. Do not infer that creating an
agent restricts its tools. Read docs/SECURITY-REVIEW-2026-10-18.md and validate the
actual installed OpenClaw schema. Autonomous source/build/release work requires
separately reviewed OS, repository, provisioning and command permissions.
Storage-full errors preserve recordings; archive privately or review the budget,
never disable bounds or erase user data just to make a check pass.
