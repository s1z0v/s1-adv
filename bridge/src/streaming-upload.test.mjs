import assert from "node:assert/strict";
import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { decodeVoiceUpload } from "./voice-upload-codec.mjs";
import { voiceReplyWaitMs } from "./turn-delivery-policy.mjs";
import { ensureDir, json } from "./utils.mjs";

// Real Node HTTP parsing and real temporary files execute the unchanged raw
// route and stream helper. STT and the model/outbox boundary are local spies;
// no Bridge/Gateway process, provider, credential or delivery is used. Full
// authentication/admission and durable dedup are covered by their own tests.
const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
function extract(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `production source missing: ${signature}`);
  let end = source.indexOf("{", start) + 1, depth = 1;
  while (depth) { depth += (source[end] === "{") - (source[end] === "}"); end++; }
  return source.slice(start, end);
}
const routeStart = source.indexOf('    if (req.method === "POST" && url.pathname === "/api/device-audio-turn-raw")');
const routeEnd = source.indexOf('    if (req.method === "POST" && url.pathname === "/api/device-tts")', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
const production = [
  extract("class RequestTooLargeError"), extract("function isRequestTooLarge("),
  extract("async function streamRequestToFile("), extract("function createWavHeader("),
  extract("function isTruthyHeader("),
  `async function route(req,res) { const url=new URL(req.url,"http://fixture.invalid"); ${source.slice(routeStart, routeEnd)} }`,
  "route"
].join("\n");

async function until(predicate, message) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(10); }
  assert.fail(message);
}

async function withRoute(t, run, { maxBytes = 1024, holdStt = false } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "s1-streaming-route-"));
  const calls = { stt: [], dispatch: [], errors: [], logs: [], headers: [] };
  let id = 0, releaseStt;
  const gate = new Promise(resolve => { releaseStt = resolve; });
  const topic = { topic_key: "fixture", session_key: "agent:fixture:stream" };
  const config = { maxUploadBytes: maxBytes, media: { tmpDir: tmp },
    omnibotShim: { voiceTurnWaitMs: 1000, turnWaitMs: 1000, turnPollMs: 10 } };
  const runtime = {
    async handleOmnibotCommand() { return null; },
    resolveTopicFromConversationKey() { return topic; },
    async tryFastLaneTurn() { return null; },
    buildDeviceTurnUpstreamText({ text }) { return text; },
    async sendText(input) { calls.dispatch.push(input); return { seq: 1, client_msg_id: input.clientMsgId }; },
    async waitForAssistantReply() { return { seq: 2, content: { text: "Fixture answer." } }; },
    async buildTurnResponse({ transcript, replyText }) { return { transcript, reply: replyText }; },
    async buildPendingTurnResponse() { throw new Error("unexpected pending path"); }
  };
  const context = vm.createContext({
    Buffer, URL, path, config, runtime, device: { device_id: "streaming-fixture" },
    createWriteStream, readFile, rm, once, ensureDir, decodeVoiceUpload, voiceReplyWaitMs, json,
    makeId: () => `fixture-${++id}`,
    console: { info: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args) },
    requestError: (res, code, error) => json(res, code, { error }),
    async transcribeDeviceAudio(_config, input) {
      calls.stt.push({ ...input, audioBytes: Buffer.from(input.audioBytes) });
      if (holdStt) await gate;
      return "Fixture transcript.";
    }
  });
  const route = vm.runInContext(production, context);
  const sockets = new Set();
  const server = createServer((req, res) => {
    calls.headers.push(req.headers);
    res.on("error", () => {});
    void route(req, res).catch(error => { calls.errors.push(error); res.destroy(); });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  t.after(async () => {
    releaseStt();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  });
  async function open() {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("error", () => {});
    socket.setTimeout(2500, () => socket.destroy());
    const closed = new Promise(resolve => socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8"))));
    await once(socket, "connect");
    socket.write("POST /api/device-audio-turn-raw HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n` +
      "Content-Type: application/octet-stream\r\nX-Audio-Sample-Rate: 16000\r\n" +
      "X-Client-Msg-Id: fixture-turn\r\nX-Turn-Id: fixture-turn\r\n\r\n");
    return { socket, closed, chunk(bytes) {
      socket.write(Buffer.concat([Buffer.from(bytes.length.toString(16) + "\r\n"), bytes, Buffer.from("\r\n")]));
    }, finish() { socket.write("0\r\n\r\n"); } };
  }
  async function storedBytes() {
    let bytes = 0;
    for (const file of await readdir(tmp)) { try { bytes += (await stat(path.join(tmp, file))).size; } catch (e) { if (e.code !== "ENOENT") throw e; } }
    return bytes;
  }
  try { await run({ open, calls, tmp, storedBytes, releaseStt }); }
  catch (error) { if (calls.errors.length) throw new AggregateError(calls.errors, "raw-route fixture failed", { cause: error }); throw error; }
  assert.deepEqual(calls.errors, []);
}

test("raw chunked upload spools before EOF but STT and dispatch wait for one valid final chunk", { timeout: 6000 }, t => withRoute(t, async ({ open, calls, tmp, storedBytes }) => {
  const req = await open(), first = Buffer.from([0, 1, 2, 3]), last = Buffer.from([4, 5, 6, 7, 8, 9]);
  req.chunk(first);
  await until(async () => await storedBytes() === first.length, "first PCM chunk was not spooled");
  await sleep(40);
  assert.equal(calls.stt.length, 0); assert.equal(calls.dispatch.length, 0);
  req.chunk(last);
  await until(async () => await storedBytes() === first.length + last.length, "final PCM tail was not spooled");
  assert.equal(calls.stt.length, 0); assert.equal(calls.dispatch.length, 0);
  req.finish();
  const response = await req.closed;
  assert.match(response, /^HTTP\/1\.1 200 /);
  assert.equal(calls.stt.length, 1); assert.equal(calls.dispatch.length, 1);
  const audio = calls.stt[0].audioBytes;
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.readUInt32LE(24), 16000); assert.equal(audio.readUInt16LE(22), 1);
  assert.equal(audio.readUInt16LE(34), 16); assert.equal(audio.readUInt32LE(40), 10);
  assert.deepEqual(audio.subarray(44), Buffer.concat([first, last]));
  assert.equal(calls.dispatch[0].clientMsgId, "fixture-turn");
  assert.equal(calls.dispatch[0].inputMode, "voice");
  assert.equal(calls.headers[0]["transfer-encoding"], "chunked");
  assert.equal(calls.headers[0]["content-length"], undefined);
  assert.deepEqual(await readdir(tmp), []);
}));

test("abort before zero chunk, including a truncated chunk, cleans temporary files without STT or dispatch", { timeout: 6000 }, t => withRoute(t, async ({ open, calls, tmp, storedBytes }) => {
  for (const truncated of [false, true]) {
    const req = await open();
    req.chunk(Buffer.from([1, 2, 3, 4]));
    await until(async () => await storedBytes() >= 4, "PCM did not reach temporary storage");
    if (truncated) req.socket.write("20\r\n1234");
    req.socket.destroy(); await req.closed;
    await until(async () => (await readdir(tmp)).length === 0, "aborted upload left a temporary file");
    assert.equal(calls.stt.length, 0); assert.equal(calls.dispatch.length, 0);
  }
}));

test("upload over the configured limit is rejected and cleaned before any speech or agent call", { timeout: 6000 }, t => withRoute(t, async ({ open, calls, tmp, storedBytes }) => {
  const req = await open(); req.chunk(Buffer.alloc(16));
  await until(async () => await storedBytes() === 16, "first bounded chunk was not spooled");
  req.chunk(Buffer.alloc(32)); req.finish();
  const response = await req.closed;
  assert.match(response, /^HTTP\/1\.1 413 /);
  await until(async () => (await readdir(tmp)).length === 0, "oversized upload left a temporary file");
  assert.equal(calls.stt.length, 0); assert.equal(calls.dispatch.length, 0);
}, { maxBytes: 32 }));

test("empty finalized upload is rejected without STT or dispatch", { timeout: 6000 }, t => withRoute(t, async ({ open, calls, tmp }) => {
  const req = await open(); req.finish();
  assert.match(await req.closed, /^HTTP\/1\.1 400 /);
  assert.equal(calls.stt.length, 0); assert.equal(calls.dispatch.length, 0);
  assert.deepEqual(await readdir(tmp), []);
}));

test("disconnect after valid EOF does not retract an accepted turn, so a lost response must not auto-retry", { timeout: 6000 }, t => withRoute(t, async ({ open, calls, tmp, releaseStt }) => {
  const req = await open();req.chunk(Buffer.alloc(8));req.finish();
  await until(() => calls.stt.length === 1, "valid upload did not enter STT");
  assert.equal(calls.dispatch.length, 0);assert.deepEqual(await readdir(tmp), []);
  req.socket.destroy();await req.closed;releaseStt();
  await until(() => calls.dispatch.length === 1, "accepted turn unexpectedly vanished on response disconnect");
}, { holdStt: true }));
