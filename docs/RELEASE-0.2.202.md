# 0.2.202-dev — Local VLC Remote

**Media → VLC Remote** adds a small password-authenticated LAN remote for VLC
on a Mac, without moving audio onto the Cardputer. The Mac's chosen output
(including its own headphones/speakers) continues to play the audio.

- Open the remote to discover the configured Mac and fetch read-only status.
  No autoplay, media import, playlist deletion, file browsing or arbitrary URLs.
- Bonjour `_vlc-http._tcp` discovery supplies host/port only for a matching
  configured Mac hostname. Next comes `.local` resolution, then a provisioned
  private fallback IPv4/port. Only private addresses on the current Cardputer
  subnet are accepted; redirects are not followed.
- Enter/Space: play/pause. X: stop. N/P: next/previous playlist item.
  W/S or arrows up/down or +/−: VLC volume about ±5 percentage points.
  A/D or arrows left/right: seek ±10 seconds where VLC supports seeking.
  R: rediscover/reconnect. Esc: exit without stopping the Mac.
- Show connected/offline, VLC playback state, title, position/duration, volume
  and discovery route. Read-only polling every three seconds while open and
  idle. Errors stop polling until an explicit R; 401 is distinguished from
  network failures. Commands are never queued, automatically retried or sent
  to fallback candidates after an uncertain result.
- A single cancellable worker owns discovery/TCP and its bounded response
  buffer; UI/input/timers continue. TCP operations have an overall 2300 ms
  deadline per request, connection timeout 800 ms. SDK mDNS service query is
  bounded at 3000 ms, hostname query at 1000 ms. A discovery pass may therefore
  take several seconds while trying read-only fallback status requests.
- Deferred exit retains worker ownership until cleanup. Voice/Realtime,
  radio, background TLS and OTA cannot borrow its active worker resources.
  Exiting restores the ordinary app/network scheduling behavior.

## Private defaults and existing installations

An optional pre-build script accepts only a local private provisioning file,
validates mode/fields, and generates an ignored **0600** header under `.pio`.
Neither credentials nor personal addresses appear in this public source or
release notes. No password is added to compiler flags, command-line arguments
or URLs. Public/unprovisioned builds show `VLC not provisioned`.

Existing devices without an explicitly configured, valid VLC-specific NVS
namespace use the new provisioned defaults, rather than empty old settings.
Defaults need not be written to NVS. No Wi-Fi/device provisioning, partitions,
bootloader, TLS/auth, SD contents or unrelated app settings are altered.
The private provisioned binary remains private; never attach it to a public
GitHub Release. VLC HTTP Basic Auth is cleartext and intended only for a trusted
LAN with a separate VLC password, not internet exposure.

The release is based on current `main`, retaining its newer bridge security
fixes and every already-published 0.2.201 application change. Switching the
private release configuration off the deleted branch was explicitly approved.

## Evidence

**58 standalone host scripts passed** (the user-supplied external-ROM harness
is excluded). New sanitized checks execute production code for:

- HTTP 200 status parsing and 401/errors; content-length, EOF and chunk framing;
  malformed/oversized/truncated inputs, address policy and fuzz under ASan/UBSan.
- Actual threaded worker: Bonjour → hostname → fallback preference; hostname
  binding, every command, timeout without replay, cancellation, exclusive
  ownership and resource cleanup under ASan/UBSan.
- Actual UI: old NVS/default migration, no autoplay/command backlog, polling,
  resource guards, deferred exit and 240×135 rendering bounds under ASan/UBSan.
- Private generation: permission/field validation and absence of secret flags.

Existing chat, voice, OTA, radio, lamp, Mesh, SD and game regressions also pass.
The owner's Mac-side HTTP/Bonjour checks are separate evidence, not a claim
that this firmware has been physically installed or tested with that Mac.
Physical OTA installation, mDNS visibility on the owner's Wi-Fi and acceptance
of controls/audio remain unverified until observed on hardware.

Russian usage/report: [VLC-REMOTE.md](VLC-REMOTE.md).
