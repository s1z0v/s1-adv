# 0.2.173-dev

Pausing Pomodoro selects the configured break lamp effect. The lamp keeps that
effect when the user leaves the timer for Home or a menu. Resuming returns to
the focus effect. Pause retains the existing automation lease, so Stop/Reset
can still restore the preset that was active before the session. A manual lamp
adjustment continues to take priority over automation.

The framebuffer now stays allocated through speech and voice TLS as well as
background polling. On 0.2.172 an automatic speech download still released it;
direct drawing briefly exposed gray partial frames and reallocating the canvas
fragmented the heap enough for subsequent HTTPS setup to fail. NES retains its
separate renderer handoff. Native voice/TLS acceptance is required for this
broader memory change.

Uncertain/stalled firmware requests display CHECK LINK instead of falling back
to READY when their acknowledgement has been read. BUILDING continues to mean
confirmed server work. The previously switched-off lamp powering on at focus
start was confirmed on 0.2.172.
