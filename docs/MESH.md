# Mesh on S1-ADV

The Tools → Mesh application adds a Meshtastic leaf client to S1-ADV on the
Cardputer ADV with Cap LoRa-1262. It preserves the existing applications and
8 MB dual-OTA partition layout. It does not replace S1-ADV with the standalone
Meshtastic firmware.

Attach the antenna before powering the Cap. Start Mesh with Enter. Esc stops
the radio and returns Home; while reading a message, the first Esc closes the
message. Cancelling during radio initialization waits for the worker to finish
before releasing the radio or restoring SD.

## Shared hardware

Mesh exclusively owns the shared SPI bus while active. SD-dependent audio,
voice, notes, files, assets and NES applications are temporarily unavailable.
RFID and Sonar also conflict with the Cap's GPIOs. Exit Mesh before using these
applications. Selecting another non-conflicting application stops Mesh first.
The SD is remounted after radio shutdown, including failed initialization.
No files are formatted or deleted. Mount failure is reported separately from
radio state; internal storage becomes available again after leaving Mesh.

Network-heavy polling and voice services pause during Mesh. Pomodoro time,
alarms, battery and SmartLamp servicing continue. This first version does not
run Mesh in the background alongside those applications.

## Channel and controls

- Thailand region, LongFast public channel: 923.875 MHz, 250 kHz, SF11, CR4/5.
- Transmit power is fixed at 10 dBm; the library applies regional airtime
  accounting and carrier sensing. These software settings do not certify an
  antenna or regulatory approval.
- Enter sends up to 200 UTF-8 bytes to the public channel. `Queued` means local
  acceptance, not confirmed delivery. Public-channel messages are public.
- Ctrl+N switches to nodes heard; Up/Down changes pages or message selection.
- Ctrl+O opens the selected message. Esc closes it before exiting Mesh.
- The in-memory history holds eight messages and sixteen recently heard nodes.
  It resets on exit. No SD writes occur while the radio owns SPI.
- The device identity is generated once and retained in NVS, independently of SD.

The client receives channel text and node announcements and sends channel text
and its own NodeInfo. It does not relay packets, provide the Meshtastic phone
API, use the Cap GNSS, scan other frequencies, or provide private-message UI.
An empty list means no compatible announcements were received during this
session; it does not establish that Phuket has no nodes. Received radio text
is display data and is never executed as a device or agent instruction.

## Checks

`scripts/test_mesh_leaf_state.py`, `test_mesh_lifecycle.py`, `test_mesh_radio.py`
and `test_mesh_ui.py` exercise the production state, lifecycle, radio setup and
240×135 renderer. Lifecycle tests use controlled hardware mocks and include
worker cancellation, partial initialization, SD restoration and app guards.
State and UI tests include malformed UTF-8, fixed bounds and sanitizers.
These checks do not substitute for RF communication with a second node.

USB commands: `mesh.open`, `mesh.start`, `mesh.status`, `mesh.nodes`, `mesh.stop`.
They do not send a test chat message. Serial logs report successful radio init,
session heap minima and SD restoration. No private keys are logged.

## Source and licensing

S1-ADV's original MIT notices remain in `LICENSE`. The firmware image linked
with libmeshtastic-leaf is distributed under GPL-3.0-only; this does not
relicense the separately distributed bridge/plugin or remove existing notices.
The GPL text is included in `third_party/libmeshtastic-leaf/LICENSE`.

Complete S1 source and build instructions are in this repository. Dependencies
are fetched by `bots/CardputerADV/platformio.ini`: libmeshtastic-leaf commit
`bd542d6e77aa7b9507dcc8d153f6dad0c35a8c17`, RadioLib 7.7.1, Nanopb 0.4.92,
and the leaf dependency's Crypto commit
`591ff9a690e8168ccb7a36abde8d7783e448d395`. The leaf repository includes its
pinned protobuf submodule and generated sources. Source links and notices:

- https://github.com/Meshtastic-Solutions/libmeshtastic-leaf/tree/bd542d6e77aa7b9507dcc8d153f6dad0c35a8c17
- https://github.com/jgromes/RadioLib/tree/7.7.1
- https://github.com/nanopb/nanopb/tree/0.4.9.2
- https://github.com/meshtastic/Crypto/tree/591ff9a690e8168ccb7a36abde8d7783e448d395

Build with `python scripts/cardputer.py build` using the documented ESP32-S3,
8 MB configuration. Provisioning credentials are local inputs, never source
files. Preserve the source commit listed in each firmware manifest when
rebuilding a distributed image.
