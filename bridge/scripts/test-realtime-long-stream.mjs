// Actual Bridge pacer, deterministic clock, finite ESP receive ring and the
// installed links2004/WebSockets heartbeat semantics. No provider/API calls.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import { performance } from "node:perf_hooks";
import { wireRealtimeBridge } from "../src/server.mjs";

const baseline = process.argv.includes("--expect-baseline-failure");
let now = 0, nextTimer = 0;
const timers = new Map();
mock.method(Date, "now", () => now);
mock.method(performance, "now", () => now);
mock.method(globalThis, "setInterval", (fn, period) => {
  const timer = { id: ++nextTimer, fn, period, due: now + period, unref() {} };
  timers.set(timer.id, timer); return timer;
});
mock.method(globalThis, "setTimeout", (fn, period) => {
  const timer = { id: ++nextTimer, fn, period: 0, due: now + period, unref() {} };
  timers.set(timer.id, timer); return timer;
});
for (const name of ["clearTimeout", "clearInterval"]) {
  mock.method(globalThis, name, timer => timers.delete(timer?.id));
}
class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; wire = [];
  send(data) {
    const frame = Buffer.isBuffer(data) ? data : JSON.parse(data);
    this.sent.push(frame); this.wire.push(frame);
  }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
}
const stepTimers = paused => {
  for (const timer of [...timers.values()]) {
    if (now < timer.due || paused) continue;
    if (timer.period) timer.due = now + timer.period; else timers.delete(timer.id);
    timer.fn();
  }
};

async function scenario({ seconds, paused = false, dropPongs = false }) {
  now = 0; timers.clear();
  const client = new Socket(), model = new Socket();
  await wireRealtimeBridge({ clientWs: client, modelWs: model,
    device: { device_id: "long-stream-host-test" }, topic: { topic_key: "host-test" },
    runtime: { appendAssistantReply: async () => {}, appendDeviceText: async () => {} },
    config: { realtimeVoice: { sampleRate: 24000, s1ToolsEnabled: false, maxSessionMs: 180000 } },
    binaryAudio: true, firmwareVersion: "0.2.145-dev", openModelSocket: async () => model });
  const total = seconds * 48000;
  const pcm = Buffer.alloc(total);
  for (let i = 0; i < pcm.length; ++i) pcm[i] = i & 255;
  let modelSent = false, pendingPongAt = null, lastPing = 0, pong = true, misses = 0;
  let played = 0, received = 0, ring = 0, playing = false, startedAt = null, closedAt = null;
  let maxQueued = 0, maxCallbackWaitMs = 0, terminal = false, expectedSeq = 0, underruns = 0;
  // 16 KiB firmware ring + the two 2 KiB speaker slots; playback starts at 4KiB.
  const capacity = 16384 + 4096;
  let partial = null, partialOffset = 8, partialStart = 0;
  for (now = 0; now < (seconds + 15) * 1000; now += 10) {
    if (now === 2000) {
      modelSent = true;
      model.emit("message", JSON.stringify({ type: "response.output_audio.delta", delta: pcm.toString("base64") }));
      model.emit("message", JSON.stringify({ type: "response.output_audio.done" }));
      model.emit("message", JSON.stringify({ type: "response.done", response: { status: "completed" } }));
      // response.done handler intentionally awaits history persistence.
      await Promise.resolve(); await Promise.resolve();
    }
    stepTimers(paused && now % 4000 >= 3700 && now % 4000 < 3960);
    if (pendingPongAt !== null && now >= pendingPongAt) {
      if (!dropPongs) client.wire.push({ pong: true });
      pendingPongAt = null;
    }
    if (playing) {
      const n = Math.min(480, ring); ring -= n; played += n;
      if (!ring && played < total) { playing = false; underruns++; }
    }
    if (!partial && client.wire.length) {
      const event = client.wire.shift();
      if (Buffer.isBuffer(event)) {
        assert.equal(event[0], 2); assert.equal(event.readUInt32LE(4), expectedSeq++);
        partial = event; partialOffset = 8; partialStart = now;
      } else if (event.pong) pong = true;
      else if (event.type === "response.done") terminal = true;
    }
    if (partial) {
      const n = Math.min(partial.length - partialOffset, capacity - ring);
      assert.ok(partial.subarray(partialOffset, partialOffset + n).equals(pcm.subarray(received, received + n)));
      partialOffset += n; received += n; ring += n;
      if (partialOffset === partial.length) {
        maxCallbackWaitMs = Math.max(maxCallbackWaitMs, now - partialStart); partial = null;
      }
    }
    if (!playing && (ring >= 4096 || (terminal && ring))) { playing = true; startedAt ??= now; }
    maxQueued = Math.max(maxQueued, client.wire.reduce((n, f) => n + (Buffer.isBuffer(f) ? f.length - 8 : 0), 0));
    // Library calls handleClientData -> handleHBPing -> handleHBTimeout.
    // While its data callback is waiting for speaker space it cannot see pong.
    if (!partial) {
      if (now - lastPing > 15000) { lastPing = now; pong = false; pendingPongAt = now + 80; }
      if (pong) misses = 0;
      else if (now - lastPing > 3000) {
        misses++; lastPing = now - 15000 - 500;
        if (misses >= 2) { closedAt = now; break; }
      }
    }
    if (modelSent && terminal && played === total) break;
  }
  client.close();
  return { seconds, paused, dropPongs, closedAt, played, total, received, terminal,
    firstPlaybackAfterAudioMs: startedAt === null ? null : startedAt - 2000,
    maxQueuedMs: maxQueued / 48, maxCallbackWaitMs, underruns };
}
try {
  for (const args of [{ seconds: 24 }, { seconds: 60 }, { seconds: 24, paused: true }]) {
    const result = await scenario(args);
    console.log(JSON.stringify(result));
    if (baseline) {
      assert.ok(result.maxQueuedMs > 3000, "baseline queues audio beyond the pong deadline");
      if (!args.paused) assert.ok(result.closedAt !== null, "baseline must reproduce heartbeat disconnect");
    }
    else {
      assert.equal(result.closedAt, null); assert.equal(result.played, result.total);
      assert.equal(result.received, result.total); assert.equal(result.terminal, true);
      assert.ok(result.firstPlaybackAfterAudioMs <= 100);
      assert.ok(result.maxQueuedMs < 500, "no seconds of hidden network audio");
      assert.equal(result.underruns, 0);
    }
  }
  if (!baseline) {
    const dead = await scenario({ seconds: 24, dropPongs: true });
    assert.ok(dead.closedAt >= 21000 && dead.closedAt < 22000, "real heartbeat failure still bounded");
    console.log(JSON.stringify(dead));
  }
  console.log(baseline ? "PASS baseline reproduces long-audio disconnect" : "PASS bounded long-audio integration");
} finally { mock.restoreAll(); }
