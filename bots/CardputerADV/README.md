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

The current firmware uses an **MFRC522/RC522 SPI module**, usually the board
with eight contacts. It does not use an I2C RFID2/Grove module or a PN532 driver.

| RC522 contact | Cardputer ADV connection |
| --- | --- |
| SDA / SS / NSS | EXT **G5** (SPI chip select, not I2C SDA) |
| SCK | EXT **G40** |
| MOSI | EXT **G14** |
| MISO | EXT **G39** |
| RST | EXT **G3** |
| GND | EXT **GND**, shared with the 3.3 V supply |
| 3.3V | Regulated **3.3 V** |
| IRQ | Leave unconnected |

**The EXT header has 5VIN and 5VOUT, but no 3.3 V supply contact. Do not
connect a bare RC522's 3.3V contact directly to 5VOUT or the Grove red wire.**
One external-power arrangement is Cardputer 5VOUT → 5-to-3.3 V regulator →
RC522 3.3V, with a common ground. Identify wires by their printed GPIO/signal
labels; connector orientation changes when the board is turned over.
See the [official Cardputer ADV pin map](https://docs.m5stack.com/en/core/Cardputer-Adv)
and [NXP MFRC522 electrical specifications](https://www.nxp.com/docs/en/data-sheet/MFRC522.pdf).

Open **RFID Lab** from the app launcher, or type `/rfid` in chat. `R` retries
reader initialization; `?`/`H` shows the wiring help. The expected idle status
is `Ready: present card`. Present a compatible 13.56 MHz ISO/IEC 14443-A tag to
read its UID, SAK, UID length and PICC type. This is not a 125 kHz reader.

`D` reads accessible MIFARE Classic blocks using the default `FF FF FF FF FF FF`
key into RAM. `W` immediately writes the captured data to a compatible target,
skipping sector trailers and the manufacturer block in the regular write loop;
the code also attempts a UID change for supported UID-writable cards. This is
not a universal card clone. Start with UID detection and use only a spare tag
for write tests. NTAG/NDEF text or URL writing is not implemented in this app.

The reader shares SCK/MOSI/MISO with microSD; its chip select is G5, while
microSD uses G12. The pin map and controls were checked against the source;
physical reader detection, card reads and SD coexistence still need a hardware
test on the attached module.

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
