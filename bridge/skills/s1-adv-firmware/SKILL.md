---
name: s1-adv-firmware
description: Change, build, publish and verify S1-ADV Cardputer ADV firmware when its owner requests a new device feature or OTA release through OpenClaw.
---

# S1-ADV firmware requests

Use this from an ordinary OpenClaw conversation or an authenticated Cardputer
request. Execution belongs on the configured OpenClaw host. A desktop chat URL,
Codex binding or the maintainer's server is never a prerequisite.

Find this plugin's private config through
`plugins.entries.s1-adv.config.configPath` in the intended Gateway profile.
Read it locally without printing device/provider tokens or Wi-Fi values. Run
`openclaw s1-adv doctor --config /ABSOLUTE/PRIVATE/config.json`.
Use `firmwareAutomation.repoDir`, `branch`, `pushRemote` and the generated
`wrappers.build`, `wrappers.publish` and `wrappers.smoke` from that config.
Do not substitute the maintainer's paths, fork, account or credentials.

If firmware automation is unavailable, report the actual missing capability.
Use the `s1-adv` setup skill and the repository's
`docs/OPENCLAW-MANUAL.md#optional-autonomous-firmware-workflow` to provision it
within the owner's request and permissions. Installing a skill does not grant
file access, command execution, provider access or repository push permission.
Clarify an unspecified feature before changing source.

Keep the configured OpenClaw session for questions, typed answers and G0 voice
answers. Do not create a separate firmware session or infer intent from a word
such as "version". Use `cardputer_status` with the current `request_id` supplied
by the bridge: `awaiting_input` with the visible question before work,
`building` with `work_kind: firmware` immediately before implementation,
`completed` only after verified publication, or `failed` for a real failure.
For a continuation, include the existing `active_task.task_id`. Ordinary
questions do not change a pending task. The tool is scoped to this configured
Cardputer conversation and grants no build/install permission. If unavailable
in a standalone installation, its equivalent is `scripts/agent-status.mjs`
with the operator's private `--config`, exact `--session-key`, `--request-id`,
`--state` and `--work-kind`. Never invent a successful status update.

For an authorized change:

1. Acknowledge the requested feature before a long build. Inspect the exact
   configured fork/branch and its instructions. Preserve dirty or competing work;
   do not switch/reset another checkout. Check the current OTA manifest/version.
2. Implement the requested change for **Cardputer ADV, ESP32-S3, 8 MB flash**.
   Bump the app version for a new image, run checks appropriate to the change,
   and review the diff. Keep provisioning private. A feature request does not
   authorize changes to partitions, bootloader, TLS/auth or storage erasure.
3. Commit the reviewed source before building. Invoke the configured build
   wrapper without arguments. It produces a private receipt/candidate for that
   exact commit. Preserve its release lock if a later step fails; inspect it
   before retrying, rather than launching another build.
4. After the build succeeds, push that exact commit to the configured remote
   and branch. Invoke the publish wrapper with the actual new version and a
   concise release note, then invoke the smoke wrapper without arguments.
   These wrappers enforce the clean source, build receipt, pushed commit, OTA
   slot limit and authenticated manifest/file checksum checks.
5. Report the verified version and availability on the device. Publication and
   physical installation are distinct: leave installation confirmation to the
   device unless the owner explicitly requested installation. Report actual
   boot/version and a device reply only after observing them.

The bridge already accepts device requests, emits the initial receipt, and
routes their results back to the originating device. Do not submit the same
accepted task again, forge an Inbox response, or mark an uncertain run complete.
Preserve the request/run identity. Read `TURN-OUTBOX.md` for delivery holds.

Never attach a provisioned candidate or private config to a public release.
Source/tests, verified OTA delivery, installed firmware and physical acceptance
must remain separately identifiable in the result.
