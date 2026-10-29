# 0.2.203-dev — Chess Mind screensaver

New **Chess Mind** idle style in **Settings → Display → Screensaver style**,
plus an immediate optional preview under **Focus → Chess Mind**.
C-Matrix and Big Eyes keep their existing indices and behavior. The new style
is opt-in; no existing screensaver, brightness or sleep preference is changed.

## Mental prompts and presentation

A small white-bottom board, always-visible local 12/24-hour clock and a quiet,
sparse Matrix-like background use the existing cyan/violet/amber palette.
Questions alternate between:

- naming a highlighted square, with coordinate labels hidden until the answer;
- recalling the colour of a named square;
- testing one-move empty-board geometry for knight/bishop/rook/queen/king;
- choosing the one possible knight origin from three distinct options;
- finding a White mate in one in four hand-composed, independently checked
  positions. One valid solution is displayed; uniqueness is not claimed.

Each question stays for 24 seconds, then its answer/hint is shown for 8 seconds.
All 64 squares cycle without duplication within the coordinate drill. Preview
Space reveals/advances; Enter/N gives the next question. In automatic saver
mode the existing first-key wake path remains unchanged. Dim/off, previous-app
or Clock-on-wake, voice/OTA guards and the retained-frame policy are preserved.

The trainer is entirely offline, allocation-free in its core, without audio,
SD writes, HTTP, engine searches, external puzzle services, scores or alerts.
No partitions, bootloader, TLS/auth, device/Wi-Fi provisioning or existing VLC
private defaults are changed. Legacy saved style 0/1 remains C-Matrix/Big Eyes.

## Verification

New ASan/UBSan host checks execute 100,000 generated prompts, every square,
all empty-board attack pairs, reverse-choice uniqueness, timer wrap/phase
transitions, actual renderer bounds and actual idle/wake/dim/off functions.
Pinned test-only `chess==1.11.2` independently verifies every displayed mating
move (legal move plus actual checkmate) and every empty-board attack square.
No Python/chess dependency is embedded in the device firmware.

All **60 standalone host scripts passed**, including existing application, voice,
OTA, VLC, radio, lamp, Mesh, SD and game checks; the external user-ROM harness
is excluded.
Source tests/build/publication and physical installation/legibility/wake
acceptance remain separate evidence; physical acceptance is not claimed.

Russian usage: [CHESS-MIND.md](CHESS-MIND.md).
