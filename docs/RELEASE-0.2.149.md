# 0.2.149-dev

Tab opens the app menu again from Home, Chat Eyes, Full Chat and Big Eyes.
Ctrl+K opens assistant commands. Both menus remain reachable during Realtime
recording. Esc closes an overlay or ends Realtime and returns Home.

Realtime uses the large animal eyes with explicit CONNECT, LISTEN, THINK, SPEAK,
READY and ERROR states. The microphone label and input meter reflect recording;
the last transcript/reply and persistent error reason use a separate status line.
A pending Realtime start prevents a new background inbox request from overtaking it.
TLS connection and upgrade request writes run in a worker; header reads remain
incremental on the UI task. The HTTPS Host header omits the default port, fixing
ingress 503 responses. Escape, Ctrl+V and menus also remain available during
ordinary microphone recording.

OTA accepts a strictly newer numeric version. A stale manifest cannot downgrade
a USB-flashed build. A clean updater that skips or fails an update now starts
the normal keyboard and apps instead of leaving a partial updater session.

The on-device topic browser, topic creation, switching, keyboard shortcuts,
saved selection and topic actions have been removed. One configured conversation
still uses the bridge protocol's routing key. Existing bridge history endpoints
remain available for compatibility.

The six shared animal skins, asynchronous text/inbox requests and bundled NES
HonkeyPong from 0.2.148 remain available.

Validation includes actual firmware navigation functions compiled on the host,
launcher/microphone wiring, Realtime state/transport regression checks and the
ESP32-S3 8 MB PlatformIO build. Hardware acceptance is recorded separately by
the operator; a build or server response alone does not establish it.
