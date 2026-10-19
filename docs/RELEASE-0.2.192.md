# 0.2.192-dev

Combines the reviewed server file-manager release 0.2.191 with the owner-requested
Pulse UI correction. Thin outline rings and Thinking geometry return to 0.2.188;
the independently centered chat chevron from 0.2.189 stays.

Realtime reply audio uses eight 2 KiB blocks instead of requiring one contiguous
16 KiB allocation. The PCM capacity, pacing and backpressure are unchanged.
Partial failures release all allocated blocks, and reply buffers are freed before
microphone capture resumes. See RELEASE-0.2.190.md for the recorded fragmented-heap
failure and production-function regression coverage.

Media > Files browses the SD card. Up/Down selects, Enter opens a folder, D/Del
asks to delete one file, Y confirms, and any other key cancels. Esc goes up.
The browser bounds each listing to 128 entries, blocks deletion during active
storage work, rechecks the target and releases its list on exit. Internal flash
and recursive folder deletion are not exposed. No existing recordings are
automatically removed for the Realtime RAM error.

The server's 0.2.191 source and binary were preserved before this combined release.
Published version numbers and binary hashes are never reused. CI also executes
the SD browser/deletion regression in addition to the Realtime sanitizer test.

Bridge 0.3.9 separately reserves completion-receipt time inside the fast-response
deadline and adds safe run-ID timings. Completion defaults are 10 seconds inside
a 12-second outer limit; a completed answer returns immediately. This prevents
equal-deadline races but does not promise subsecond model inference.

Source tests, published artifact verification and physical-device acceptance are
separate gates. Do not mark this release a stable baseline before repeated
Realtime replies and physical file-manager/navigation checks pass.
