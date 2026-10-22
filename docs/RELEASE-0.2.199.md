# 0.2.199-dev — classic Minesweeper

Adds **Games → Minesweeper**, an original offline implementation of the classic
Windows-style beginner game: **9×9 squares and ten mines**, numbered clues,
raised gray tiles, flags, mine counter, timer, win and loss states. No Windows
code/assets, online service, SD assets or storage writes are used.

## Controls

- WASD or arrows move the cursor; `;` up, `.` down, `,` left and `/` right also work.
- Enter/Space reveals a square. The first reveal and its surrounding squares
  are safe. Empty areas expand automatically; flags are never opened by flood.
- F or Del toggles a flag. Revealed squares cannot be flagged; flags can be
  placed before the first reveal. The counter is ten minus the number of flags
  and may go negative when over-flagging, like the classic game.
- Enter on an open numbered square reveals its unflagged neighbors when the
  neighboring flag count matches that clue (chording). Incorrect flags can
  cause a loss; matching the count does not prove the flags are right.
- N starts a freshly randomized board. Escape returns Home; Tab opens the normal
  launcher. Reopening preserves this game's RAM state, but rebooting resets it.
- Clear all 71 safe squares to win; remaining mines are then flagged. Hitting a
  mine ends play, reveals mines and marks incorrect flags. Cursor/new-game/menu
  controls remain available after a win/loss.

The timer starts on the first reveal, keeps elapsed time while another screen
is open, freezes on a win/loss and displays at most 999 seconds. No difficulty
selector, saved game or online leaderboard is included in this first version.

## Verification and isolation

The rules use fixed state below 512 bytes in the host fixture, bounded partial
shuffle placement and a non-recursive flood queue of 81 squares. UI rendering
stays within the 240×135 screen; time changes invalidate direct-render frames.
Background polling is suspended in the game, consistent with other offline
board games. Global voice, navigation and OTA paths are preserved.

`scripts/test_minesweeper.py` compiles the actual rules, input handlers, timer
service and renderer with AddressSanitizer and UndefinedBehaviorSanitizer:
8,100 first-reveal cases, exact mine placement, independent neighbor-count/flood
oracles, flag/chord/win/loss behavior, timer wrap/cap, all cursors/numbers/UI
states and 300 randomized action traces.

All 49 standalone host test scripts passed before release, including Mesh,
shared-SPI SD, voice/audio, navigation and existing games. The external-ROM
harness was excluded because it requires a user-supplied ROM. Two braces-only
fixes in the Mesh lifecycle host fixture keep its existing assertions compiling
under GCC's `-Werror`; production Mesh behavior is unchanged.

On-device readability, keypad feel and installation/physical acceptance remain
separate checks. The release retains Chess, Checkers, Cap-1262 shared-SPI/SD fixes,
Mesh and its Realtime resource guards, plus the rest of 0.2.198. It does not
start the radio, change regional settings, erase storage or install itself.
