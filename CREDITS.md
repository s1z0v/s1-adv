# Credits

## Project origin

**S1-ADV for Cardputer ADV** is an independent firmware and bridge project
maintained by **Sergey Sizov** ([srg0](https://github.com/srg0)).

The project originally grew from
**[OmniBot by nazirlouis and its contributors](https://github.com/nazirlouis/OmniBot)**.
That code supplied the starting firmware and device/hub communication foundation.
S1-ADV continues the Cardputer ADV direction with its handheld interface,
offline applications, OpenClaw bridge and device update workflow.

The standalone S1-ADV repository starts with a fresh public source snapshot.
This does not erase the upstream origin or change the rights in inherited code.
The original `Copyright (c) 2026 Omnibot contributors` notice remains in
[LICENSE](LICENSE). Original source headers and third-party notices are retained.

## Foundations and dependencies

- [OmniBot](https://github.com/nazirlouis/OmniBot): original project foundation, MIT.
- [M5Stack M5Cardputer](https://github.com/m5stack/M5Cardputer), M5Unified and M5GFX: hardware support and graphics.
- [OpenClaw](https://github.com/openclaw/openclaw): host-side agent and gateway.
- Arduino ESP32 / FreeRTOS: embedded runtime.
- ArduinoJson, arduinoWebSockets, Arduino-IRremote and MFRC522: device libraries.
- ws and Busboy: bridge WebSocket and upload handling.
- The firmware's `third_party/` directory retains applicable protocol notices.

Dependencies keep their own licenses. The S1-ADV license does not replace them.
The project-local `bots/CardputerADV/lib/WebServer` is derived from Espressif
Arduino ESP32 2.0.14 WebServer, LGPL-2.1-or-later. Its source headers, license
and [security backport notes](bots/CardputerADV/lib/WebServer/S1-ADV-PATCHES.md)
are retained.

## Cover image

The S1-ADV cover was composed with the built-in image generation tool, using
Sergey Sizov's ADV video/thumbnail references and a reference photograph of the
real M5Stack Cardputer ADV to preserve its appearance. It is a photographic
composite; the voice interface shown on its LCD is illustrative, not a captured
device screenshot. The device design and M5Stack markings belong to their
respective owners.
