# Everyday controls

- Type a question and press Enter in chat.
- Hold **G0**, speak, then release to send. **Ctrl+V** or double **Ctrl** toggles recording.
- **Tab** opens the app menu from Home and the chat/eyes screens; arrows select, Enter opens.
- **Ctrl+K** opens assistant commands. R selects Realtime, C AI Chat, E Chat Eyes, F Big Eyes.
- **Ctrl+R** starts Realtime or commits the current speech turn. While awaiting a reply, it stops Realtime.
- **Esc** closes an overlay, or ends Realtime and returns Home.
- **Ctrl+Left / Ctrl+Right** or **Ctrl+, / Ctrl+.** selects the previous/next animal.
- On **Big Eyes, Chat Eyes and Realtime**, **[ / ]** also selects the previous/next animal, including while the mic is listening. In Full Chat, plain brackets remain text.
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
A pending agent request remains visible. Its later reply appears in a notification
sheet above Home: Enter opens AI Chat and Escape closes the sheet.
The clock screen shows READY with its decorative animated bars when the
microphone is off. REC and the live input meter appear after recording starts.
A small striped battery gauge and percentage sit below READY; amber and red
indicate low charge. Unknown telemetry displays --%.

The interface and default assistant replies are English, including replies to
Russian input. Explicit requests such as "Reply in Russian" are respected.
Russian keyboard input and Cyrillic rendering remain available. See [NES games](NES.md) for SD game installation.

Realtime uses full-screen eyes with compact phase and microphone badges.
Hands-free listening resumes after each spoken reply. Ctrl+R starts or stops
Realtime; Esc ends the session, Tab opens apps and Ctrl+K opens commands.
