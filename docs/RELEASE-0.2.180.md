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
