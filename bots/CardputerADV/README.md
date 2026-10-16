# S1-ADV for Cardputer ADV

For this fork's current OpenClaw installation, follow the
[project README](../../README.md), [USB guide](../../docs/FLASHING.md) and
[bridge setup](../../docs/OPENCLAW.md). Use `scripts/cardputer.py` from the
repository root. The original OmniBot hub/BLE workflow below is historical;
current firmware uses a Wi-Fi setup portal.


`CardputerADV` is the S1-ADV firmware target for M5Stack Cardputer ADV.
The project began with OmniBot; see [Credits](../../CREDITS.md) for its origin.

## Current OpenClaw workflow

- Firmware: ESP32-S3, 8 MB flash, dual OTA partitions.
- Transport: your bridge, authenticated HTTP/WebSocket, HTTPS/WSS for remote use.
- First boot: Wi-Fi setup portal, or your private compile-time provisioning.
- Chat: keyboard text and ordinary push-to-talk with bridge-side STT/TTS.
- Offline: focus timer, notes, calculator, clocks, pet and games.

```bash
# From the repository root, with PlatformIO installed in this Python environment:
python3 scripts/cardputer.py build
python3 scripts/cardputer.py upload --port YOUR_USB_PORT
python3 scripts/cardputer.py monitor --port YOUR_USB_PORT
```

See [the flashing guide](../../docs/FLASHING.md) before building or uploading.
Use `/help` for current controls, `/status` for diagnostics and `/setup` for
network and bridge provisioning. Realtime voice is separately configured and
experimental. Camera and hands-free wake-word features are not supported here.

## HC-SR04 Sonar wiring

Sonar uses the Cardputer ADV EXT 2.54 mm header and samples at about 10 Hz:

- `VCC` → `5VOUT` (third contact on the lower row)
- `GND` → `GND` (second contact on the lower row)
- `TRIG` → `G4` (second contact on the upper row)
- `ECHO` → voltage divider → `G6` (third contact on the upper row)

The HC-SR04 ECHO signal is 5 V and must not go directly into the ESP32-S3.
Use `ECHO → 1 kOhm → G6`, with `2 kOhm` from the G6 node to GND.
`4.7 kOhm / 10 kOhm` is also suitable.

On the Sonar screen, press `M` to switch between the large Proximity view and
the animated Radar view. Radar plots the measured range on the fixed forward
bearing; a single stationary HC-SR04 cannot determine left/right angle.

## RFID Lab wiring

RFID Lab is intentionally read-only: it detects the reader and shows card UID,
SAK, UID length, and PICC type. It does not copy hotel/access cards and does not
write protected MIFARE sectors.

Default supported module: M5Stack Unit RFID/RFID2 or compatible MFRC522 I2C unit
at address `0x28` on the Cardputer HY2.0/Grove Port A:

- red → 5V
- black → GND
- yellow/G2 → SDA, GPIO2
- white/G1 → SCL, GPIO1

Generic SPI RC522 boards are not enabled by this firmware profile; use an I2C
Unit RFID/RFID2 adapter for the default Cardputer wiring.

## Voice Flow

1. Hold `BtnA` or `Fn`
2. Speak into the Cardputer mic
3. Release the trigger
4. The hub transcribes speech with OpenAI, generates a reply, and streams PCM back
5. The Cardputer shows transcript + reply and plays the spoken answer through its speaker

## Emoji SD Pack

The firmware renders color emoji from the SD card only. Put PNG assets under
`/emoji/uHEX.png` on the card root, for example `/emoji/u1F600.png`.

Emoji assets are optional and are not bundled with the public source.
