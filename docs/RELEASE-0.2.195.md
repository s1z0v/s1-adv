# 0.2.195-dev — offline Checkers

Adds **Games → Checkers**, an 8×8 English/American-style checkers demo against
an easy computer. The human plays Red and moves first; the CPU plays Black.
No accounts, online service, SD assets or file writes are needed.

## Controls and rules

- WASD, arrows or the `;`/`.`/`,`/`/` cluster move the cursor.
- Enter selects a movable Red piece, then plays to a highlighted destination.
  Select another legal Red piece to change selection. Del cancels selection.
- Captures are compulsory. After a capture, the same piece must finish any
  remaining jumps; the selection stays locked and Del cannot bypass the chain.
- Men move/capture forwards only. Kings are short-range and move/capture in
  either diagonal direction. Reaching the far rank crowns the piece (marked K)
  and ends that turn, even if the new king could jump again.
- Either capture path is permitted; there is no longest-capture requirement.
- A player with no legal moves loses, including when their last piece is taken.
- N starts a new game; Escape returns Home; Tab opens the launcher. The CPU
  pauses off-screen/in the launcher; the current game resumes in RAM when
  reopened. Rebooting starts over.

Intentional demo limits: easy one-ply CPU, no save, takeback, clock, multiplayer,
flying kings, backwards man captures or repetition/no-progress draw handling.
This is not Russian or international draughts.

## Isolation and verification

Uses fixed-size state below 1 KiB in the host fixture. CPU evaluation processes
at most four legal candidates per UI loop; multi-jump legs have separate slices.
Voice/assistant/audio work pauses evaluation. Background polling is suppressed
inside this offline app, as for Chess. Normal navigation, voice and OTA remain
unchanged outside it.

`scripts/test_checkers_demo.py` compiles the actual header, input handler, CPU
service and renderer with AddressSanitizer/UndefinedBehaviorSanitizer. It checks
opening perft 7 / 49 / 302 / 1469; an independent exhaustive legal-move oracle;
mandatory captures, branch choices, chains, both colors' crowning, kings,
blocked/last-piece wins, illegal input, cancellation/reset, paused/sliced CPU,
UI bounds across every cursor/state, and 40 deterministic legal games.

All 43 standalone host test scripts passed before release, including Chess,
launcher, OTA, audio/voice, storage and bundled NES regressions. The separate
user-ROM harness `test_nes_rom.py` requires an external ROM and was excluded.

Physical keypad, display readability, CPU latency and installation acceptance
remain on-device checks. Publication does not authorize automatic installation.
Retains all 0.2.194 features, including Chess, guarded SD deletion, thin Pulse,
white idle clock, segmented Realtime PCM and existing Pomodoro lamp settings.
