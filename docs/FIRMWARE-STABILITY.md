# Firmware request and UI stability, 0.2.167-dev

This candidate retains the compact Home frame, REC/THINK graphics, battery,
eyes, and the requested yellow idle clock. RFID implementation is unchanged.

## Request acknowledgement and job status

Voice and asynchronous text acceptance share one handler. It stores the actual
server acknowledgement in assistant history before advancing the inbox cursor,
shows the receipt on Home/Clock or inline in chat, and never sends it to TTS.
An inbox replay can therefore be acknowledged without losing the receipt body.
Final text replies queue the existing background speech worker rather than
blocking loopTask inside HTTPS/TTS.

The bridge persists `topic.firmware_job` per device/request. The accepted turn
and every pending-inbox response expose `firmware_job`, even with no new events.
Device reboot reconnects to the persisted status through ordinary polling.

| Server state | Home label | Meaning |
| --- | --- | --- |
| idle / ready | READY or NEW UPDATE | NEW UPDATE still requires a valid newer local manifest |
| building | BUILDING | An actual request is active; tool-only messages remain progress |
| failed | BUILD ERROR | Agent error or abort |
| attention / stalled / uncertain | CHECK CHAT | Clarification, no proven publication, stale job, or ambiguous RPC receipt |
| building without a status sync for 90 seconds | CHECK LINK | Connection evidence is stale |

Ready requires a different valid manifest hash, nonzero image size, publication
after job start, a full source commit, the published version in the final reply,
and the normal OTA action marker. Old bootstrap history and tool calls cannot
finish a newer job. Optional Telegram mirroring cannot fail the actual job.
An RPC timeout is uncertain because later gateway progress may prove execution.
Observed live gateway shapes were `toolUse` with `thinking`/`toolCall` and final
`stop` with `text`, with millisecond timestamps.

## Main-loop ownership

The original low-memory fallback deleted the sprite to free TLS memory, while
`render()` returned immediately if that sprite was absent. Background HTTPS
therefore left a frozen frame even though the input loop was still running.
Drawing now uses the same graphics API on the sprite or directly on the display
while TLS borrows sprite memory. Only loopTask draws, configures audio, applies
inbox results, and persists a downloaded manifest. The worker owns its HTTP/TLS
objects and returns an immutable result; destructors run before task deletion.
The direct mode needs physical visual/latency verification, including flicker.

Periodic OTA manifest GETs use the existing single inbox worker every 20 seconds
from the previous dispatch, after the 30-second boot settling window. Recording,
playback, transfers, text, Realtime, pending ACKs and transport ownership defer
checks. They remain due after a busy period. Errors retry without a tight loop.
Manual checks also use this worker; only a successful fresh result can schedule
an explicitly requested apply. Escape cancels the queued apply/check result.

G0 paints feedback before storage/microphone initialization. A press during an
inbox poll requests cancellation at safe worker boundaries and keeps a queued
capture while held; release/Escape cancels that queued capture. The worker is
never killed during TLS. Its handshake/socket timeouts bound ordinary poll waits;
DNS/network-driver latency still needs measurement. Capture does not run TLS.

Input routing runs before network completion/storage work. Idle inbox completion
no longer reinitializes speaker DMA on every poll. A small live line at the top
right indicates the inbox/manifest worker while the rest of the UI still renders.

## Measurement and regression gates

USB commands `ui.perf`, `voice.capture.status`, `home.update.status`, and `diag` expose
state and profiling. Serial records `[UI_LATENCY]`, `[VOICE_LATENCY]`,
`[UI_SERVICE]`, `[OTA_AUTO]`, `[FIRMWARE_JOB]`, and `[REQUEST]` correlate input to
first rendered frame, G0 to microphone/REC, slow service cost, loop service gaps,
heap/largest-block/stack minima, network dispatch and acceptance.
These measurements are distinct from bridge upload/STT/agent/TTS round-trip time.

Host regression tests execute actual request completion, navigation, G0,
render dispatch/surface selection, OTA scheduling, persisted StateStore restart,
and bridge lifecycle code with deterministic boundaries. They do not establish
physical latency, visual acceptance, actual 20-second network cadence, or five
native device-outbound canaries. Required physical canaries are sequential and
retain device turn ID, bridge acceptance/ACK, gateway job, pushed source commit,
build/binary/manifest hashes, final event/ACK, OTA result and native boot report.

Remaining deliberate synchronous paths include explicit legacy diagnostic HTTP,
manual media downloads and OTA installation. The new service trace must identify
any additional routine-path stalls before widening the architectural change.
No partitions, bootloader, credentials, auth/TLS policy or watchdog settings are
changed by this candidate.
