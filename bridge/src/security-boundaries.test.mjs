import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { encodeMininervaFrame } from "./mininerva-compat.mjs";
import { agentIdForSession, validateDeviceTokens, validateUpstreamTransport } from "./security-policy.mjs";
import { StateStore } from "./state-store.mjs";
import { BridgeRuntime, transcode } from "./server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const token = "test-only-device-token-00000000000000000000000000000001";

async function withBridge(run, security = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pulseos-security-"));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = JSON.parse(await readFile(path.join(root, "config.example.json"), "utf8"));
  config.server.port = port;
  config.stateDir = path.join(tmp, "state");
  config.media = Object.fromEntries(["inboundDir", "canonicalDir", "playbackDir", "tmpDir"].map(key => [key, path.join(tmp, key)]));
  config.assets.rootDir = path.join(tmp, "assets");
  config.assets.logsDir = path.join(tmp, "logs");
  config.firmware.rootDir = path.join(tmp, "firmware");
  config.upstream.url = "ws://127.0.0.1:1";
  config.upstream.token = "test-only-gateway-token-00000000000000000000000000001";
  config.devices[0].device_token = token;
  config.security = { ...config.security, ...security };
  const configPath = path.join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root, env: { ...process.env, CARDPUTER_BRIDGE_CONFIG: configPath }, stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", chunk => { log = (log + chunk).slice(-12000); });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-12000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(`bridge exited during startup: ${log}`);
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch {}
      if (ready) break;
      await sleep(50);
    }
    assert.ok(ready, `bridge not ready: ${log}`);
    await run({ base, port, child, token, config });
    await sleep(75);
    assert.equal(child.exitCode, null, `bridge crashed: ${log}`);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
    await rm(tmp, { recursive: true, force: true });
  }
}

async function sendWs(base, route, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http:", "ws:") + route, options);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("websocket timeout")); }, 2500);
    ws.on("open", () => { if (payload !== undefined) ws.send(payload); });
    ws.on("message", () => ws.close());
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); res.resume(); resolve(res.statusCode); });
    ws.on("close", () => { clearTimeout(timer); resolve(101); });
    ws.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

test("unauthenticated null feed frame cannot crash the bridge", () => withBridge(async ({ base }) => {
  await sendWs(base, "/api/cardputer/v1/stream", "null");
}));

test("unauthenticated null compatibility payload cannot crash the bridge", () => withBridge(async ({ base }) => {
  await sendWs(base, "/compat/mininerva/ws", encodeMininervaFrame("auth", null));
}));

test("malformed Host on upgrade cannot crash the bridge", () => withBridge(async ({ port }) => {
  await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(
      "GET /api/cardputer/v1/stream HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ));
    socket.on("data", () => {});
    socket.on("close", resolve);
    socket.on("error", reject);
    socket.setTimeout(2500, () => socket.destroy());
  });
}));

test("browser origins are denied on every WebSocket route by default", () => withBridge(async ({ base }) => {
  for (const route of ["/api/cardputer/v1/stream", "/api/cardputer/v1/realtime", "/compat/mininerva/ws"]) {
    assert.equal(await sendWs(base, route, undefined, { origin: "https://untrusted.example" }), 403);
  }
}));

test("internal OTA is disabled by default, including through a proxy", () => withBridge(async ({ base, token }) => {
  for (const headers of [{}, { "x-forwarded-for": "203.0.113.1", "x-forwarded-proto": "https" }]) {
    const response = await fetch(`${base}/internal/cardputer/ota-install`, {
      method: "POST", headers: { ...headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "0.2.1-dev" })
    });
    assert.equal(response.status, 404);
  }
}));

test("even enabled internal OTA rejects forwarded requests", () => withBridge(async ({ base, token }) => {
  const response = await fetch(`${base}/internal/cardputer/ota-install`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.1" }, body: "{}"
  });
  assert.equal(response.status, 404);
}, { internalOtaEnabled: true }));

test("compatibility authentication failures share the normal rate limit", () => withBridge(async ({ base }) => {
  for (let i = 0; i < 5; i++) {
    await sendWs(base, "/compat/mininerva/ws", encodeMininervaFrame("auth", { api_key: "wrong" }));
  }
  assert.equal(await sendWs(base, "/compat/mininerva/ws", undefined), 429);
}, { authFailureLimit: 5 }));

test("unauthenticated WebSocket connection count is bounded", () => withBridge(async ({ base }) => {
  const sockets = [];
  try {
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(base.replace("http:", "ws:") + "/api/cardputer/v1/stream");
      sockets.push(ws);
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    }
    assert.equal(await sendWs(base, "/compat/mininerva/ws", undefined), 429);
  } finally { for (const ws of sockets) ws.terminate(); }
}, { maxWsConnectionsPerIp: 2 }));

test("costly authenticated requests have a rate limit", () => withBridge(async ({ base, token }) => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${base}/api/device-tts`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}"
    })).status, 400);
  }
  assert.equal((await fetch(`${base}/api/device-tts`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}"
  })).status, 429);
}, { requestStartLimitPerDevice: 5 }));

test("placeholder, duplicate and gateway-reused device credentials are rejected", () => {
  for (const value of ["", "12345678", "REPLACE_WITH_RANDOM_DEVICE_TOKEN"]) {
    assert.throws(() => validateDeviceTokens({ devices: [{ device_token: value }] }));
  }
  assert.throws(() => validateDeviceTokens({ devices: [{ device_token: token }], upstream: { token } }));
  assert.throws(() => validateDeviceTokens({ devices: [{ device_token: token }, { device_token: token }] }));
  validateDeviceTokens({ devices: [{ device_token: token }], upstream: { token: "different" } });
});

test("remote gateway credentials require TLS", () => {
  for (const url of ["ws://remote.example:18789", "http://127.0.0.1:18789", "wss://user:pass@remote.example"]) {
    assert.throws(() => validateUpstreamTransport({ upstream: { url } }));
  }
  for (const url of ["ws://127.0.0.1:18789", "ws://[::1]:18789", "wss://remote.example"]) {
    validateUpstreamTransport({ upstream: { url } });
  }
});

test("session creation and firmware jobs preserve the configured agent", () => withBridge(async ({ config }) => {
  config.topics[0].session_key = "agent:cardputer:isolated";
  config.upstream.deviceIdentityPath = path.join(config.stateDir, "test-upstream-device.json");
  const runtime = new BridgeRuntime(config);
  let created;
  runtime.upstream.rpc = async (_method, params) => { created = params; };
  await runtime.ensureUpstreamSessionForTopic(config.topics[0], { forceCreate: true });
  assert.equal(created.agentId, "cardputer");
  runtime.registerRuntimeTopic = () => {};
  const job = await runtime.createFirmwareJobTopicForDevice(runtime.store.getDevice("cardputer-adv-01"));
  assert.equal(agentIdForSession(job.session_key), "cardputer");
}));

test("a config session remap revokes cached history and old media", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pulseos-remap-"));
  try {
    const config = { stateDir: tmp, devices: [{ device_id: "d", device_token: token, topics: ["t"] }],
      topics: [{ topic_key: "t", session_key: "agent:main:old" }] };
    const old = new StateStore(config);
    old.appendMessage("t", { id: "old-private-message", content: { text: "old private data" } });
    old.state.media.old = { topic_key: "t" };
    old.state.device_events.d = [{ event_id: "old", topic_key: "t" }];
    await old.save();
    config.topics[0].session_key = "agent:cardputer:new";
    const current = new StateStore(config);
    await current.load();
    assert.equal(current.getTopic("t").session_key, "agent:cardputer:new");
    assert.equal(current.state.messages.t.length, 0);
    assert.equal(current.state.media.old, undefined);
    assert.equal(current.state.device_events.d.length, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("uploaded playlists cannot make FFmpeg fetch internal URLs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pulseos-media-"));
  let requested = false;
  const { createServer } = await import("node:http");
  const target = createServer((_req, res) => { requested = true; res.end("private"); });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  try {
    const inputPath = path.join(tmp, "upload.wav");
    await writeFile(inputPath, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${target.address().port}/private\n#EXT-X-ENDLIST\n`);
    await assert.rejects(transcode({ inputPath, outputPath: path.join(tmp, "out.wav"), args: ["-ac", "1"] }));
    assert.equal(requested, false);
  } finally { await new Promise(resolve => target.close(resolve)); await rm(tmp, { recursive: true, force: true }); }
});
