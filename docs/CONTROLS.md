# Everyday controls

- Type a question and press Enter in chat.
- Use the device talk control for push-to-talk: hold, speak, release.
- **Tab** opens the app menu from Home and the chat/eyes screens; arrows select, Enter opens.
- **Ctrl+K** opens assistant commands. R selects Realtime, C AI Chat, E Chat Eyes, F Big Eyes.
- **Ctrl+R** starts Realtime or commits the current speech turn. While awaiting a reply, it stops Realtime.
- **Esc** closes an overlay, or ends Realtime and returns Home.
- **Ctrl+Left / Ctrl+Right** or **Ctrl+, / Ctrl+.** selects the previous/next animal.
- **Ctrl+L** also opens the app menu. `/help` shows command help.
- `/status` shows connection and device information.
- `/setup` or `/wifi` opens the Wi-Fi and bridge setup portal.
- `/settings` opens device settings; `/ota` opens firmware update review.
- `/calc`, `/alarm`, `/stopwatch`, `/assets` and `/library` open local tools.

This firmware has evolved across development versions. Prefer the command help
on your built device for current shortcuts. Specialized IR, RFID and sonar
tools require compatible extra hardware; see the retained target documentation.
Voice quality and response time depend on your bridge's STT/TTS configuration
and the agent, network and provider latency.

Realtime shows CONNECT, LISTEN, THINK, SPEAK, READY or ERROR above the large eyes.
MIC ON and the input meter appear only during recording. Connection errors remain
visible until retry or exit. The firmware uses one configured conversation;
there is no topic browser or topic creation/switching.

Device Settings → Clock format switches between 12h AM/PM (default) and 24h.
Voice upload shows its percentage, then transcription and an accepted receipt.
A pending agent request remains visible in AI Chat; its later reply opens the chat with a notification.
