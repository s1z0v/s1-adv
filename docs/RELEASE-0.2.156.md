# 0.2.156-dev

Repeated voice-mode switches could exhaust TLS handshake memory on the ESP32-S3.
Realtime now waits for an outstanding voice connection or reply-audio worker and
discards unused voice preconnections. TLS temporarily borrows the display sprite
memory, then restores the screen on success, failure or cancellation. The last
PREPARE frame stays visible during the handshake. Certificate verification is
unchanged.

The literal **[ / ]** keys advertised by the assistant menu now change animals
on Big Eyes, Chat Eyes and Realtime, including during listening. Ctrl shortcuts
remain available and plain brackets remain text in Full Chat. App and command
shortcuts also work when a voice notification is visible.

This release does not enable server-side Realtime agent tools. That bridge
setting determines whether live speech can delegate development work to OpenClaw.
NES remains unchanged and experimental.
