# 0.2.152-dev

The clock keeps READY and restores its original animated decorative bars.
Recording still has its separate REC state and live microphone meter.

A real microphone recording exposed an SD short write: 468 of 2048 bytes
were accepted after a card status error. The old path stopped its recording
flag but left the microphone, WAV file and prepared TLS connection alive.
That prevented sending the request and could leave the UI without enough
contiguous memory to restore its canvas. No request had reached the bridge.

Recording now uses bounded 512-byte writes and a 512-byte file buffer, at a
conservative 4 MHz SD clock. The same 16 kHz PCM16 WAV is retained and uploaded;
there is no second audio file or post-recording conversion. A short write
stops capture, closes the retained file, cancels its prepared connection and
restores Wi-Fi/audio state. A persistent notification explains the failure.
The next attempt remounts the card instead of trying to allocate a ten-minute
recording in RAM. A failed tail drain cannot continue into an upload.

Serial `diag` includes recording/file/error state. `logs.dump` reads the small
runtime journal directly over USB without another HTTPS allocation.
