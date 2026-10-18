# 0.2.160-dev

Home's battery gauge now uses five broad diagonal strokes instead of eight
single-pixel lines. Each stroke is four pixels wide, making charge easier to
read while retaining the original 34×6 outline, terminal and percentage position.
Charge is rounded up to the next stroke; zero and unavailable readings light
none. The existing amber/red thresholds and unavailable `--%` label are unchanged.

The clock, rings, animated bars, READY box and chat hint keep their positions.
Rendering still uses the existing snapshot with no new sensor, network or storage
operations. No changes to provisioning, TLS, partitions, OTA or boot guards.

Verification: `python3 scripts/test_home_battery.py` exercises the actual drawing
function on a host canvas stub, including bounds, stroke count, charge thresholds,
percentage labels and font restoration. Physical-device appearance is not
verified by this host test.
