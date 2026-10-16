# WebServer security backports

Source: Espressif Arduino ESP32 **2.0.14**, `libraries/WebServer`, LGPL-2.1-or-later.
Original source headers and attribution are preserved. This project-local library
overrides the framework copy; no global PlatformIO package is modified.

Changes on 2026-10-16:

- Reject empty or >70-byte multipart boundaries before parsing/allocation, and
  use a bounded, NUL-terminated 71-byte matching buffer. This backports the
  boundary limit described in [GHSA-8cmm-3887-r32j](https://github.com/espressif/arduino-esp32/security/advisories/GHSA-8cmm-3887-r32j)
  to the legacy API used by this firmware.
- Reject CR/LF in response header names and values, addressing the unsafe
  header construction described in [GHSA-5476-9jjq-563m](https://github.com/espressif/arduino-esp32/security/advisories/GHSA-5476-9jjq-563m).
- Limit provisioning bodies to 4096 bytes and do not read beyond the declared
  Content-Length into the body buffer.

Digest authentication, NetBIOS and browser-based firmware upload are not used
by PulseOS. The full framework remains legacy; these specific backports do not
constitute an audit of every framework/ESP-IDF component. Revisit the backports
when moving to a current Arduino ESP32 toolchain.
