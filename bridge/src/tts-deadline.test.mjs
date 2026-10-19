import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

// Execute the production function with a controlled HTTP body and clock.
// No provider, credential or wall-clock timeout is needed for these cases.
const server = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const source = server.slice(server.indexOf("async function synthesizeOpenAiTtsPcm("),
  server.indexOf("\nfunction containsCyrillic("));

function fixture(fetch, error = async () => { throw new Error("provider failed"); }) {
  const timers = new Map();
  let cleared = 0;
  const context = vm.createContext({
    Buffer, AbortController, OPENAI_API_BASE: "https://provider.invalid/v1",
    openAiApiKey: () => "fixture-key", openAiHeaders: key => ({ Authorization: `Bearer ${key}` }),
    openAiError: error, fetch,
    setTimeout(callback, ms) { assert.ok(ms > 0); const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { assert.ok(timers.delete(id)); cleared++; }
  });
  const synthesize = vm.runInContext(`${source}\nsynthesizeOpenAiTtsPcm`, context);
  return { synthesize, timers, get cleared() { return cleared; } };
}
const request = { text: " Four. ", model: "tts-1", voice: "alloy", timeoutMs: 8000 };

test("TTS keeps the deadline armed until the whole PCM body arrives", async () => {
  let bodyDone;
  const f = fixture(async (url, options) => {
    assert.equal(url, "https://provider.invalid/v1/audio/speech");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { model: "tts-1", voice: "alloy", input: "Four.", response_format: "pcm" });
    return { ok: true, arrayBuffer: () => new Promise(resolve => { bodyDone = resolve; }) };
  });
  const pending = f.synthesize(request);
  await nextTurn();
  assert.equal(typeof bodyDone, "function");
  assert.equal(f.timers.size, 1, "receiving headers must not cancel the body deadline");
  bodyDone(Uint8Array.of(1, 2).buffer);
  assert.deepEqual(await pending, Buffer.from([1, 2]));
  assert.equal(f.timers.size, 0); assert.equal(f.cleared, 1);
});

test("a stalled PCM body is aborted by the same deadline as the headers", async () => {
  let bodyStarted = false;
  const f = fixture(async (_url, options) => ({ ok: true,
    arrayBuffer: () => new Promise((_resolve, reject) => {
      bodyStarted = true;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  }));
  const pending = f.synthesize(request);
  await nextTurn();
  assert.equal(bodyStarted, true); assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  await assert.rejects(pending, /OpenAI TTS timeout after 8000ms/);
  assert.equal(f.timers.size, 0); assert.equal(f.cleared, 1);
});

test("the deadline also covers a stalled provider error body", async () => {
  let signal;
  const f = fixture(async (_url, options) => { signal = options.signal; return { ok: false }; },
    async () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
  const pending = f.synthesize(request);
  await nextTurn();
  assert.equal(f.timers.size, 1); [...f.timers.values()][0]();
  await assert.rejects(pending, /OpenAI TTS timeout/);
  assert.equal(f.cleared, 1);
});

test("headers and body failures both release their timers", async () => {
  for (const failAt of ["headers", "body"]) {
    const f = fixture(async () => {
      if (failAt === "headers") throw new Error("socket failed");
      return { ok: true, async arrayBuffer() { throw new Error("socket failed"); } };
    });
    await assert.rejects(f.synthesize(request), /socket failed/);
    assert.equal(f.timers.size, 0); assert.equal(f.cleared, 1);
  }
});

test("empty input avoids HTTP; explicitly disabled timeout does not create a timer", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: true, async arrayBuffer() { return new ArrayBuffer(0); } }; });
  assert.equal((await f.synthesize({ ...request, text: " " })).length, 0);
  assert.equal(calls, 0); assert.equal(f.timers.size, 0);
  await f.synthesize({ ...request, timeoutMs: 0 });
  assert.equal(calls, 1); assert.equal(f.timers.size, 0); assert.equal(f.cleared, 0);
});
