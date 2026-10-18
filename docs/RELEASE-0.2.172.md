# 0.2.172-dev

Opening Firmware or leaving an accepted-request notice on screen used to reset
the same idle clock that scheduled background HTTP. An idle, connected device
could consequently stop discovering releases and receiving build progress.
Network quiet time now follows actual user activity. A retained failed message
ACK or an unfinished draft also cannot postpone release discovery indefinitely.

Background HTTP keeps the screen framebuffer allocated. TLS and HTTP stay in
the shared worker, with a bounded connection/handshake/read budget. Pressing U
in Logs queues one upload behind ongoing work; success is shown only after a
successful server response. Firmware F checks use the same worker. Firmware
capacity drawing verifies the running image once per boot instead of per frame.

Home uses one badge for build, release and unread-message status. BUILDING is a
single orange line. A stale build status keeps CHECK LINK with a working F retry
hint; Firmware explains that Wi-Fi should be checked. NEW MESSAGE replaces the
separate top envelope. Automatic accepted/reply sheets no longer cover Home or
menus; chat history, error feedback and voice capture remain available. Active
Pomodoro and break status retain their priority. UI warning/focus yellow uses
the warm orange accent, while the clock remains white.

Pomodoro explicitly powers the linked lamp on before selecting the focus or
break preset, including when the desired preset is already selected. Two
idempotent ON packets respect GL2's command-rate limit. Manual overrides still
suspend automation; ending a phase cancels pending power-on commands.

Host regression checks and an ESP32-S3, 8 MB build validate the source. Physical
screen, HTTPS memory headroom, log upload and release-discovery acceptance must
be checked on this build before treating it as hardware-verified.
