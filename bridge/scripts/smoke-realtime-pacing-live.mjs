// Opt-in live provider canary. Run with the service environment, never print
// config/keys. No history, inbox, Telegram messages or real device actions.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { loadConfig, wireRealtimeBridge, openRealtimeModelSocket } from "../src/server.mjs";
const config = await loadConfig();
config.realtimeVoice.s1ToolsEnabled = false;
let requestedAt = 0, firstAt = 0, received = 0, expected = 0, sequence = 0;
let terminal = false, audioDone = false, played = 0, started = false, text = "", maxLeadMs = 0;
let lastTick = performance.now(), finished = false;
const modelHash = createHash("sha256"), deviceHash = createHash("sha256");
let resolveDone, rejectDone;
const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
class Device extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  send(raw) {
    if (finished) return;
    try {
      if (Buffer.isBuffer(raw)) {
        assert.ok(!terminal && !audioDone); assert.equal(raw[0], 2);
        assert.equal(raw.readUInt32LE(4), sequence++);
        const pcm = raw.subarray(8); assert.equal(pcm.length % 2, 0);
        firstAt ||= performance.now(); received += pcm.length; deviceHash.update(pcm);
        maxLeadMs = Math.max(maxLeadMs, received / 48 - (performance.now() - firstAt));
        return;
      }
      const event = JSON.parse(raw);
      if (event.type === "realtime.ready") {
        setImmediate(() => {
          requestedAt = performance.now();
          this.emit("message", Buffer.from(JSON.stringify({ type: "text.send", text: "Посчитай от одного до двадцати медленно, до конца, без вступления." })), false);
        });
      } else if (event.type === "audio.done") audioDone = true;
      else if (event.type === "response.done") {
        assert.ok(audioDone && received > 0); terminal = true; text = event.text || "";
      } else if (["realtime.error", "protocol_error", "realtime.closed"].includes(event.type)) {
        throw new Error(`canary failed: ${event.type} ${event.reason || event.message || ""}`);
      }
    } catch (error) { rejectDone(error); }
  }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
}
const client = new Device();
const timer = setInterval(() => {
  const now = performance.now(), elapsed = now - lastTick; lastTick = now;
  if (!started && received >= 4096) started = true;
  if (started) played = Math.min(received, played + elapsed * 48);
  if (terminal && played >= received) resolveDone();
}, 10);
const timeout = setTimeout(() => rejectDone(new Error("live pacing canary timeout")), 60000);
try {
  await wireRealtimeBridge({ clientWs: client, config, binaryAudio: true, firmwareVersion: "0.2.146-dev",
    device: { device_id: "pacing-canary" }, topic: { topic_key: "pacing-canary", title: "Pacing canary" },
    runtime: { appendAssistantReply: async () => {}, appendDeviceText: async () => {} },
    openModelSocket: async (cfg, topic, device) => {
      const ws = await openRealtimeModelSocket(cfg, topic, device);
      ws.on("message", raw => {
        const event = JSON.parse(raw);
        if (["response.output_audio.delta", "response.audio.delta"].includes(event.type)) {
          const pcm = Buffer.from(event.delta, "base64"); expected += pcm.length; modelHash.update(pcm);
        }
      });
      return ws;
    }
  });
  await done;
  assert.equal(received, expected); assert.equal(deviceHash.digest("hex"), modelHash.digest("hex"));
  assert.match(text, /двадцать|20/u); assert.ok(maxLeadMs <= 340, `lead exceeded: ${maxLeadMs}`);
  console.log(JSON.stringify({ canary: "PASS", model: config.realtimeVoice.model, pcm_bytes: received,
    audio_seconds: received / 48000, first_audio_ms: Math.round(firstAt - requestedAt),
    max_lead_ms: Math.round(maxLeadMs), transcript_ends_in_20: true, pcm_sha_equal: true,
    note: "live provider + actual Bridge; emulated speaker, not hardware verification" }));
} finally { finished = true; clearInterval(timer); clearTimeout(timeout); client.close(); }
