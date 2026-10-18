import assert from "node:assert/strict";
import { isLoopbackAddress, RealtimeAdmissionController, requestClientIp } from "./security-policy.mjs";

function request(peer, forwarded = "") {
  return {
    socket: { remoteAddress: peer },
    headers: forwarded ? { "x-forwarded-for": forwarded } : {}
  };
}

assert.equal(isLoopbackAddress("127.0.0.1"), true);
assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
assert.equal(isLoopbackAddress("203.0.113.9"), false);
assert.equal(requestClientIp(request("203.0.113.9", "198.51.100.1")), "203.0.113.9");
assert.equal(
  requestClientIp(
    request("192.0.2.10", "198.51.100.123, 203.0.113.44"),
    { security: { trustedProxyAddresses: ["192.0.2.10"] } }
  ),
  "203.0.113.44"
);
assert.equal(
  requestClientIp(
    request("192.0.2.11", "198.51.100.123, 203.0.113.44"),
    { security: { trustedProxyAddresses: ["192.0.2.10"] } }
  ),
  "192.0.2.11"
);

let now = 0;
const admission = new RealtimeAdmissionController({
  realtimeVoice: {
    maxActivePerDevice: 2,
    maxActiveGlobal: 3,
    startLimitPerDevice: 5,
    startWindowMs: 60_000
  }
}, () => now);
const first = admission.acquire("device-a");
const second = admission.acquire("device-a");
assert.equal(first.ok, true);
assert.equal(second.ok, true);
assert.equal(admission.acquire("device-a").reason, "device_session_limit");
const third = admission.acquire("device-b");
assert.equal(third.ok, true);
assert.equal(admission.acquire("device-c").reason, "global_session_limit");
assert.equal(first.release(), true);
assert.equal(first.release(), false);
assert.equal(admission.snapshot().activeGlobal, 2);
assert.equal(admission.acquire("device-c").ok, true);
second.release();
third.release();

const rate = new RealtimeAdmissionController({
  realtimeVoice: {
    maxActivePerDevice: 1,
    maxActiveGlobal: 1,
    startLimitPerDevice: 5,
    startWindowMs: 60_000
  }
}, () => now);
for (let attempt = 0; attempt < 5; attempt += 1) {
  const lease = rate.acquire("device-rate");
  assert.equal(lease.ok, true);
  lease.release();
}
assert.equal(rate.acquire("device-rate").reason, "session_start_rate_limit");
now = 60_000;
const recovered = rate.acquire("device-rate");
assert.equal(recovered.ok, true);
recovered.release();
assert.equal(rate.snapshot().activeGlobal, 0);

console.log("security policy tests: ok");
