# 0.2.159-dev

Ordinary voice now uses one VOICE REQUEST window from capture through upload,
processing, acceptance and reply. Releasing G0 no longer flashes the Home screen
before a notification covers a persistent Thinking screen. A server receipt is
an accepted background request, not a blocking device state.

The accepted receipt shows the recognized text in its original language.
**Enter** opens the ongoing chat. **Esc** returns Home with READY while delivery
continues. A later reply updates the request window or appears inline if chat
is already open. Failed receipt confirmation directs users to check chat before
retrying, rather than falsely claiming that nothing reached the server.

Firmware requests run on the OpenClaw server using its repository and locked
build/publish wrappers. Device execution needs no desktop chat, URL or binding.
Battery/UI change requests, including Russian speech, use the firmware job route
and return an explicit accepted receipt. Receipt sequence tracking suppresses a
duplicate acknowledgment being mistaken for the final answer.

Speech recognition remains multilingual with automatic language detection.
English is the default reply language. Product-name hints guide transcription
without forcing English input or translating the user's speech. Realtime audio,
verified TLS, SD recording, the compact Home battery and experimental NES remain.
