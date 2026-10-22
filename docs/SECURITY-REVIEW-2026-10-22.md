# Public source and release audit, 2026-10-22

This review checks the public repository and a credential-free firmware release.
It does not certify the system as vulnerability-free or repeat physical acceptance.
The public project is [s1z0v/s1-adv](https://github.com/s1z0v/s1-adv).
Other services retain their own account identities.

## Public history

An independent HTTPS mirror of GitHub's public heads, tags and exposed pull-request
ref contained 182 commits and 1,669 unique blobs (37,807,043 blob bytes) before
this release integration. Gitleaks 8.30.1 scanned all fetched history with its
default rules and fully redacted reports. Three matches were reviewed: the public
RFC 6455 example WebSocket nonce in two files, and a synthetic token written by
an isolated firmware test. No live credential was found. `.gitleaks.toml` allows
only these exact values; the fixture token is additionally restricted to its
specific test path. A repeat scan with these rules passed.

A separate private comparison checked all public blobs against nine distinct
current values (including the private ingress hostname/origin) from the maintainer's server configuration/provisioning and six
local private values, without writing their contents to reports. Neither found
a match. The public history/ingress comparison was repeated on 2026-10-23. The candidate tracked tree and generic app image were also checked
against the local values. Private configuration is not part of the release.

This covers the publicly reachable history fetched at review time and known
current private values. It cannot prove the absence of unknown old credentials,
deleted/unreachable hosting objects, previously downloaded copies or private
server logs. Revoke any credential if an actual exposure is later identified;
history editing alone is not revocation.

Public attribution remains visible: the maintainer name, approved creator/support
links, and work-email author/committer addresses in older Git commits. These are
public identity/contact metadata, not credentials. This audit does not claim that
the repository is anonymous or contains no personal information. New local
commits have been configured to use the GitHub noreply identity; historical
commit objects were preserved.

The final known-private-value comparison on 2026-10-23 checked all 187 fetched
commits, 1,682 blobs, 1,117 trees and eight annotated tag objects, including
commit metadata/messages and filenames. No match was found.

CI now scans complete fetched Git history on main pushes and pull requests.
The scanner archive version and SHA-256 are pinned. Findings fail the job;
there is no broad exclusion for source, history or configuration templates.

## Build and distribution

The generic `v0.2.201-dev` app is built from
`89f07e45ab8cb6d51379afe43dc4b4513703a15a`, which contains server source
`cf6d7bcf538f9777e59419aa0682bdb2d34f43fb` and today's Internet Radio feature.
The firmware source files match that server revision. Explicit empty Wi-Fi SSID,
password, bridge host and device token were passed in a clean worktree. The
release disables the optional Focus lamp by default. It uses the installer's
generic device ID/routing key; each user supplies their own private token.

Public assets include a full first-install image, a matching app image and
checksums. A personal provisioned server OTA binary must never be substituted.
The full image includes the matching ESP32-S3 bootloader, dual-OTA 8 MB partition
table and app; follow the documented offsets. Provisioned images remain private.
Binary credentials are recoverable by someone with access to that image.

The combined Mesh-enabled firmware is distributed under GPL-3.0-only, with the
original notices and dependency attribution retained. The bridge remains MIT.
The release source tag, pinned dependency sources and build instructions are
available for rebuilding; see LICENSE, CREDITS.md and docs/MESH.md.

## User path and boundaries

The current video description's six project/source/credit links resolved. The
linked getting-started, flash and OpenClaw setup guides have no missing local
relative targets. The original audit used catalog bridge 0.3.6. The current guide now pins
0.3.10, published after the [security follow-up](SECURITY-REVIEW-2026-10-23.md). The native installer's preview/apply, identity preservation and
archive allowlist checks passed. No personal configuration is bundled.

The HTTP bridge defaults to loopback. Users provide a TLS reverse proxy and keep
the OpenClaw Gateway private. Device tokens grant access to their configured
agent; prefer a dedicated restricted agent. Speech and firmware build rights are
separately provisioned. This review did not alter the running Gateway, TLS,
firewall, agent permissions, private OTA queue or device settings.

A successful build, host tests and an HTTP health check do not prove a complete
new user's install or voice round trip. Follow GETTING-STARTED.md and verify the
actual device answer. Physical first-install acceptance of this generic binary
remains pending. Previous security reviews retain additional operational caveats.
