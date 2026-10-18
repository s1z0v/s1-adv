# 0.2.162-dev

Ordinary voice restores the original REC and THINK artwork. Releasing G0 keeps
THINK visible while the saved WAV is finalized, uploaded and acknowledged.
An accepted background task ends THINK immediately. Home shows a compact
receipt/answer card; Enter opens chat and Escape closes the card. Voice started
in chat returns its receipt and answer inline. The Home update indicator,
compact battery, Realtime and NES behavior are preserved.

The observed upload failure was a post-TLS allocation of a contiguous 16 KiB
staging buffer when the largest available block was 16,372 bytes. Both RAM and
SD uploads now share a reserved 4 KiB workspace with a scoped ownership guard.
Body staging needs no heap allocation after TLS connects. Audio stays in its
original mono PCM16 16 kHz WAV on SD, with no conversion or second recording.
Failed delivery retains the recording and shows a warning instead of acceptance.
Malformed and empty replies also leave THINK through an explicit result state.

CI now executes the actual body writers against fragmented-heap, partial-read,
partial-write, stalled-socket, disconnect, Wi-Fi-loss and short-file scenarios.
The observed 749,612-byte WAV is covered byte for byte. Actual render dispatch
and receipt handlers cover REC/THINK transitions, Home/chat behavior, accepted
tasks, final replies, malformed/empty replies and HTTP errors. Existing keyboard,
clock, Home update/battery, Realtime, release and security checks remain enabled.

Host tests cannot establish device, radio or server acceptance. For a device
check, flash the exact committed image, observe one ordinary G0 recording and
match its turn ID to the bridge receipt and final inbox reply. Keep the original
WAV and never automatically retry an uncertain delivery. The serial-only
`voice.note.latest` command inspects the newest saved recording without sending
it; an intentional `voice.smoke.live` submits that original WAV through the
ordinary receipt handler. It does not copy, convert or remove the recording.
