# 0.2.180-dev and Bridge 0.3.7

The Home badge keeps showing LOADING while reply speech is queued or being
prepared, after the model's THINKING phase. No additional sheet is opened.
Voice first responses carry an explicit speech instruction, including one-word
answers and acknowledgments while the primary agent continues its work.
Technical delivery receipts remain silent. Older Bridge responses retain their
existing speech behavior.

The first responder uses the existing isolated OpenClaw completion and configured
LUNA / medium role. Its reply is limited by instruction to fewer than 18 words
to reduce generation and playback time. The primary model, session, tools,
durable delivery fences and model permissions are unchanged.

Validation before publication: all 142 Bridge tests passed, including retries,
deadline escalation, short voice answers and explicit speech policy. Package
inspection, security policy and bounded model checks passed. Actual firmware
receipt, Home badge, voice flow and unified Home render checks passed using the
macOS 26.5 SDK. Live deployment, image verification and physical-device results
are recorded separately after the release.

The personal host subsequently installed Bridge 0.3.7 with matching hashes for
all 39 files. OTA smoke verified the complete 2,008,128-byte image, and the
device booted 0.2.180-dev from the exact pushed source on app1 (valid) at
09:38:05 UTC. A synthetic STT-to-LUNA-to-TTS test passed, taking 9.228 seconds
to ready audio on host loopback. Physical microphone/speaker and screen
acceptance remain separate. See [validation](VALIDATION.md) for the receipt
scope; ClawHub latest is still 0.3.6.
