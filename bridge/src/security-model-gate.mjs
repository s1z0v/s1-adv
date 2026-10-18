import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealtimeAdmissionController, requestClientIp } from "./security-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.resolve(process.env.GATE_OUTPUT_DIR || path.join(ROOT, "gate-evidence/security-properties"));
const SEED = 0x5eedc0de;
const FUZZ_TRANSITIONS = 1_000_000;
const RELEASE_REF = String(process.env.GATE_RELEASE_REF || "working-tree").trim();

function legacyClientIp(req) {
  return String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
}

function otaRace(useLiveRuntimeFence) {
  const service = { messages: [], events: [], revision: 1 };
  let disk = structuredClone(service);
  const event = { id: "ota:0.2.126-dev", urgent: true };
  if (useLiveRuntimeFence) {
    service.events.push(event);
    service.revision += 1;
    disk = structuredClone(service);
  } else {
    const external = structuredClone(disk);
    external.events.push(event);
    external.revision += 1;
    disk = external;
  }
  service.messages.push({ id: "concurrent-message" });
  service.revision += 1;
  disk = structuredClone(service);
  return { eventDurable: disk.events.some((item) => item.id === event.id), trace: { service, disk } };
}

function authSpoof(useTrustedLastHopFence) {
  const buckets = new Map();
  const config = { security: { trustedProxyAddresses: ["192.0.2.10"] } };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const req = {
      socket: { remoteAddress: "192.0.2.10" },
      headers: { "x-forwarded-for": `198.51.100.${attempt + 1}, 203.0.113.9` }
    };
    const key = useTrustedLastHopFence ? requestClientIp(req, config) : legacyClientIp(req);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return {
    blocked: Math.max(...buckets.values()) >= 5,
    buckets: Object.fromEntries(buckets)
  };
}

function realtimeAbuse(useAdmissionFence) {
  if (!useAdmissionFence) {
    return { admitted: 100, peak: 100 };
  }
  const controller = new RealtimeAdmissionController({
    realtimeVoice: { maxActivePerDevice: 2, maxActiveGlobal: 8 }
  }, () => 0);
  const leases = [];
  let admitted = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const lease = controller.acquire("device-a");
    if (lease.ok) {
      admitted += 1;
      leases.push(lease);
    }
  }
  const peak = controller.snapshot().activeGlobal;
  for (const lease of leases) {
    lease.release();
    lease.release();
  }
  return { admitted, peak, afterRelease: controller.snapshot().activeGlobal };
}

function xorshift32(value) {
  let next = value >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

function deterministicFuzz() {
  let seed = SEED;
  let now = 0;
  let otaAccepted = false;
  let otaAcked = false;
  let otaDurable = false;
  const controller = new RealtimeAdmissionController({
    realtimeVoice: {
      maxActivePerDevice: 2,
      maxActiveGlobal: 8,
      startLimitPerDevice: 30,
      startWindowMs: 60_000
    }
  }, () => now);
  const leases = [];
  let peak = 0;
  for (let transition = 0; transition < FUZZ_TRANSITIONS; transition += 1) {
    seed = xorshift32(seed);
    const operation = seed % 8;
    const deviceId = `device-${(seed >>> 8) % 8}`;
    if (operation === 0) {
      otaAccepted = true;
      if (!otaAcked) {
        otaDurable = true;
      }
    } else if (operation === 1) {
      otaAcked ||= otaAccepted && ((seed >>> 16) & 1) === 1;
      if (otaAcked) {
        otaDurable = false;
      }
    } else if (operation === 2 || operation === 3) {
      const lease = controller.acquire(deviceId, now);
      if (lease.ok) {
        leases.push(lease);
      }
    } else if (operation === 4 && leases.length > 0) {
      const lease = leases.pop();
      lease.release();
      lease.release();
    } else if (operation === 5) {
      now += (seed % 5000) + 1;
    } else if (operation === 6) {
      const req = {
        socket: { remoteAddress: "192.0.2.10" },
        headers: { "x-forwarded-for": `198.51.100.${seed % 250}, 203.0.113.${(seed >>> 8) % 250}` }
      };
      assert.match(
        requestClientIp(req, { security: { trustedProxyAddresses: ["192.0.2.10"] } }),
        /^203\.0\.113\./u
      );
    }
    const snapshot = controller.snapshot();
    peak = Math.max(peak, snapshot.activeGlobal);
    assert.ok(snapshot.activeGlobal >= 0 && snapshot.activeGlobal <= 8);
    for (const active of Object.values(snapshot.activeByDevice)) {
      assert.ok(active >= 1 && active <= 2);
    }
    assert.ok(!otaAccepted || otaAcked || otaDurable);
  }
  while (leases.length > 0) {
    leases.pop().release();
  }
  assert.equal(controller.snapshot().activeGlobal, 0);
  return { seed: `0x${SEED.toString(16)}`, executed: FUZZ_TRANSITIONS, peak };
}

// This is a bounded property harness, not a release certificate. No arbitrary
// Cartesian dimensions, inferred coverage or environment-asserted canary PASS.
const actual = [
  { name:"OTA snapshot model", baseline:otaRace(false).eventDurable, fenced:otaRace(true).eventDurable },
  { name:"trusted forwarded identity", baseline:authSpoof(false).blocked, fenced:authSpoof(true).blocked },
  { name:"Realtime admission", baseline:realtimeAbuse(false).peak <= 2, fenced:realtimeAbuse(true).peak <= 2 }
];
for(const result of actual){assert.equal(result.baseline,false);assert.equal(result.fenced,true);}
const fuzz=deterministicFuzz();
const evidence={
  ref:RELEASE_REF, generatedAt:new Date().toISOString(),
  purpose:"Bounded properties for real admission/proxy code and a small OTA persistence model",
  notAReleaseGate:true, rawEquivalentCoverage:null,
  executedFenceComparisons:actual.length, actualGeneratedTransitions:fuzz.executed,
  seed:fuzz.seed, comparisons:actual, fuzz,
  limitations:["The OTA snapshot example is a model, not a full runtime exploration.",
    "No exhaustive ownership/state coverage or formal equivalence proof is claimed.",
    "HTTP/WS integration, native plugin, live canaries and hardware acceptance are separate checks."]
};
await mkdir(OUTPUT,{recursive:true});
await writeFile(path.join(OUTPUT,"property-evidence.json"),JSON.stringify(evidence,null,2)+"\n");
console.log(JSON.stringify(evidence,null,2));
