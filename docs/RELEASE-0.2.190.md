# 0.2.190-dev Realtime reply memory

`Not enough memory for reply audio` is a RAM allocation failure in the Realtime
PCM buffer, rather than a storage-capacity error. A previous serial trace of
this unchanged path showed 35228 free bytes but a largest free block of 13300
bytes, followed by failure to allocate one contiguous 16384-byte reply ring.

The ring now uses eight independent 2048-byte blocks with the same total PCM
capacity, playback buffering and backpressure. Blocks exist only during the
reply and are all freed before microphone capture resumes. Failure to allocate
any block releases every block already allocated. The screen buffer stays
allocated, and no recordings or SD files are deleted for this RAM failure.

The production-function test now models the recorded allocation-size ceiling,
verifies byte-exact output across block boundaries and wraparound, rejects each
possible partial allocation, and repeats constrained-heap allocation/reset 25
times. Existing cancellation, stalled playback and microphone ownership tests
remain. CI runs this test with address and undefined-behavior sanitizers.

Offline checks and successful publication are separate from device acceptance.
Record the installed version/source and repeated physical Realtime replies
before marking this release as the stable baseline. The chat-composer chevron from 0.2.189 is preserved. Pulse rings and Thinking
geometry return to the owner-preferred 0.2.188 outline design.
