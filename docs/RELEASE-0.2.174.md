# 0.2.174-dev

A successful Bridge poll with an uncertain firmware request previously showed
CHECK LINK / F retry indefinitely. The transport was healthy; the request had
no confirmed delivery receipt, which another status check could not resolve.

Home now shows UNCONFIRMED for that request, and NO PROGRESS for an old build
whose server progress has stopped. CHECK LINK / F retry appears when the device
has an actual failed transport attempt (or offline Wi-Fi) and no successful
Bridge response for more than 90 seconds. Deliberate voice/Realtime polling
pauses and input-cancelled checks do not fabricate a link failure. The firmware
screen gives a matching explanation. The update and Pomodoro priorities remain
unchanged. Polling and F do not resend a firmware request or clear its history.

Host coverage executes the actual server-state mapping, badge renderer and F
shortcut, including a fresh poll of an old uncertain request, the 90-second
boundary and reconnection. Physical acceptance is recorded separately.
