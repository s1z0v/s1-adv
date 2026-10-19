# 0.2.181-dev

Realtime stages incomplete WebSocket frames incrementally before exposing them
to the existing protocol parser. Its synchronous whole-frame reader can no
longer wait for network bytes inside a UI/audio poll. Common PCM frames fit
in a 2 KiB inline buffer. Large frames retain the existing 15 KiB payload
limit; malformed frames, allocation failures and stalled partial frames close
the session explicitly. TLS ownership and certificate verification are retained.
The ESP32 socket timeout is supplied in seconds, as required by its API.

Ordinary voice requests log monotonic timestamps for release, connection,
upload, response and speech preparation. This supports a device measurement
of the reported delay without changing its providers or conversation routing.
The LUNA / medium first response and primary Sol / high roles are unchanged.

Host checks, firmware build, OTA installation and audible Realtime acceptance
are separate results. Runtime evidence and remaining limits will be recorded
in VALIDATION.md after qualification.
