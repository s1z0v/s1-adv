# 0.2.157-dev

Home now shows a small battery gauge and percentage directly below READY. Eight
diagonal strokes show the measured charge, with amber below 31% and red below
16%. Unavailable telemetry shows --% instead of a fabricated reading.

Only the READY box is slightly shorter. The existing clock, rings, animated bars
and chat hint keep their positions. The gauge uses the existing battery snapshot
and adds no network, storage or sensor reads to rendering.

Includes the 0.2.156 voice-mode TLS memory/worker fixes and direct previous/next
animal keys. Certificate verification, Realtime audio, and experimental NES are
unchanged.
