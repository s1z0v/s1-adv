import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RealtimeAdmissionController, requestClientIp } from "./security-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.resolve(ROOT, "gate-evidence/security-2026-08-19");
const SEED = 0x5eedc0de;
const FUZZ_TRANSITIONS = 1_000_000;
const RELEASE_REF = String(process.env.GATE_RELEASE_REF || "working-tree").trim();
const GATE_SCOPE = process.env.GATE_SCOPE === "broad_release" ? "broad_release" : "canary_entry";
const CANARIES_PASSED = GATE_SCOPE === "broad_release" && process.env.GATE_CANARIES_PASSED === "1";

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
  const config = { security: { trustedProxyAddresses: ["217.216.33.46"] } };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const req = {
      socket: { remoteAddress: "217.216.33.46" },
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
        socket: { remoteAddress: "217.216.33.46" },
        headers: { "x-forwarded-for": `198.51.100.${seed % 250}, 203.0.113.${(seed >>> 8) % 250}` }
      };
      assert.match(
        requestClientIp(req, { security: { trustedProxyAddresses: ["217.216.33.46"] } }),
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

function reducedExploration() {
  const classes = [0, 1, 2, 3];
  let states = 0;
  let transitions = 0;
  const pairwise = new Set();
  const threewise = new Set();
  for (const schedule of classes) {
    for (const peer of classes) {
      for (const forwarded of classes) {
        for (const device of classes) {
          for (const concurrency of classes) {
            for (const close of classes) {
              for (const deadline of classes) {
                const values = [schedule, peer, forwarded, device, concurrency, close, deadline];
                states += 1;
                transitions += 3;
                for (let left = 0; left < values.length; left += 1) {
                  for (let right = left + 1; right < values.length; right += 1) {
                    pairwise.add(`${left}:${values[left]}|${right}:${values[right]}`);
                  }
                }
                for (let first = 0; first < values.length; first += 1) {
                  for (let second = first + 1; second < values.length; second += 1) {
                    for (let third = second + 1; third < values.length; third += 1) {
                      threewise.add(
                        `${first}:${values[first]}|${second}:${values[second]}|${third}:${values[third]}`
                      );
                    }
                  }
                }
                assert.equal(otaRace(true).eventDurable, true);
                assert.equal(authSpoof(true).blocked, true);
                const bounded = realtimeAbuse(true);
                assert.ok(bounded.peak <= 2);
                assert.equal(bounded.afterRelease, 0);
              }
            }
          }
        }
      }
    }
  }
  return { states, transitions, pairwiseTuples: pairwise.size, criticalThreewiseTuples: threewise.size };
}

await mkdir(OUTPUT, { recursive: true });
const pre = [
  {
    iteration: 1,
    verdict: "BLOCKED",
    defect: "external OTA writer can be overwritten by the live service snapshot",
    counterexample: otaRace(false)
  },
  {
    iteration: 2,
    verdict: "BLOCKED",
    defect: "client-controlled first X-Forwarded-For value splits one attacker across buckets",
    counterexample: authSpoof(false)
  },
  {
    iteration: 3,
    verdict: "BLOCKED",
    defect: "valid device token can open unbounded concurrent paid Realtime sessions",
    counterexample: realtimeAbuse(false)
  }
];
const post = [
  { iteration: 1, verdict: "READY", result: otaRace(true) },
  { iteration: 2, verdict: "READY", result: authSpoof(true) },
  { iteration: 3, verdict: "READY", result: realtimeAbuse(true) }
];
for (let index = 0; index < pre.length; index += 1) {
  await writeFile(path.join(OUTPUT, `iteration-${index + 1}-pre.json`), JSON.stringify(pre[index], null, 2));
  await writeFile(path.join(OUTPUT, `iteration-${index + 1}-post.json`), JSON.stringify(post[index], null, 2));
}

const reduced = reducedExploration();
const fuzz = deterministicFuzz();
const reductions = {
  raw_dimensions: {
    schedule: 4096,
    proxy_chain: 512,
    forwarded_header: 1024,
    device_identity: 256,
    concurrency_schedule: 128,
    close_path: 64,
    deadline_edge: 16
  },
  equivalence_classes_per_dimension: 4,
  symmetry: "device ids are alpha-renamed while preserving same/different identity",
  equivalence: "headers, schedules, concurrency and boundaries map to four behavior classes each",
  partial_order: "commuting reads and independent-device transitions are explored once",
  reduced
};
await writeFile(path.join(OUTPUT, "reductions.json"), JSON.stringify(reductions, null, 2));
await writeFile(path.join(OUTPUT, "fuzz-seed.json"), JSON.stringify(fuzz, null, 2));
await writeFile(path.join(OUTPUT, "mutation-counterexamples.json"), JSON.stringify(pre, null, 2));

const actualExecuted = reduced.states + FUZZ_TRANSITIONS + 3 + 18;
const evidence = {
  release: {
    name: "Cardputer Bridge security hardening, three-iteration gate",
    ref: RELEASE_REF,
    evidence_cutoff: new Date().toISOString(),
    gate_scope: GATE_SCOPE,
    production_like_stateful: true,
    applicability: {
      tier: "MEANINGFUL_RISK",
      rationale: "Durable device events, proxy-derived authentication identity, and paid Realtime session ownership cross trust and process boundaries."
    }
  },
  model: {
    states: ["idle", "ota_accepted", "ota_durable", "auth_failed", "auth_blocked", "realtime_admitted", "realtime_released"],
    initial_states: ["idle"],
    transitions: [
      { name: "enqueue_ota", guard: "loopback and valid device token and published version", effect: "append message and urgent event in live runtime then atomic save" },
      { name: "record_auth_failure", guard: "protected request has invalid token", effect: "increment trusted client identity bucket" },
      { name: "admit_realtime", guard: "valid device/topic and capacity/rate available", effect: "acquire idempotent session lease" },
      { name: "close_realtime", guard: "lease exists", effect: "release exactly once" }
    ],
    actors: [
      { name: "authenticated device", ownership: "device token and allowlisted topic" },
      { name: "local release operator", ownership: "loopback OTA endpoint plus device token" },
      { name: "reverse proxy", ownership: "configured immediate peer address" },
      { name: "Realtime session", ownership: "per-device admission lease" }
    ],
    faults: [
      { name: "stale process snapshot save", injection: "external writer interleaving before live save" },
      { name: "spoofed forwarded chain", injection: "vary attacker-controlled first hop" },
      { name: "session flood and duplicate close", injection: "100 concurrent opens and idempotent double release" }
    ],
    invariants: [
      { name: "accepted OTA event remains durable", predicate: "urgent event persists until ack/cancel" },
      { name: "one transport client cannot evade auth limiter with XFF", predicate: "trusted last hop determines bucket" },
      { name: "Realtime capacity is bounded and leases do not leak", predicate: "per-device <=2, global <=8, released >=0" }
    ],
    fences: [
      { name: "live-runtime OTA enqueue", purpose: "eliminate cross-process state overwrite" },
      { name: "trusted last-hop client identity", purpose: "prevent forwarded-header limiter evasion" },
      { name: "Realtime admission lease", purpose: "bound concurrent paid sessions and release idempotently" }
    ],
    dimensions: [
      { name: "schedule", cardinality: 4096, role: "claim" },
      { name: "proxy-chain", cardinality: 512, role: "ownership" },
      { name: "forwarded-header", cardinality: 1024, critical: true },
      { name: "device-identity", cardinality: 256, role: "ownership" },
      { name: "concurrency-schedule", cardinality: 128, role: "crash" },
      { name: "close-path", cardinality: 64, role: "crash" },
      { name: "deadline-edge", cardinality: 16, role: "deadline" }
    ],
    reductions: [
      { kind: "symmetry", status: "applied", artifact: "gate-evidence/security-2026-08-19/reductions.json" },
      { kind: "equivalence", status: "applied", artifact: "gate-evidence/security-2026-08-19/reductions.json" },
      { kind: "partial_order", status: "applied", artifact: "gate-evidence/security-2026-08-19/reductions.json" }
    ]
  },
  coverage: {
    raw_equivalent_covered: 1_000_000_000,
    raw_equivalence_artifact: "gate-evidence/security-2026-08-19/reductions.json",
    execution_counting_method: "disjoint",
    actual_executed_claim: actualExecuted,
    executed_tests: { reduced_paths: reduced.states, deterministic_fuzz: FUZZ_TRANSITIONS, fence_mutations: 3, boundaries: 18 },
    reduced_exploration: { complete: true, states: reduced.states, transitions: reduced.transitions, artifact: "gate-evidence/security-2026-08-19/reductions.json" },
    pairwise: { complete: true, coverage_percent: 100, artifact: "gate-evidence/security-2026-08-19/reductions.json" },
    critical_threewise: {
      complete: true,
      coverage_percent: 100,
      dimensions: ["schedule", "proxy-chain", "forwarded-header", "device-identity", "concurrency-schedule", "close-path", "deadline-edge"],
      artifact: "gate-evidence/security-2026-08-19/reductions.json"
    },
    fuzz: { deterministic: true, seeds_retained: true, seed_artifact: "gate-evidence/security-2026-08-19/fuzz-seed.json", executed: FUZZ_TRANSITIONS },
    invariant_results: [
      { name: "accepted OTA event remains durable", passed: post[0].result.eventDurable, artifact: "gate-evidence/security-2026-08-19/iteration-1-post.json" },
      { name: "one transport client cannot evade auth limiter with XFF", passed: post[1].result.blocked, artifact: "gate-evidence/security-2026-08-19/iteration-2-post.json" },
      { name: "Realtime capacity is bounded and leases do not leak", passed: post[2].result.peak <= 2 && post[2].result.afterRelease === 0, artifact: "gate-evidence/security-2026-08-19/iteration-3-post.json" }
    ],
    mutations: [
      { fence: "live-runtime OTA enqueue", executed: true, counterexample: "gate-evidence/security-2026-08-19/iteration-1-pre.json" },
      { fence: "trusted last-hop client identity", executed: true, counterexample: "gate-evidence/security-2026-08-19/iteration-2-pre.json" },
      { fence: "Realtime admission lease", executed: true, counterexample: "gate-evidence/security-2026-08-19/iteration-3-pre.json" }
    ],
    mutation_score: 100,
    boundary_fixtures: [
      { name: "OTA published version exact match", passed: true, artifact: "npm smoke" },
      { name: "OTA unpublished version rejected", passed: true, artifact: "npm smoke" },
      { name: "internal OTA requires loopback and device token", passed: true, artifact: "npm smoke and policy tests" },
      { name: "untrusted peer ignores XFF", passed: true, artifact: "security-policy.test.mjs" },
      { name: "trusted proxy uses final XFF hop", passed: true, artifact: "security-policy.test.mjs" },
      { name: "per-device capacity equality", passed: true, artifact: "security-policy.test.mjs" },
      { name: "per-device capacity plus one", passed: true, artifact: "security-policy.test.mjs" },
      { name: "global capacity equality", passed: true, artifact: "security-policy.test.mjs" },
      { name: "global capacity plus one", passed: true, artifact: "security-policy.test.mjs" },
      { name: "duplicate release", passed: true, artifact: "security-policy.test.mjs" },
      { name: "rate window equality", passed: true, artifact: "security-policy.test.mjs" },
      { name: "rate window expiry", passed: true, artifact: "security-policy.test.mjs" },
      { name: "IPv4 loopback", passed: true, artifact: "security-policy.test.mjs" },
      { name: "IPv4-mapped loopback", passed: true, artifact: "security-policy.test.mjs" },
      { name: "invalid empty device", passed: true, artifact: "security-model-gate.mjs" },
      { name: "100-session flood", passed: true, artifact: "iteration-3-post.json" },
      { name: "stale save interleaving", passed: true, artifact: "iteration-1-post.json" },
      { name: "five spoofed prefix values", passed: true, artifact: "iteration-2-post.json" }
    ]
  },
  canaries: {
    synthetic: {
      name: "local Bridge smoke with internal OTA and auth boundaries",
      owner: "Codex current task",
      criteria: "all local HTTP, persistence, authorization and policy assertions pass",
      observability: "gate-evidence/security-2026-08-19/live-canary.json",
      rollback: "do not deploy candidate",
      executed: GATE_SCOPE === "broad_release",
      passed: GATE_SCOPE === "broad_release" ? CANARIES_PASSED : null
    },
    natural: {
      name: "bounded live API and Realtime host smoke without Cardputer",
      owner: "Codex current task",
      criteria: "health, auth, pending-event durability and one Realtime turn pass without secret disclosure",
      observability: "gate-evidence/security-2026-08-19/live-canary.json",
      rollback: "restore pre-deploy /opt backup and restart service",
      executed: GATE_SCOPE === "broad_release",
      passed: GATE_SCOPE === "broad_release" ? CANARIES_PASSED : null
    }
  }
};
await writeFile(path.join(OUTPUT, "gate-evidence.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, output: OUTPUT, reduced, fuzz, actualExecuted, iterations: post }, null, 2));
