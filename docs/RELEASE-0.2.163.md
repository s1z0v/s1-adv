# 0.2.163-dev

Voice receipts and replies now appear on Clock as well as Home. Clock renders
the same assistant graphics, but had been excluded from the notification/input
guard. Enter opens the conversation from its notification; Escape dismisses it.

The notification is readable in its first frame. Previously, the slide animation
started almost entirely above the display; reply speech could borrow the canvas
for TLS before a visible animation frame was painted. Feedback now paints before
the acknowledgment tone and before reply speech begins its network work. The
speech worker waits for canvas recovery and for the notification tone to finish,
and unread cards prevent the screensaver
from hiding them. A new answer also wakes a dimmed or sleeping display.

Regression tests compile the actual notification renderer, including its display
guard and first-frame bounds. They cover Home, Clock, inline chat, waking the
display, long replies, unread-card retention and painting before the tone. The
earlier voice transport, storage, Realtime and Home update/battery checks remain.
REC, THINK, eyes, battery and update artwork are unchanged.

Temporary reply speech prefers the existing internal LittleFS space, with a
capacity check and a 64 KiB reserve. Playback and cleanup use that same filesystem.
This avoids the intermittent SD write failure observed during a repeated native
speech check. Original microphone recordings remain on SD. Reply downloads use
bounded writes and must match the expected even PCM byte count before playback.
Replies larger than the available scratch space use the SD path with bounded
writes; a failed download leaves the visible text available.

For native diagnostics, `voice.notice.test.clock <text>` displays that text on
Clock and exercises the ordinary reply-speech worker. It sends no user turn to
the agent. A live G0 recording still requires a separate device/bridge check.
