# 0.2.196-dev: SD initialization with a LoRa Cap

Before mounting or remounting the SD card, deselect the external SPI slave on
G5 and the SD card on G12. Preload both output latches high before enabling
their outputs, then initialize the existing SPI bus and mount at 4 MHz.

The [M5Stack Cap LoRa-1262](https://docs.m5stack.com/en/cap/Cap_LoRa-1262)
uses SX1262 NSS on G5. The SD card and Cap share SCK G40, MOSI G14 and MISO G39,
as documented in the [Cardputer Mesh Kit pin table](https://docs.m5stack.com/en/core/Cardputer_Mesh_Kit).
Previously only the SD library's chip select was initialized. An attached
external slave left selected can contend on MISO while SD initializes.

This is an SD compatibility fix. It does not implement Meshtastic, scan for
nodes, or transmit radio packets. Cap reset, IRQ, BUSY, GNSS and antenna-switch
pins remain untouched. Existing RC522 support uses the same external chip
select and also benefits from deselection before SD access.

No filesystem formatting, file deletion, partition change or SD clock change
is introduced. All 0.2.195 features, including Chess, Checkers, voice, OTA,
Pomodoro and the existing home screen, are retained. OTA can already stream
directly to the inactive internal-flash app partition when SD is unavailable.

## Verification

`scripts/test_sd_shared_spi.py` compiles the actual production mount helper
and checks 32 combinations of Cap presence, initial chip-select levels,
mount success/failure and card detection. It verifies latch preload, pin and
clock mappings, absence of writes to other Cap pins, CARD_NONE cleanup and
that boot/remount share the helper. The literal previous mount sequence and
a missing-deselection mutation reproduce the selected-Cap failure condition.

Host simulation verifies the initialization sequence. SD detection, audio
access and repeated boots with the owner's physical Cap attached still need
on-device acceptance; no connected USB device was available during preparation.
