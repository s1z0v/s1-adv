# 0.2.206-dev — Snake

**Tab → Games → Snake** adds a classic, silent, fully offline Snake game.
The existing eight Games entries retain their positions, including Pocket
Synth; Snake is entry nine, reached by scrolling the existing eight-row menu.
The seven top-level groups and their shortcuts do not change.

## Play

- **Enter** or **Space** starts a ready game. Use **WASD** or **arrow keys**
  (the normal ADV Fn-arrow combinations also work) to steer.
- **P**, **Space** or **Enter** pauses/resumes; **N** resets to a ready board.
  Enter/Space/P after game-over starts a fresh game.
- Eat amber food to grow and increase the score by one. Mint marks the head.
  Walls and the snake's own body end the run; there is no edge wrapping.
- Only one direction change is accepted per tick; immediate reversal into
  the neck is rejected. Entering a cell vacated by the tail is legal when
  not eating. Filling all **336 cells** wins (maximum score **332**).
- The **28×12** board fits the 240×135 display, with score and best above.
  Speed starts at **220 ms/step** and increases every three foods, to a
  minimum **85 ms/step**. Best is **RAM/session-only**, retained between new
  games but not across reboot; no new persistent preference or SD file.
- **Tab** opens the normal menu; **Esc** exits. Menu/voice/OTA/playback,
  other blocking owners and leaving the app pause the run. It never resumes
  automatically; return and press Enter/Space/P. Unexpected service gaps
  longer than 700 ms pause rather than fast-forwarding into a collision.

During play the display-idle clock is kept awake without fabricating real-key
or network-quiet timestamps. When paused/ready/game-over, ordinary idle/screen
sleep still applies. Background polling is suppressed in this offline app,
like the existing board games. Voice/global shortcuts remain available.

## Resources and preservation

The fixed-size game state is under **720 bytes**. There are no heap allocations
in the rules, new tasks, samples, SD writes, audio effects or network calls.
Existing Chess Mind, Pocket Synth/ADV audio fix, private VLC Remote, games,
provisioning, master volume, TLS/auth, partitions and bootloader are unchanged.
`ui.open` accepts mode `snake` through the existing action type; no new action
or automatic installation is introduced.

## Verification

New ASan/UBSan checks execute production rules, controller and renderer:
**52,421 moves** against an independent list/coordinate oracle, 1,000 seeds,
wall/self collisions, vacating-tail semantics, growth/food exclusivity,
full-board victory, speed/score/session-best, pause and uint32 timing wrap.
Actual app tests verify all input/owner guards, no auto-resume, screen bounds
including a full board, and the real launcher renderer for **all nine** Games
selections (including Snake scrolled into view). All **64 standalone host scripts passed** (external user-ROM harness excluded),
plus the device UI-feature and release-delivery smokes.

Host tests, build and authenticated OTA verification do not prove physical
installation or the owner's acceptance of the keyboard/display behavior;
those remain separate after the update is installed on the device.
