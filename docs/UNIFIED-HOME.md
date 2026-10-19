# Unified Home recording and update controls

Recording, sending and waiting use the existing Home orbit and clock panel.
Holding G0 turns the recording orbit/meter red and replaces the clock with
elapsed recording time. The chat input and battery are hidden during capture;
an existing draft is retained. Releasing G0 restores the clock, battery and
the compact Home badge, with actual transport status in the chat-hint area.
The separate full-screen THINK card is removed. Accepted background work and
its final replies retain the existing contextual task/inbox behavior.

Pending replies with the explicit `front_reply_is_agent: true` Bridge field are
real semantic first replies and may queue speech. G0 uses the existing voice
reply policy; text follows the current text-speech setting. A generic pending
transport receipt remains silent. Either case continues waiting for the main
agent and retains the stored reply sequence for inbox deduplication.
Inbox messages with an explicit JSON boolean `source.actions_allowed: false`
are displayed/acknowledged normally but never reach the inline device-action
parser. This applies to both pending-event batches and single-item envelopes.
Primary-agent messages without that field retain supported device actions.

Enter on an unread badge opens the locally stored conversation from every
assistant view, including Clock (which shares the Home renderer). It jumps to
the latest message, preserves the composer draft and pending agent/TTS state,
and never fetches history or starts audio as part of opening. An in-flight
voice wait can be left for chat; actual capture/preparation keeps its input
ownership. Existing explicit playback from an already-read chat is unchanged.

PTT preparation shows `Loading voice...` (compact badge: `LOADING`) only while
an existing network operation drains or microphone/storage startup runs. The
red `RECORDING` scene starts only after microphone initialization and acceptance
of its first audio buffer. Failed microphone/queue startup shows an error and
never advertises successful capture; its empty temporary WAV is cleaned up.

The firmware screen has one primary action, Enter / Install update. Enter
queues one fresh authenticated manifest check and installs only its successful
new-candidate result through the existing power/hash/boot gates. The normal
Escape navigation remains. Manual fetch/reload/confirm/rollback letter actions
are removed from that screen; explicit serial recovery remains available.

While the firmware screen is open, the shared HTTP worker checks every five
seconds. Other screens retain twenty seconds. Recording, playback, transfers,
Realtime and an active install defer checks; a due check remains due. A failed
request retains the existing retry backoff. Enter does not install the current
version or a pending-unverified app. Boot verification remains automatic.

Executable host checks compile the actual renderers, OTA scheduler and Enter
handler. A standalone 240x135 preview is kept in this task's output folder.
The patch itself does not publish, flash, change model routing, touch private
provisioning or alter an OTA partition.
