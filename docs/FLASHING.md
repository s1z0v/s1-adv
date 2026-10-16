# Build and flash

Target: **M5Stack Cardputer ADV**, ESP32-S3, **8 MB flash**.
Do not substitute an old 2 MB Plai partition layout or a generic ESP32 target.

## Install the tools

Install Python 3, Git and [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation/index.html).
A virtual environment avoids changing your system Python:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install platformio==6.1.19
```

Windows PowerShell: activate with `.venv\Scripts\Activate.ps1` and use
`python` in place of `python3` if appropriate.

## Configure your build

From the repository root:

```bash
cp .env.example .env
```

Edit `.env` locally. Match `DEFAULT_DEVICE_ID`, `DEFAULT_DEVICE_TOKEN` and
`DEFAULT_TOPIC_KEY` to your `bridge/config.json`. Enter the host only in
`DEFAULT_HUB_HOST`, with no scheme or path. Use port `443` for HTTPS/WSS.
Use a bridge certificate chained to ISRG Root X1, or adapt the firmware CA
bundle to your own trusted CA. Do not disable certificate verification.

Wi-Fi SSID/password and token may be left blank to provision through the
device setup portal. With the supplied wrapper, the default device ID is
`cardputer-adv-01` and topic is `cardputer:main`. The setup portal does not change
that topic, so set a custom topic before building if you need one.
Connect to the setup access point using the random password shown on the
Cardputer screen, then open `http://192.168.4.1/`. The portal accepts requests
only on that access point. The bridge URL entered there must use HTTPS.

Credentials embedded by a build are recoverable from its binary. Keep `.env`,
build logs and provisioned `.bin` files private. The wrapper does not enable
verbose compiler output.

## Build and upload

```bash
python3 scripts/cardputer.py build
python3 scripts/cardputer.py ports
python3 scripts/cardputer.py upload --port /dev/cu.usbmodem1101
python3 scripts/cardputer.py monitor --port /dev/cu.usbmodem1101
```

On Linux the port is often `/dev/ttyACM0`; on Windows, `COM3` or another COM
number. Choose the port actually listed on your machine. macOS USB suffixes
can change after reset.

If connecting fails: hold **G0**, press **Reset**, release **G0**, then upload
again. Default upload speed is 460800. Reset after upload, then check `/status`.

PlatformIO flashes the bootloader, partitions and app at their generated
addresses. This is the supported first-install method.

## App image versus merged image

- `.pio/build/cardputer_adv/firmware.bin` is an **app image**. It is suitable
  for this firmware's matching OTA layout. It is not a full-flash image.
- A merged/full image includes the bootloader and partition table and is
  flashed at `0x0` only when its producer explicitly labels it as merged/full.
- Never flash a PlatformIO app image at `0x0`.
- Keep the included `partitions_8mb_dual_ota.csv`: both OTA slots must fit the app.

## OTA after the first install

Build with the same device provisioning, then publish to **your bridge**:

```bash
cd bridge
npm run publish:firmware -- --config config.json \
  --bin ../bots/CardputerADV/.pio/build/cardputer_adv/firmware.bin \
  --version YOUR_VERSION --git YOUR_COMMIT
```

Replace the uppercase values with the app version and built commit. Check
`/ota` on the device, review the version, and explicitly apply it. Connect USB
power first. An uploaded artifact or queued event does not prove installation;
read the boot version and test a real conversation.

Never publish a binary compiled with someone else's device token. Public
generic binaries will need a separate clean build and hardware acceptance.
