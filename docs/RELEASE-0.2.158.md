# 0.2.158-dev

Extends the voice-mode TLS fix to Inbox polling, speech replies and voice
preconnections. The memory gate checks contiguous free space as well as total
free SRAM. A fragmented heap can otherwise report 100 KB free and still fail a
TLS allocation after leaving Realtime. Workers borrow the display sprite only
when needed and return it on completion, cancellation or task creation failure.

Includes the compact striped battery below Home READY and working **[ / ]**
animal shortcuts from 0.2.156–157. The clock, rings and decorative waveform keep
their positions. Verified TLS, recording to SD and Realtime audio remain enabled.
NES is unchanged and experimental.
