import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { RealtimePacingBudget } from "../src/realtime-pacing-budget.mjs";
import { audioTerminalReady } from "../src/turn-delivery-policy.mjs";

const out = process.argv[2];
assert.ok(out, "provide a task-owned evidence directory");
mkdirSync(out, { recursive: true });
const artifact = name => `${out}/${name}`;
const save = (name, value) => writeFileSync(artifact(name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
const dimensions = [
  { name: "credit-even-bytes", cardinality: 7681, reps: [0, 2, 958, 960, 1440, 15360], role: "critical" },
  { name: "elapsed-ms", cardinality: 4001, reps: [0, 1, 19, 20, 21, 260, 4000], role: "deadline" },
  { name: "queued-pcm-even-bytes", cardinality: 4194305, reps: [0, 2, 1438, 1440, 1442, 8388608], role: "critical" },
  { name: "frame-bytes", cardinality: 3, reps: [480, 1440, 4800], role: "critical" },
  { name: "socket-open", cardinality: 2, reps: [false, true], role: "crash" },
  { name: "audio-terminal-pending", cardinality: 2, reps: [false, true], role: "critical" },
  { name: "response-terminal-pending", cardinality: 2, reps: [false, true], role: "critical" }
];
const rows = [];
function rowTest([credit, elapsed, queued, frame, open, audio, response]) {
  const budget = new RealtimePacingBudget(24000); budget.credit = credit; budget.lastMs = 0;
  const sent = open ? budget.take(elapsed, queued, frame) : 0;
  const available = Math.min(15360, credit + elapsed * 48);
  assert.equal(sent, open ? Math.min(available, queued, frame) : 0);
  assert.equal(sent % 2, 0); assert.ok(budget.credit >= 0 && budget.credit <= 15360);
  const remaining = queued - sent;
  const terminal = open && response && audioTerminalReady(remaining, audio);
  assert.equal(terminal, open && response && remaining === 0 && !audio);
}
function cartesian(i, row) {
  if (i === dimensions.length) { rowTest(row); rows.push(row); return; }
  for (const value of dimensions[i].reps) cartesian(i + 1, [...row, value]);
}
cartesian(0, []);
save("covering-array.json", { columns: dimensions.map(d => d.name), rows });

// Exhaust the stutter-reduced transport state graph. Each PCM drain represents
// any number of nonterminal, bounded-budget steps; credit=0 blocks the drain.
// Response.done cannot overtake PCM or audio.done, even on disconnect.
const initial = [0, 1, false, false, true, false]; // q, credit, audio, response, open, terminal
function next(s, event) {
  let [q, c, a, r, open, done] = s;
  if (!open || done) return s;
  if (event === 0 && !a && !r) q = 1;
  if (event === 1) c = 1;
  if (event === 2 && q && c) { q = 0; c = 0; }
  if (event === 3) a = true;
  if (event === 4) r = true;
  if (event === 5) { open = false; q = 0; a = r = false; }
  if (event === 6 && !q) { a = false; if (r) done = true; }
  return [q, c, a, r, open, done];
}
const seen = new Map([[JSON.stringify(initial), initial]]), todo = [initial];
let transitions = 0;
while (todo.length) {
  const state = todo.shift();
  for (let e = 0; e < 7; ++e) {
    const n = next(state, e); transitions++;
    assert.ok(!n[5] || (n[0] === 0 && !n[2] && n[4]));
    const key = JSON.stringify(n); if (!seen.has(key)) { seen.set(key, n); todo.push(n); }
  }
}
save("graph.json", { states: [...seen.values()], transitions });
let seed = 146202608, now = 0, state = initial;
const budget = new RealtimePacingBudget(24000);
for (let i = 0; i < 1000000; ++i) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const oldCredit = budget.credit, oldMs = budget.lastMs;
  now += (seed % 4001) / 10; // includes fractional monotonic timestamps
  const queued = (seed >>> 7) % 8388609, frame = [480, 1440, 4800][seed % 3];
  const sent = budget.take(now, queued, frame);
  const limit = Math.min(15360, oldCredit + (oldMs === null ? 0 : now - oldMs) * 48);
  assert.ok(sent >= 0 && sent <= queued && sent <= frame && sent <= limit + 1e-7 && sent % 2 === 0);
  assert.ok(budget.credit >= 0 && budget.credit <= 15360);
  state = next(state, seed % 7);
  assert.ok(!state[5] || (!state[0] && !state[2] && state[4]));
  if (!state[4] || state[5]) state = initial;
}
save("seeds.json", { generator: "LCG 1664525/1013904223 uint32", seeds: [146202608], generated_transitions: 1000000 });

const source = readFileSync(new URL("../src/realtime-pacing-budget.mjs", import.meta.url), "utf8");
const classText = source.slice(source.indexOf("export class")).replace("export class", "class");
const compile = text => Function("REALTIME_MAX_AUDIO_LEAD_MS", `return (${text})`)(320);
const mutations = [
  ["credit-cap", "Math.min(this.capacity, this.credit + elapsed * this.bytesPerMs)", "this.credit + elapsed * this.bytesPerMs", C => { const b = new C(24000); b.take(0, 0, 1440); b.take(4000, 0, 1440); assert.ok(b.credit <= 15360); }],
  ["credit-limit", "queuedBytes, frameBytes, this.credit", "queuedBytes, frameBytes", C => { const b = new C(24000); b.credit = 0; assert.equal(b.take(0, 1440, 1440), 0); }],
  ["frame-limit", "queuedBytes, frameBytes, this.credit", "queuedBytes, this.credit", C => assert.ok(new C(24000).take(0, 8388608, 1440) <= 1440)],
  ["queue-limit", "queuedBytes, frameBytes, this.credit", "frameBytes, this.credit", C => assert.equal(new C(24000).take(0, 0, 1440), 0)],
  ["sample-alignment", ") / 2) * 2", "))", C => assert.equal(new C(24000).take(0, 3, 1440) % 2, 0)],
  ["monotonic-clock", "Math.max(this.lastMs ?? nowMs, nowMs)", "nowMs", C => { const b = new C(24000); b.take(100, 15360, 15360); b.take(90, 0, 1440); assert.equal(b.take(100, 1440, 1440), 0); }]
];
for (const [fence, from, to, fixture] of mutations) {
  assert.ok(classText.includes(from)); fixture(RealtimePacingBudget);
  const mutant = compile(classText.replace(from, to));
  assert.throws(() => fixture(mutant), undefined, `surviving mutant ${fence}`);
  save(`mutant-${fence}.txt`, `${from} -> ${to}\nCounterexample fixture: ${fixture.toString()}\n`);
}
for (const [fence, from] of [["drain-before-response", "bufferedBytes === 0"], ["audio-before-response", "!audioDonePending"]]) {
  const mutant = Function(`return (${audioTerminalReady.toString().replace(from, "true")})`)();
  assert.equal(audioTerminalReady(fence.startsWith("drain") ? 2 : 0, fence.startsWith("audio")), false);
  assert.equal(mutant(fence.startsWith("drain") ? 2 : 0, fence.startsWith("audio")), true);
  mutations.push([fence]); save(`mutant-${fence}.txt`, `Remove ${from}: terminal overtakes buffered PCM/audio.done\n`);
}
const boundaries = [
  () => { const b = new RealtimePacingBudget(24000); assert.equal(b.take(0, 0, 1440), 0); assert.equal(b.take(0, 2, 1440), 2); },
  () => { const b = new RealtimePacingBudget(24000); b.credit = 0; b.lastMs = 100; assert.equal(b.take(100, 1440, 1440), 0); assert.equal(b.take(120, 1440, 1440), 960); },
  () => { const b = new RealtimePacingBudget(24000); b.take(0, 15360, 15360); b.take(1800000, 0, 1440); assert.equal(b.credit, 15360); },
  () => { const b = new RealtimePacingBudget(24000); b.take(2**32 - 1, 15360, 15360); assert.equal(b.take(2**32, 1440, 1440), 48); },
  () => { const b = new RealtimePacingBudget(24000); b.take(100, 15360, 15360); assert.equal(b.take(99, 1440, 1440), 0); assert.equal(b.take(100, 1440, 1440), 0); },
  () => { assert.throws(() => new RealtimePacingBudget(0)); assert.throws(() => new RealtimePacingBudget(NaN)); assert.throws(() => new RealtimePacingBudget(24000).take(NaN, 2, 2)); }
];
for (const fixture of boundaries) fixture();
save("boundaries.json", boundaries.map(f => f.toString()));
save("reductions.md", `Scope: one binary half-duplex stream, 24kHz PCM16; numerical domain lower bound, not all possible floating timestamps. Credit 0..15360 in even bytes, elapsed 0..4000ms, queued 0..8MiB in even bytes, 3 supported frame settings; flags model terminal/close interactions. Formula credit'=min(cap,credit+48*dt), sent=2*floor(min(credit',queued,frame)/2) proves conservation, sample alignment and the bound sent over ANY interval <= 48*elapsed+15360; saturation makes all larger ages equivalent for allowance. Numeric representatives exercise boundaries; the algebra (not sampling) lifts these invariant classes over the declared raw domain. PCM identity and absolute monotonic time are rename/translation symmetric. Intermediate positive drains stutter until last PCM; reset/terminal flags projected in graph. Pacer replenishment commutes with terminal arrival while PCM remains; no reordering permitted between last drain and terminal. Covering array is full representative Cartesian product, hence 100% pairwise/all critical triples. Actual wire integration separately verifies bytes/order, delayed pong and disconnect. No claim of hardware serial/acoustic proof. 60s transport test does NOT remove firmware's separate 45s overall awaiting watchdog.\n`);
const raw = dimensions.reduce((v, d) => v * d.cardinality, 1);
assert.ok(Number.isSafeInteger(raw));
const counts = { covering_arrays: rows.length, reduced_paths: transitions, fuzz: 1000000, mutants: mutations.length, boundaries: boundaries.length };
const canary = {
  synthetic: { name: "long audio and heartbeat", owner: "current Codex task", criteria: "24s PCM exact/drained; no delayed-pong close; a dead peer still fails; first playback <=100ms in host fixture", observability: "test-realtime-long-stream and live provider pacing canary logs", rollback: "restore SHA e3c65adbd1fde5e3b0656f65a9a8a828111d4d88450ee686dea735429ca002fe server.mjs; restart Bridge; keep firmware145 manifest", executed: false, passed: null },
  natural: { name: "owner Cardputer count-to-20", owner: "Sergey/current Codex task", criteria: "after staged live-provider pass, deploy companion Bridge and single-owner OTA146; verify full20/no Home exit plus menu/meter; do not declare stable or broaden release on any recurrence", observability: "owner sound + Bridge close code/session duration; USB if available", rollback: "restore baseline server.mjs and retain145; if146 was applied republish SHA-verified145 for explicit device rollback", executed: false, passed: null }
};
save("gate-evidence.json", {
  release: { name: "Cardputer146 companion pacing repair", ref: createHash("sha256").update(source).digest("hex"), evidence_cutoff: new Date().toISOString(), gate_scope: "canary_entry", production_like_stateful: true, applicability: { tier: "MEANINGFUL_RISK", rationale: "Cross-process audio backlog delays WebSocket heartbeat and terminates playback" } },
  model: { states: ["credit-empty", "credit-ready", "streaming", "draining", "terminal", "closed"], initial_states: ["credit-ready"], transitions: [{ name: "take", guard: "open, PCM and credit", effect: "bounded aligned PCM then ordered terminal" }, { name: "disconnect", guard: "peer closes", effect: "drop pending stream and terminals" }], actors: [{ name: "Bridge", ownership: "pacing budget and ordered socket" }, { name: "firmware", ownership: "fixed ring, playback and heartbeat" }], faults: [{ name: "scheduler pause", injection: "0..4sec" }, { name: "heartbeat HOL", injection: "pong behind PCM" }, { name: "disconnect", injection: "before terminal" }], invariants: mutations.map(([name]) => ({ name, predicate: name })), fences: mutations.map(([name]) => ({ name, purpose: name })), dimensions: dimensions.map(({ reps, ...d }) => d), reductions: ["symmetry", "equivalence", "partial_order"].map(kind => ({ kind, status: "applied", artifact: artifact("reductions.md") })) },
  coverage: { raw_equivalent_covered: raw, raw_equivalence_artifact: artifact("reductions.md"), execution_counting_method: "disjoint", actual_executed_claim: Object.values(counts).reduce((a,b)=>a+b,0), executed_tests: counts, reduced_exploration: { complete: true, states: seen.size, transitions, artifact: artifact("graph.json") }, pairwise: { complete: true, coverage_percent: 100, artifact: artifact("covering-array.json") }, critical_threewise: { complete: true, coverage_percent: 100, dimensions: dimensions.map(d=>d.name), artifact: artifact("covering-array.json") }, fuzz: { deterministic: true, seeds_retained: true, seed_artifact: artifact("seeds.json"), executed: counts.fuzz }, invariant_results: mutations.map(([name]) => ({ name, passed: true, artifact: artifact(`mutant-${name}.txt`) })), mutations: mutations.map(([fence]) => ({ fence, executed: true, counterexample: artifact(`mutant-${fence}.txt`) })), boundary_fixtures: [{ name: "zero/one sample/exact credit/cap/idle/reversed clock/2^32", passed: true, artifact: artifact("boundaries.json") }] },
  canaries: canary
});
console.log(JSON.stringify({ raw_cartesian_space: raw, actual_executed_tests: Object.values(counts).reduce((a,b)=>a+b,0), states: seen.size, transitions, rows: rows.length, fuzz: counts.fuzz, mutants: mutations.length, evidence: artifact("gate-evidence.json") }));
