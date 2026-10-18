# NES games on SD

The firmware contains a Nofrendo-based emulator, not commercial game ROMs.
NES support is experimental. Some games run below full speed on the tested
device, especially when cartridge banks must be streamed from SD.
Put your own `.nes` files in `/nes` on the SD card, then open **NES** from the
app menu. Choose a file with W/S or arrows and press Enter.

Controls: WASD/arrows move, Z is A, X is B, Enter is Start, Space is Select.
Enter is Start and never exits a running game. Escape returns to the game list;
Escape again returns Home. F switches between classic 4:3 (180×135) and
full-width (240×135) display without restarting the game.

On macOS/Linux, files can also be copied over USB without removing the card:

```sh
python3 scripts/install_nes_roms.py --port /dev/cu.usbmodem101 /path/to/game.nes
```

A failed SD read pauses the game with an error message until Escape is pressed.

The installer verifies SHA-256 on the device before committing each file.
Different existing files are preserved with a `.previous.<timestamp>` suffix.
It never formats the card. A card reader works on every platform.

The included, independently licensed HonkeyPong sample can be installed from
`third_party/honkeypong/bin/HonkeyPong.nes`. It is not embedded in the firmware.

Supported cartridges use mapper 0 (NROM) or mapper 4 (MMC3), up to 512 KiB PRG
and 256 KiB CHR. Simple NES 2.0 headers without extended bank counts or a
submapper are supported. Trainer, battery-backed, four-screen and other mapper
formats are rejected. This is not a claim that every NES title is compatible.

Cardputer ADV has limited RAM and no PSRAM in the tested device. ROMs stay on
SD; an adaptive PRG bank cache and CHR window avoid loading a whole cartridge.
The PPU executes every scanline and captures a 256×120 viewport at the full horizontal resolution. Chat, voice,
network polling and Realtime pause during gameplay. Exiting frees emulator
allocations and restores the assistant and Wi-Fi. Firmware/OTA partitions are
unchanged, and adding games to SD does not increase the OTA image size.

Only install files you are entitled to use. Super Mario and Felix the Cat ROMs
are not open-licensed and are not included in this project. Do not put them in
the public source tree or a public release. See [Nintendo's IP FAQ](https://en-americas-support.nintendo.com/app/answers/detail/a_id/55888/~/intellectual-property-%26-piracy-faq)
and [Konami's Felix the Cat notice](https://www.konami.com/games/us/en/products/felixthecat/).
