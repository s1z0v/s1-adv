# 0.2.155-dev

Realtime hands-free listening now restarts after the speaker finishes its reply.
The drained-playback path runs every loop; it previously moved the restart
clock forward every time, so the microphone never reached its deadline.
Restart is now scheduled once, respects the speaker drain and remains safe
across the millisecond counter wrap. A host regression runs three consecutive
reply/listen cycles through the actual firmware functions.

The Realtime socket drains up to eight frames or a 4 ms budget per display
loop. This keeps PCM and text frames from accumulating ahead of heartbeat
pong. Per-text-frame SD logging is removed; terminal, error and timing logs
remain. This preserves the existing provider, audio pacing and fast reply path.

The full eye renderer remains visible across the screen. Small floating
badges show PREPARE, LISTEN, THINK, SPEAK or ERROR, plus MIC ON/OFF. The input
meter is driven only by the enabled microphone. Permanent full-width header,
transcript and footer bands have been removed. Errors retain a compact detail.

The experimental NES implementation is unchanged from 0.2.154.
