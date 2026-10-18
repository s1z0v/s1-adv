# 0.2.161-dev

The Home clock replaces READY with a persistent orange NEW UPDATE / Ctrl+U
badge when a complete newer firmware candidate is available. Its two lines
share the same center and height as READY; ten extra horizontal pixels keep
the text inside the rounded frame. Clock, rings, decorative bars and the
compact five-stroke battery keep their positions.

Ctrl+U on Home or Clock queues the existing OTA installation path. The screen
paints before checking the latest manifest, and the existing power, trusted URL,
size, SHA and boot/rollback checks remain in force. If no newer candidate is
known, Ctrl+U only checks and leaves the user on the same screen. Ordinary U,
chat input, open menus and busy voice/OTA operations do not trigger installation.

Bridge update checks refresh the status without switching away from the current
screen. A configured boot check also uses that queue after startup. Notifications
and their sound may expire; the Home badge remains until the candidate is no
longer newer than the installed firmware. No candidate binary is installed by
merely showing the badge.
