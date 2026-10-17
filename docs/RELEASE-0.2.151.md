# 0.2.151-dev

Ordinary voice is recorded directly as 16 kHz mono PCM16 WAV on SD. The same
finalized file is kept in voice-note history and uploaded; there is no second
copy or post-recording compression. The input microphone rate is independent
of Realtime. A verified TLS connection is prepared while recording, and
canceled recordings cannot reuse a stale connection. Network work is serialized
to avoid overlapping TLS allocations on the small device heap. Wi-Fi modem sleep is disabled only during voice capture/upload and restored
after completion or cancellation, matching the throughput policy used by Realtime.
Idle speaker DMA
is released before network operations; low-memory fallback restores the canvas
after the request completes. Recording finalization drains the queued mic tail.
Uploads use 16 KiB staged writes in a heap-owned buffer and enable TCP_NODELAY on the connected
TLS socket. Upload progress, transcription and agent processing have separate
labels. The bridge accepts a bounded request wait budget, so firmware can obtain
a pending receipt after one second instead of keeping the upload screen open
for the previous ten-second agent wait.

An accepted voice request shows its transcript and a persistent pending state
in a notification sheet above the current assistant screen with a short
confirmation tone. A later inbox reply replaces the sheet and is spoken using
a background download, leaving keyboard navigation responsive. Enter opens
AI Chat; Escape dismisses the sheet and cancels its pending speech. Longer
replies use more screen space. Empty assistant/tool messages cannot consume the
pending reply or advance the device's inbox cursor.

Firmware requests, including UI edits spoken without the word "firmware", go
to one server-owned OpenClaw implementation job. They do not require a desktop
Codex chat or chat binding. Ordinary voice keeps the existing conversation.

Device Settings → Clock format selects 12h AM/PM or 24h. AM/PM is the default
for installations without a saved choice; midnight and noon use 12 AM and
12 PM. The large home digits retain their font and display only the time, with
no AM/PM indicator on the home screen.
Screensaver clock chips follow the selected format. AI Agent, AI Chat and AI
Pet replace the previous OpenClaw labels in the device interface.

Realtime remains experimental. Two small delivery corrections complete a
rebuffered, drained speaker before the prebuffer gate and release terminal
messages independently of server history storage. This release does not claim
full Realtime acceptance.

Regression checks compile the real playback transition and clock formatter,
and exercise the bridge's actual response callback/pacer while persistence is
blocked. Physical upload timing and installation are recorded separately by
the operator.
