# 0.2.185-dev voice stability

Realtime kept its 16 KiB reply ring permanently reserved while microphone
frames and TLS/Wi-Fi needed the same limited internal RAM. The ring now exists
only for reply playback and is released before microphone restart. A reply
arriving in the same socket poll as VAD stop ends capture before allocation.
The buffered display remains allocated throughout; this does not restore the
old direct-display canvas handoff.

The candidate also bounds Wi-Fi packet pools, reduces connection worker stacks,
preserves the voice POST socket for stateless TTS, wakes Realtime explicitly,
and provides one guarded reassociation after a failed transport. It never
automatically repeats an agent request. The published 0.2.184 clock color is
preserved.

Offline tests execute the real playback/recording functions, socket ownership,
HTTP worker and Wi-Fi wrapper. Allocation failure, cancellation, reset, ring
wrap, partial frames and blocked playback are covered. These tests are separate
from physical acceptance.

The USB diagnostic passed three microphone/reply turns, ordinary PTT, then six
more Realtime turns in one connection. Every tested reply drained with zero
dropped PCM bytes. VAD-stop to playback was 0.64–1.01 seconds in the six-turn
sequence. PTT release to playback was 15.293 seconds, so ordinary voice latency
is still a separate optimization. Exact release-image installation is recorded
after publishing; diagnostic acceptance is not an OTA installation receipt.

Bridge 0.3.8 now bounds the complete TTS response body. On the personal host,
only the private TTS model changed to `tts-1`; agent roles were preserved.
Three short TTS requests took 0.86–1.41 seconds on the server. This is not a
whole voice-turn latency guarantee or registry publication receipt.
