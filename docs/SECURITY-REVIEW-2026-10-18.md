# Bridge and plugin security review, 2026-10-18

Scope: the community OpenClaw plugin, private setup, bridge HTTP/WS boundaries,
stored audio, process lifecycle and optional firmware release commands. This is
a bounded maintainer review with a separate source-review pass and executable
regressions. It is not an independent penetration test or a safety guarantee.

## Confirmed findings and fixes

| Finding | Change |
| --- | --- |
| Class-global audio/OTA storage could cross different device principals | One configured device identity per bridge instance is enforced. Startup rejects legacy multi-device state before normalization. Use separate private state, media, assets and firmware directories for each identity. |
| Generated speech remained readable after topic/session remapping | Spoken-reply files require an ownership sidecar matching the device's current allowed topic and session. Old unowned generated replies are denied; they are not deleted automatically. |
| Rejected/duplicate voice uploads could retain original temporary files | The request owns and removes its temporary upload in `finally`; asynchronous STT uses the retained playback WAV instead. Empty raw uploads are removed too. |
| Retained recordings/logs could grow without a total admission limit | Before accepting persistent HTTP work, the bridge checks its private storage budget, reserves space for concurrent requests and preserves a free-space floor. Full/unavailable storage returns HTTP 507. Logs rotate at 8 MiB to one previous file; asset enumeration and reads are bounded. |
| Concurrent lifecycle calls could leave an untracked bridge process | Start/stop operations are serialized and stop joins a pending startup. |
| Legacy compatibility text bypassed turn admission | Compatibility is off by default. When explicitly enabled it shares the request start/concurrency controller and waits for upstream dispatch before releasing its lease. |
| Plugin CLI used top-level await incompatible with the native synchronous loader | The CLI entry uses promise completion; the actual Linux OpenClaw loader was exercised. |
| An explicit enable config path was not passed into the native CLI | Native config writes now receive the intended `OPENCLAW_CONFIG_PATH`, with a private backup and no automatic restart. |
| Overlapping requests could consume a neighboring response | Waiters follow the persisted Gateway run receipt. Final-chat events support older Gateway transports; unbound Codex transcript mirrors are not guessed into a request or published twice. |
| A Gateway could silently remap an overlapping queued run | A durable queue dispatches one turn per exact session until `agent.wait` proves that same run ended. HTTP expiry and visible text cannot release the lane. |
| Completed legacy ACKs could prevent startup during an upgrade | HTTP remains observable with an explicit delivery hold. Unknown receipts require exact terminal evidence or a fresh isolated state/session; history is preserved. |
| Idempotency compaction could remove an unfinished turn's ACK | Nonterminal ACKs remain pinned and the outbox independently guards its persisted request identity. |
| A transient terminal-observation failure could strand the queue | Only observation is retried with bounded backoff; uncertain requests are never resent. Proven terminal failures return a correlated failure receipt. |
| A multi-version host could run an older CLI during setup | Native enable uses the invoking OpenClaw entry point and Node runtime rather than selecting a different installation from PATH. |

## Defaults and privileges

The listener is loopback. Device tokens are random, distinct from gateway tokens,
and private files are mode 0600 under a mode 0700 setup directory. The installer
does not alter agents, channels, model authentication, proxy/firewall settings or
exec permissions. Firmware automation, Realtime, direct-provider fast lane,
inbox injection, internal OTA enqueue and legacy compatibility are off by default.
Package contents are allowlisted and checked in CI; install hooks, runtime data,
credentials and provisioned binaries are excluded.

For ordinary chat, create a dedicated agent with no host tools. The following is
the **tools section of that agent**, to merge using your installed OpenClaw
schema, not a replacement for the full configuration:

```json
{ "tools": { "profile": "minimal", "deny": ["*"] } }
```

Modern OpenClaw places it under `agents.entries.cardputer`; older versions use
the matching `agents.list` entry. Verify with your native config validator and
`openclaw security audit`. Ordinary text/voice does not need host shell access;
device actions are returned as structured bridge markers. Do not enable firmware
automation for this restricted agent and assume instructions override a deny.
See the official [tool policy](https://docs.openclaw.ai/gateway/config-tools/tool-policy).

Autonomous firmware development is a separate, explicitly enabled trusted-host
capability. Its agent can edit source and execute builds. Generated wrappers
check a clean source commit, exact branch and pushed SHA, release ownership,
candidate hash/size, version uniqueness and the served manifest/file. They are
not a sandbox: a trusted agent allowed to edit/build arbitrary source can execute
build scripts with its OS account's privileges. Use a dedicated unprivileged
account/container with only its fork, provisioning and release storage mounted.
Keep OAuth/model accounts and unrelated host data outside that boundary.

## Storage and migration

The default admission budget is 256 MiB, with 32 MiB reserved per active persistent
request, a 128 MiB free-space floor, and at most 10,000 scanned entries. It covers
configured state/media/assets/logs/OTA directories. This is an admission bound,
not a kernel filesystem quota or a limit on a separately authorized build agent.
Use an OS/container volume quota for a hard host-wide boundary. Existing data is
preserved; archive it privately or deliberately revise `storage` settings after
review. GET health/history and existing downloads remain available when new work
is refused. Retention of recordings is an operator decision, not silent deletion.

Do not reuse a mixed or another owner's data directories. Migrate to fresh private
directories. Old generated speech without ownership metadata is not re-exposed.
Do not manufacture ownership metadata for files with unknown provenance.

Delivery migration is separate from storage migration. Read the packaged
[turn queue runbook](../bridge/TURN-OUTBOX.md) before replacing an existing bridge.
Authenticated health and doctor report delivery holds. A quiet Gateway alone
does not establish the outcome of an earlier accepted run. Use a dedicated bridge
session; unrelated actors that also send into it can reintroduce an upstream run
remap that the bridge will refuse to guess.

## What is not established

Possession of a valid device token permits conversation with its selected agent.
A topic allowlist is not an agent sandbox. A native plugin runs with the Gateway
user's privileges; use the hardened standalone service for a separate OS user.
No direct unauthenticated input-to-shell path was identified in the inspected
routes, but this does not prove that every path or dependency is vulnerability-free.

HTTPS plus SHA-256 checks integrity against the served manifest. OTA does not
have an independent signature root: a compromised publisher can serve malicious
firmware. Secure boot/flash-encryption eFuses are not provisioned by setup.
Physical access to a provisioned device/image can expose credentials. The legacy
Arduino/ESP-IDF dependency boundary from the earlier review also remains.

Model/provider latency, physical-device behavior and a clean fresh-owner hardware
installation require separate acceptance. See [validation](VALIDATION.md) and the
[earlier firmware/network review](SECURITY-REVIEW.md).

Some older Gateway/provider combinations omit run ownership from stored history.
Their live final-chat event supplies it, and the bridge persists received replies
for retries. If the reply finishes while the bridge is disconnected, missing
ownership in that legacy history can prevent recovery. The bridge refuses to
associate it by timing or text; inspect/upgrade that Gateway rather than treating
an unrelated answer as success.

The legacy research harness was also corrected to report only measured property
transitions and model limitations. It no longer manufactures Cartesian coverage
or infers live-canary success from environment flags. CI runs the bounded checks
and the actual HTTP/WS/install regressions separately.
