# Bridge security follow-up, 2026-10-23

Version 0.3.10 addresses two concerns identified while reviewing the ClawHub
0.3.9 assessment. This review is distinct from the
[public-history credential audit](SECURITY-REVIEW-2026-10-22.md). The latter
found no known private Wi-Fi password, API/device/Gateway token or maintainer
bridge ingress address in fetched public Git objects. Public author/contact
metadata remains visible as documented there.

## Authenticated diagnostic destination

Previously, `doctor` reported an unsafe listener configuration but still used
that configured host/port for its authenticated HTTP health probe. A modified
configuration could therefore direct a diagnostic device token to a remote
endpoint. Fetch also used its default redirect handling. This was a diagnostic
configuration boundary issue, not evidence that the maintainer's credentials
were present in the repository. Generated configuration uses loopback by default.

The authenticated probe now requires private file permissions on POSIX, one
device identity/token, an exact allowed loopback host and a valid integer TCP
port. `localhost` is pinned to numeric 127.0.0.1; IPv6 uses [::1]. Remote, alias
and malformed destinations are rejected before fetching. Redirects fail closed.
A valid local health response still reports HTTP, upstream and delivery readiness
separately. No config/token is printed by the checks.

Regression tests cover remote/malformed hosts and ports, public-readable config,
localhost/IPv4/IPv6 destinations and redirect refusal. A real local HTTP server
verifies that normal authenticated diagnostics succeed and a redirect does not
reach its credential-sink path. Windows file permissions still require an
operator-reviewed ACL; POSIX mode bits are not a Windows ACL guarantee.

## Conversation authority

The bridge previously described authenticated device work as an explicit owner
instruction and declared earlier chat-specific holds superseded. That wording
was too broad for a reusable public integration. Integration context now says
that existing owner restrictions, platform policies, tool permissions and
approval holds remain authoritative. Device authentication grants no new host,
build or publish permissions. Missing authorization is clarified in the same
OpenClaw conversation. A desktop Codex binding remains unnecessary.

## Remaining trust boundary

The plugin executes host code and can launch configured speech/build tools, read
selected private authentication/configuration files and contact configured
providers. These disclosed capabilities can continue to be flagged by static
analysis. The package is not an OS sandbox or an independent security certificate.
Use a dedicated restricted agent and an unprivileged service/container where
stronger isolation is needed. Keep raw Gateway/bridge listeners private and
provide a verified TLS proxy for the device. Provider voice and firmware build
rights remain separate opt-in configuration. Review the assessment for the exact
artifact you install. Do not dismiss a new finding merely because tests pass.

These fixes change bridge diagnostics and conversation context only. They do
not change the published credential-free 0.2.201-dev firmware bytes, install
anything on a device or restart the maintainer's Gateway.
