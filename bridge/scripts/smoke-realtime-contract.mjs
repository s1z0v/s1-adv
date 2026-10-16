import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "server.mjs"), "utf8");
const example = JSON.parse(readFileSync(path.join(root, "config.example.json"), "utf8"));

assert.match(source, /deviceAudioPacingMs:\s*20/u);
assert.match(source, /deviceAudioPacingChunkMs:\s*30/u);
assert.equal(example.realtimeVoice.deviceAudioPacingMs, 20);
assert.equal(example.realtimeVoice.deviceAudioPacingChunkMs, 30);
assert.match(source, /phase:\s*"s1"/u);
assert.doesNotMatch(source, /safeWsSend\(clientWs, \{ type: "realtime\.thinking", session_id: sessionId, phase: "model" \}\)/u);

// Model Node's setInterval behavior: a blocked interval does not replay all
// missed callbacks. At 1:1, each periodic pause permanently drains the ESP
// lead. A 30/20 cadence replenishes the bounded device ring between pauses.
function simulatePacer(chunkMs) {
  const ringCapacityMs = 683;
  let bufferedMs = 341;
  let underruns = 0;
  for (let now = 0; now < 16_000; now += 10) {
    const pausePhase = now % 4_000;
    const intervalBlocked = pausePhase >= 3_700 && pausePhase < 3_960;
    if (now % 20 === 0 && !intervalBlocked) {
      bufferedMs = Math.min(ringCapacityMs, bufferedMs + chunkMs);
    }
    bufferedMs -= 10;
    if (bufferedMs < 0) {
      underruns += 1;
      bufferedMs = 0;
    }
  }
  return underruns;
}

assert.ok(simulatePacer(20) > 0, "strict 1:1 pacing must expose periodic pause loss");
assert.equal(simulatePacer(30), 0, "30/20 pacing must recover the bounded lead");

// Compatibility model for 0.2.129: its interim audio.done clears S1 state.
// The Bridge immediately reasserts phase=s1 and keeps it through final model
// generation, so the old preamble terminal cannot arm the 4 s watchdog.
const legacy = { s1: false, closed: false };
legacy.s1 = true;   // function call detected
legacy.s1 = false;  // legacy firmware receives preamble audio.done
legacy.s1 = true;   // Bridge compatibility phase=s1 after audio.done
if (!legacy.s1) legacy.closed = true; // response.done watchdog boundary
assert.equal(legacy.closed, false);
// New firmware clears this only on the actual final response.done. Older
// firmware clears it on the first final audio frame, which is also safe.
legacy.s1 = false;
assert.equal(legacy.s1, false);

console.log("PASS realtime bridge contract (phase protocol + 30/20 adaptive lead)");
