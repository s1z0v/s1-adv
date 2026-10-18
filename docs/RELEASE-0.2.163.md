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

For native diagnostics, `voice.notice.test.clock <text>` displays that text on
Clock and exercises the ordinary reply-speech worker. It sends no user turn to
the agent. A live G0 recording still requires a separate device/bridge check.
