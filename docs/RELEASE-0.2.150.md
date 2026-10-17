# 0.2.150-dev

Voice uploads convert 24 kHz PCM16 to a 16 kHz mu-law WAV, reducing the body by
about three times. Original saved voice notes keep their recording quality;
if encoding/storage fails, the upload can fall back to the original PCM.
The bridge converts the compact WAV to PCM before transcription.
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
