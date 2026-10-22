# 0.2.193-dev — offline Chess demo

Adds **Games → Chess**, a deliberately small demonstrative game, with the human
playing White against a basic one-ply computer opponent. No account, connection,
SD assets or external chess service is required.

## Controls

- **W/A/S/D**, the device's arrow keys, or **; / , .** move the board cursor.
  In the punctuation cluster: `;` up, `.` down, `,` left, `/` right.
- **Enter** selects a White piece, then plays to the chosen destination.
  Selecting another White piece changes the selection; Enter on the same piece
  cancels it. Legal destinations are marked on the board.
- **Del** cancels the current piece selection (not a move takeback).
- **N** starts a fresh game. **Escape** returns Home. **Tab** opens the normal
  launcher. Leaving/opening the launcher pauses the CPU; the in-memory game
  resumes when revisited. A reboot starts a new game.
- White/black chips display P/N/B/R/Q/K. The right panel shows the turn, cursor,
  selected square, last move, check, checkmate or stalemate.

## Intentional demo scope

Includes king-safe legal moves, castling, en passant, and automatic promotion to
Queen. There is no promotion choice, save game, clock, online play, takeback,
threefold-repetition, 50-move or insufficient-material draw adjudication.
The computer is intentionally easy, not a competitive analysis engine.

The engine uses fixed storage (game state below 1 KiB in the host test), without
recursive search or heap workspace. CPU evaluation is split into at most four
candidates per UI loop and pauses during recording/playback/assistant work.
Background polling is suppressed in Chess, as for other timing-sensitive apps;
normal manual voice/OTA/navigation remain outside the game and unchanged.

## Verification

`scripts/test_chess_demo.py` executes the actual rules/header and app handlers /
renderer with AddressSanitizer and UndefinedBehaviorSanitizer. Reference perft
counts: initial position depths 1–4 = 20 / 400 / 8902 / 197281; Kiwipete depths
1–3 = 48 / 2039 / 97862. Covers castling rights and transit check, en-passant
king exposure, queen promotion, pinned pieces, forbidden king capture, mate,
stalemate, input/selection/reset, paused and sliced CPU, legal self-play, and
bounded non-overlapping UI text over every cursor and representative states.

All 42 standalone `scripts/test_*.py` host tests passed before release. The
separate `test_nes_rom.py` harness needs a user-supplied ROM and was not run;
the bundled NES sanitizer regression did pass. Existing fixture/compiler
warnings remain unrelated to Chess.

Physical screen readability, keypad feel, CPU latency on the actual ESP32 and
installed-version acceptance still require an on-device check after installation.
Retains 0.2.192's thin Pulse rings, white idle clock, centered chat chevron,
segmented Realtime PCM and guarded SD file manager. No automatic file cleanup,
partition/provisioning changes or automatic installation.
