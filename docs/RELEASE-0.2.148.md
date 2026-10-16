# 0.2.148-dev

One combined release after 0.2.147-dev: NES, responsive chat and shared eye skins.

## Assistant controls

| Key | Action |
| --- | --- |
| Tab | Open/close commands in Home, Chat Eyes, Full Chat or Big Eyes |
| Up/Down, Enter | Select and run a command |
| Esc | Close commands; otherwise exit to Home |
| Ctrl+R | Realtime with large eyes; existing voice turn controls apply |
| Ctrl+C | Full Chat |
| Ctrl+E | Chat Eyes |
| Ctrl+F | Big Eyes |
| Ctrl+Left / Ctrl+Right | Previous / next animal skin |
| Ctrl+, / Ctrl+. | Same skin controls without arrow keys |
| Ctrl+L | Full app launcher |

When commands are open, `R C E F [ ]` select the matching action directly.
Ordinary typing in chat is preserved. Chat Eyes uses the same six procedural
skins and blink/gaze/emotions as Big Eyes, rendered smaller above the reply.

Typing a message on Home and pressing Enter immediately opens Full Chat with
the outgoing message and pending indicator. Text HTTP requests keep the canvas
alive. Automatic Inbox GET/ACK and reconnect waits no longer block loopTask.
The HTTP workers return before task deletion so C++ TLS/request allocations
are released. TLS verification and existing audio/OTA guards remain enabled.

## NES

Open **Ctrl+L → Games → NES**. HonkeyPong is already installed in flash;
no SD card or download is required. Its opening jingle/title card lasts about
four seconds before the Start screen.

- Enter: Start. Space: Select. Z/X: A/B.
- W/S or arrows: move; A/D and I/J/K/L also map to the NES directional pad.
- Esc (backtick on the built-in keyboard): exit to Home.

This initial emulator supports NROM mapper 0 and the bundled MIT homebrew,
not every NES cartridge. It runs offline, suspends Wi-Fi while playing and
reconnects after exit. Its framebuffer replaces the UI canvas only while the
game owns the screen. Failed allocation returns to the normal interface.

Source/license details: [Nofrendo](../bots/CardputerADV/lib/s1_nes/README.md),
[HonkeyPong](../third_party/honkeypong/S1-ADV.md), [Credits](../CREDITS.md).

## Validation and installation

```sh
python3 scripts/test_assistant_ui.py
python3 scripts/test_nes.py
python3 bots/CardputerADV/scripts/ui_feature_smoke.py
python3 bots/CardputerADV/scripts/release_delivery_smoke.py
node bots/CardputerADV/tests/render_eye_skins.mjs
python3 scripts/cardputer.py build
```

The host NES test includes title → game transition, paddle input, 12 repeated
open/play/close cycles and 25 allocation-failure positions under ASan/UBSan.
The eye test checks 15,360 geometry cases and renders both full and compact skins.
Navigation tests exercise the actual submit/view functions while network work
is pending. These checks do not measure physical keyboard, Wi-Fi or audio timing.

Follow [flashing](FLASHING.md) for USB. For OTA, your own bridge must publish
the provisioned app image under version `0.2.148-dev`; verify downloaded size
and SHA256 before applying. A published manifest alone does not establish that
the physical device has booted the new version.
