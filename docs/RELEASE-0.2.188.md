# 0.2.188-dev push-to-talk upload

Ordinary push-to-talk starts a verified TLS upload while recording. The sender
reads flushed PCM from the original SD WAV under a file mutex and restores its
append cursor before capture continues. Button release finalizes the WAV and
commits the single chunked HTTP request. The original remains in Voice Notes.
RAM-only recording keeps its existing upload path.

Escape, short capture, storage failure and interrupted upload do not commit an
incomplete request. A failed cursor restore stops subsequent SD writes. After
a commit attempt with an uncertain response, the UI asks the user to check chat
before retrying. No agent request is automatically repeated.

The existing Bridge raw-audio endpoint accepts streaming bodies. STT and the
agent start only after the complete HTTP body; this change overlaps upload with
recording, rather than promising Realtime response latency. The ordinary path
still has separate transcription, model and speech stages.

On the USB prototype, 331776 of 339968 PCM bytes (97.6%) were sent before release;
the remaining tail and commit completed about 0.5 seconds after release. The
control transcript was correct, but Luna hit its 8-second deadline and escalated.
That run is not a successful fast spoken-answer benchmark. A separate cancelled
capture sent 110592 bytes, emitted no commit footer, and the Bridge recorded an
aborted request. The following Realtime turn started playback 899 ms after VAD
stop and drained with zero dropped bytes. Final-image acceptance is separate.

Host tests cover actual producer/reader functions, SD cursor failure, partial
socket writes, release races, early HTTP rejection, cancellation and uncertain
delivery. HTTP integration tests use the actual raw route and filesystem with
STT/agent spies. The 0.2.186 white clock and 0.2.187 KeyRush/REC changes are kept.
