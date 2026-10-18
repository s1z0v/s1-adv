# Bridge integration security review, 2026-10-19

Scope: published plugin 0.3.4, source `1674ca16e3b904ff91689bcf249b76d5a072eb8b`,
its HTTP/WS boundaries and the maintainer's actual OpenClaw deployment. This is
a bounded maintainer review, not an independent penetration test or a guarantee
that no vulnerability exists. Compare this with the
[earlier source review](SECURITY-REVIEW-2026-10-18.md).

## Findings and changes

| Finding | Result |
| --- | --- |
| Native HTTP worker inherited a root Gateway's privileges, losing the previous service isolation | Fixed in the deployment: the same published bridge code runs under a dedicated unprivileged account in its own systemd service. Native plugin startup now refuses UID 0 by default. `allowRoot: true` is an explicit exception, not a recommended baseline. |
| A bridge speech key had been added to the whole Gateway environment | Removed that generated Gateway drop-in. The intended bridge service receives the existing private key; the Gateway process no longer inherits it. A root operator can still read host secrets, so this is environment scoping, not isolation from root. |
| OpenClaw had no explicit plugin allowlist | Existing configured plugin IDs were pinned without enabling other plugins or changing agents, channels, model configuration or tool policy. |
| An isolated HTTP account could not inspect the build account's checkout, while readiness required that access | Optional upstream-agent mode accepts only a root-owned, non-group/world-writable preflight for the exact configured workflow. The operator performs the real access check; the worker receives no build-account filesystem access. Release wrappers retain their source/lock/byte checks. |
| A subsequent root publisher could create an OTA file unreadable by the HTTP account | Explicit `firmware.storageOwner` assigns the configured numeric UID/GID to binary and manifest, both mode 0600. A subsequent actual root publication was served through the unprivileged HTTP worker and checked by full HTTPS download. |
| Device-created firmware jobs were not consistently admitted after creation/restart | Only a hidden job belonging to that exact device, with continued access to its configured source conversation, is retained. Revocation and unrelated-job cases have regressions. Old held work is preserved without automatic replay. |

The plugin remains installed for its CLI and both skills. Native `autoStart` is
false on this root-Gateway deployment, preventing a second HTTP listener.
The separate service runs the same reviewed package, not the old bridge code.
Unprivileged Gateways can continue using native lifecycle management. See the
[manual isolation guide](OPENCLAW-MANUAL.md#root-gateway-with-an-isolated-http-worker).

## Verified deployment boundaries

Readback from the actual worker and its mount namespace established:

- An unprivileged UID/GID, no effective Linux capabilities and `NoNewPrivileges`.
- `ProtectHome` and a read-only system/package filesystem. The worker could read
  its private runtime snapshot and write its state, but could not read operator
  config, Gateway config, model auth store, firmware checkout or provisioning.
- A separate service cgroup with a 384 MiB hard memory limit and one CPU core
  quota. These protect the Gateway from this service's resource use; they are not
  a throughput benchmark or a minimum sizing recommendation.
- The same loopback HTTP port, existing TLS origin and restricted origin proxy.
  Direct Gateway/worker ports were not externally connectable. Public internal
  OTA requests, including a forwarded-loopback spoof, were refused.
- Missing/invalid device credentials returned 401 for chat, voice, assets and
  OTA. Anonymous health exposed only `{"ok":true}`. An unknown browser origin
  received no CORS grant and was refused by both WebSocket routes; invalid WS
  connect frames received an authentication failure without an agent turn.
- Existing device identity, topic/session mapping and state were preserved.
  An uncertain held request was not resent, discarded or declared completed.

Both the native installation and isolated runtime matched all **34** published
file hashes. Their dependency versions matched. The public ClawHub ZIP is
4,567,470 bytes, SHA-256
`a761aa1f2d772e56588d5ff9209a8f7cf55209d1c6b7aa1fa37686cc99435db0`.
ClawHub's aggregate assessment is **Clean**, with source-linked metadata and no
signed build provenance. Its static process/environment/credential-read flags
remain disclosed. The aggregate result is not a security certification.

## Regression and operational checks

All **119** host tests passed, including root startup refusal, delegated-preflight
trust, private OTA ownership, durable delivery and device job admission. Security
policy/model checks, ordinary integration smoke, Realtime contract and package
inspection passed. The dependency audit reported zero known vulnerabilities.
Both bridge and ESP32 firmware CI passed for the release source.

After the service cutover, a real configured agent completed one text request and
one synthetic-speech/STT request. Both had their own answer and exact terminal
`ok` receipt. An idempotent retry retained one outbox record. Configured TTS
returned 55,200 bytes of PCM. These are server/provider checks, not physical
microphone, speaker, display or firmware acceptance.

After the native plugin upgrade and a graceful Gateway reload, the same isolated
worker stayed running without a service restart and completed another fresh text
turn with its own exact terminal receipt. Upstream connectivity recovered. The
aggregate `delivery_ready` flag still reports a known older held firmware request;
that record was preserved rather than replayed or hidden. This is not a claim
that every old queued request has been resolved.

## Residual trust and limits

An authenticated device can use the selected agent's existing tools. On a private
owner device with firmware automation enabled, that is intentionally powerful.
A stolen device token is consequential: revoke it and use a restricted dedicated
agent for shared/untrusted devices. Agent instructions and skills are not a
sandbox. Native plugin entry code itself remains trusted Gateway code, even when
the public-facing worker is isolated.

The general OpenClaw audit still reports three critical permission findings for
the existing group-writable auth database/WAL/SHM, plus six warnings including
broad tool policies. The missing plugin allowlist finding was removed. The bridge
account is outside that auth group and cannot access the store. This review does
not approve or change the whole host's separate credential-sharing policy.
No live denial-of-service, exhaustive exploit search or new physical-device
acceptance is claimed. Private rollback/config/state evidence is retained outside
the public package; no personal credentials, recordings or provisioned images
are published.
