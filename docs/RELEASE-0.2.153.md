# 0.2.153-dev

NES opens a game library on SD instead of trying to allocate a complete ROM
and framebuffer in limited internal RAM. The Nofrendo core supports mapper 0
and mapper 4, with a bounded bank cache, an 8 KiB CHR window and a 128×120
viewport. All games, including the licensed sample, stay in `/nes` on SD.
No commercial ROM is distributed or embedded. See [NES setup](NES.md).

The USB installer verifies the file SHA-256 on the device and preserves a
different existing file before replacement. Game mode suspends networking
and voice; leaving it releases the emulator and restores the assistant.
The flash partition layout and OTA slots are unchanged.

Agent replies now default to English, including for Russian input. Another
response language is used only when explicitly requested. Russian keyboard
input, Cyrillic display fonts and requested translations remain available.
New installations use English system audio.

Silent inbox polling retains the speaker amplifier state. It no longer
switches the speaker off and on every poll, which caused periodic idle
clicks. The clock keeps READY and its original animated bars.

Host checks exercise the actual core through repeated enter/play/exit,
80 allocation failures, synthetic MMC3 bank switching and SD read failure.
The user-ROM test accepts a local file without adding it to the repository.
