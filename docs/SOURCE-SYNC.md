# Firmware source continuity

The current public source is `0.2.151-dev`. Ordinary voice records one 16 kHz
mono WAV that is both retained in history and uploaded, with an early verified
TLS connection and visible reply notifications. See the current
[release notes](RELEASE-0.2.151.md). Building or publishing alone does not
establish installation or acceptance on hardware.

The recovery below documents how the earlier `0.2.147-security.1` baseline
combined the procedural eye skins with public transport, provisioning and OTA
security fixes.

The original `0.2.147-dev` was built from an uncommitted working copy based on
the older `0.2.146-dev` source. Its source archive was recovered from the private
release backup on 2026-10-17. Archive SHA-256:

```text
8df47c86a35fe3988fbaed705ec7c9bde3d982353697fdce0d34b1a33b31a863
```

Only its source changes, release notes and relevant host checks were restored.
Private provisioning, binaries, Python caches and macOS metadata are excluded.
The independent S1-ADV Git history is retained.

The recovered changes add Black, Cat, Tiger, Leopard, Lion and Rabbit skins
under **Device > Display > Eye skin**, shared with the Big Eyes screensaver.
They replace the bitmap renderer and preserve the existing voice and Realtime
behavior.

## Keeping an OpenClaw checkout current

Use `https://github.com/srg0/s1-adv.git` or the corresponding SSH URL as the
firmware source. Fetch the current source before starting a device request:

```bash
git fetch origin
git status --short
```

Preserve any local changes and working branch. For a new feature, create a
branch from the intended current source; do not merge legacy OmniBot history
into S1-ADV. If a deployed firmware version is ahead of the checkout, recover
its source before building a replacement.

After implementing a feature:

1. Update the version in `platformio.ini` and `src/main_parts/001_main.cpp.inc`.
2. Run the relevant host checks and build with private settings outside Git.
3. Commit the exact source and push the branch before publishing its binary.
4. Record the source commit in the OTA manifest, then verify the downloaded
   image's version, size and SHA-256.
5. Report device installation only after device confirmation.

Keep credentials out of commits and public artifacts. See
[validation](VALIDATION.md) and [OpenClaw setup](OPENCLAW.md).
