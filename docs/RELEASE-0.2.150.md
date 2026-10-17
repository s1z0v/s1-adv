# 0.2.150-dev

Voice uploads use 4 KiB staged writes and enable TCP_NODELAY on the connected
TLS socket. Upload progress, transcription and agent processing have separate
labels. The bridge accepts a bounded request wait budget, so firmware can obtain
a pending receipt after one second instead of keeping the upload screen open
for the previous ten-second agent wait.

An accepted voice request shows its transcript and a persistent pending state
in AI Chat with a short confirmation tone. A later inbox reply opens the chat
and signals its arrival. Empty assistant/tool messages cannot consume the
pending reply or advance the device's inbox cursor.

Device Settings → Clock format selects 12h AM/PM or 24h. AM/PM is the default
for installations without a saved choice; midnight and noon use 12 AM and
12 PM. The large home digits retain their font, with a separate period label.
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
