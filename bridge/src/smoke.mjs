import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { prepareFixtures } from "./fixtures.mjs";
import { StateStore } from "./state-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const HTTP_BASE = "http://127.0.0.1:31989";
const WS_URL = "ws://127.0.0.1:31989/api/cardputer/v1/stream";
const AUTH = "Bearer dtk_demo_cardputer_test_only_00000000000000000001";
const TOPIC_A = "tg:root-main:default:-1001234567890:323";
const TOPIC_B = "tg:root-main:default:-1001234567890:1984";

function authHeaders() {
  return { Authorization: AUTH, "X-Admin-Token": "test-only-admin-token-00000000000000000000000001" };
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${HTTP_BASE}/healthz`, {headers: authHeaders()});
      const health = await response.json();
      if (response.ok && health.upstream_connected) {
        const topics = await (await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {headers: authHeaders()})).json();
        if (topics.items?.some(item => item.title === "Deploy") && topics.items?.some(item => item.title === "Помощник")) return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("bridge healthz did not become ready");
}

function waitForEvent(events, predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for event"));
      }
    }, 50);
  });
}

function openSocket(topicKey, fromSeq = 1, token = "dtk_demo_cardputer_test_only_00000000000000000001") {
  const events = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString("utf8"))));
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "connect",
          protocol: "cardputer-feed.v1",
          device_id: "cpadv-dev",
          device_token: token,
          topic_key: topicKey,
          from_seq: fromSeq,
          capabilities: {
            audio_upload: ["wav_pcm16_16k_mono"],
            audio_playback: ["wav_pcm16_16k_mono"]
          }
        })
      );
      resolve({ ws, events });
    });
    ws.on("error", reject);
  });
}

function spawnManaged(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

await prepareFixtures();
await rm(resolve(ROOT, "tmp-smoke"), { recursive: true, force: true });

console.log("stage: authoritative device authorization state");
const authStateDir = resolve(ROOT, "tmp-smoke/auth-state");
await mkdir(authStateDir, { recursive: true });
await writeFile(
  resolve(authStateDir, "state.json"),
  JSON.stringify({
    devices: {
      "cpadv-dev": {
        device_id: "cpadv-dev",
        device_token: "dtk_stale_token",
        topics: [TOPIC_A, TOPIC_B],
        default_topic_key: TOPIC_B,
        current_topic_key: TOPIC_B
      },
      "cpadv-removed": {
        device_id: "cpadv-removed",
        device_token: "dtk_removed_token",
        topics: [TOPIC_B]
      }
    },
    topics: {
      [TOPIC_A]: { topic_key: TOPIC_A, title: "Allowed" },
      [TOPIC_B]: { topic_key: TOPIC_B, title: "Stale" }
    },
    messages: {},
    media: {},
    idempotency: {},
    read_state: {},
    device_events: {}
  })
);
const authState = new StateStore({
  stateDir: authStateDir,
  devices: [{
    device_id: "cpadv-dev",
    device_token: "dtk_rotated_token",
    topics: [TOPIC_A],
    default_topic_key: TOPIC_A
  }],
  topics: [{ topic_key: TOPIC_A, title: "Allowed" }]
});
await authState.load();
assert.equal(authState.findDeviceByToken("dtk_stale_token"), undefined);
assert.equal(authState.findDeviceByToken("dtk_removed_token"), undefined);
assert.equal(authState.findDeviceByToken("dtk_rotated_token")?.device_id, "cpadv-dev");
assert.deepEqual(authState.getDevice("cpadv-dev")?.topics, [TOPIC_A]);
assert.equal(authState.getDevice("cpadv-dev")?.default_topic_key, TOPIC_A);
assert.equal(authState.getDevice("cpadv-dev")?.current_topic_key, TOPIC_A);

await mkdir(resolve(ROOT, "tmp-smoke/state/assets/cardputer_adv/audio/focus"), { recursive: true });
await copyFile(resolve(ROOT, "fixtures/voice.wav"), resolve(ROOT, "tmp-smoke/state/assets/cardputer_adv/audio/focus/start-focus-ru.wav"));
await mkdir(resolve(ROOT, "tmp-smoke/state/firmware/cardputer_adv"), { recursive: true });
await writeFile(resolve(ROOT, "tmp-smoke/state/firmware/cardputer_adv/cardputer-adv-0.2.1-dev.bin"), Buffer.from("cardputer firmware smoke\n"));
await writeFile(
  resolve(ROOT, "tmp-smoke/state/firmware/cardputer_adv/manifest.json"),
  JSON.stringify({
    version: "0.2.1-dev",
    channel: "dev",
    filename: "cardputer-adv-0.2.1-dev.bin",
    min_battery: 40,
    confirm_required: true,
    built_at: "2026-04-30T00:00:00Z",
    build_git_sha: "smoke"
  }, null, 2)
);

const mock = spawnManaged("node", ["src/mock-upstream.mjs"], {
  MOCK_UPSTREAM_PORT: "31990"
});
const bridge = spawnManaged("node", ["src/server.mjs"], {
  CARDPUTER_BRIDGE_CONFIG: "config.smoke.json"
});

try {
  console.log("stage: health");
  await waitForHealth();

  console.log("stage: live-runtime OTA enqueue fence");
  const otaUnauthorizedRes = await fetch(`${HTTP_BASE}/internal/cardputer/ota-install`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.1-dev", min_battery: 25 })
  });
  assert.equal(otaUnauthorizedRes.status, 404);
  const otaWrongVersionRes = await fetch(`${HTTP_BASE}/internal/cardputer/ota-install`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.0-dev", min_battery: 25 })
  });
  assert.equal(otaWrongVersionRes.status, 409);
  const otaRes = await fetch(`${HTTP_BASE}/internal/cardputer/ota-install`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.1-dev", min_battery: 25 })
  });
  const ota = await otaRes.json();
  assert.equal(otaRes.status, 200);
  assert.equal(ota.ok, true);
  assert.match(String(ota.event_id || ""), /^ota-install:cpadv-dev:0\.2\.1-dev:/u);
  const otaPendingRes = await fetch(`${HTTP_BASE}/api/cardputer/device-events/pending`, {
    headers: authHeaders()
  });
  const otaPending = await otaPendingRes.json();
  assert.equal(otaPending.items[0]?.event_id, ota.event_id);
  assert.equal(otaPending.items[0]?.priority, "urgent");

  console.log("stage: topics");
  const topicsRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, { headers: authHeaders() });
  const topics = await topicsRes.json();
  assert.equal(topics.type, "topics_page");
  assert.equal(topics.items.length, 2);
  assert.deepEqual(
    topics.items.map((item) => item.title).sort(),
    ["Deploy", "Помощник"]
  );

  console.log("stage: assets manifest");
  const assetsRes = await fetch(`${HTTP_BASE}/api/cardputer/assets/manifest`, { headers: authHeaders() });
  const manifest = await assetsRes.json();
  assert.equal(manifest.device, "cardputer_adv");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 1);
  assert.equal(manifest.files[0].path, "/pomodoro/audio/focus/start-focus-ru.wav");
  const assetsUnauthorizedRes = await fetch(`${HTTP_BASE}/api/cardputer/assets/manifest`);
  assert.equal(assetsUnauthorizedRes.status, 401);

  console.log("stage: firmware manifest");
  const firmwareRes = await fetch(`${HTTP_BASE}/api/cardputer/firmware/manifest`, { headers: authHeaders() });
  const firmwareManifest = await firmwareRes.json();
  assert.equal(firmwareManifest.device, "cardputer_adv");
  assert.equal(firmwareManifest.version, "0.2.1-dev");
  assert.ok(String(firmwareManifest.firmware_url || "").endsWith("/api/cardputer/firmware/file/cardputer-adv-0.2.1-dev.bin"));
  assert.ok(/^[a-f0-9]{64}$/u.test(firmwareManifest.sha256));
  const firmwareUnauthorizedRes = await fetch(`${HTTP_BASE}/api/cardputer/firmware/manifest`);
  assert.equal(firmwareUnauthorizedRes.status, 401);

  console.log("stage: firmware file");
  const firmwareFileRes = await fetch(firmwareManifest.firmware_url, { headers: authHeaders() });
  assert.equal(firmwareFileRes.status, 200);
  assert.equal(firmwareFileRes.headers.get("content-type"), "application/octet-stream");
  const firmwareBytes = Buffer.from(await firmwareFileRes.arrayBuffer());
  assert.equal(firmwareBytes.length, firmwareManifest.size);

  console.log("stage: asset file");
  const assetRes = await fetch(manifest.files[0].url, { headers: authHeaders() });
  assert.equal(assetRes.status, 200);
  assert.equal(assetRes.headers.get("content-type"), "audio/wav");
  const assetBytes = Buffer.from(await assetRes.arrayBuffer());
  assert.equal(assetBytes.length, manifest.files[0].size);

  console.log("stage: logs");
  const logsRes = await fetch(`${HTTP_BASE}/api/cardputer/logs`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      device_id: "spoofed-device",
      received_at: "1970-01-01T00:00:00.000Z",
      firmware_version: "0.2.0-dev",
      events: [{ ts: 1, level: "info", message: "VOICE upload ok" }]
    })
  });
  assert.equal(logsRes.status, 204);
  const deviceLogs = (await readFile(resolve(ROOT, "tmp-smoke/state/logs/cpadv-dev.jsonl"), "utf8"))
    .trim()
    .split("\n");
  const deviceLog = JSON.parse(deviceLogs.at(-1));
  assert.equal(deviceLog.device_id, "cpadv-dev");
  assert.notEqual(deviceLog.received_at, "1970-01-01T00:00:00.000Z");

  console.log("stage: inbox inject disabled");
  const inboxInjectRes = await fetch(
    `${HTTP_BASE}/api/cardputer/v1/topics/${encodeURIComponent(TOPIC_A)}/inbox/inject`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify({ text: "must stay disabled", sender_kind: "assistant" })
    }
  );
  assert.equal(inboxInjectRes.status, 404);

  console.log("stage: history");
  const historyRes = await fetch(
    `${HTTP_BASE}/api/cardputer/v1/topics/${encodeURIComponent(TOPIC_A)}/history?limit=10`,
    { headers: authHeaders() }
  );
  const history = await historyRes.json();
  assert.equal(history.type, "history_page");
  assert.ok(history.items.length >= 2);
  assert.ok(history.items.every((item, idx, arr) => idx === 0 || arr[idx - 1].seq < item.seq));

  console.log("stage: ws connect A");
  const { ws: wsA, events: eventsA } = await openSocket(TOPIC_A, 1);
  await waitForEvent(eventsA, (event) => event.type === "connected");
  await waitForEvent(eventsA, (event) => event.type === "new_message");

  console.log("stage: send text");
  const sendAckRes = await fetch(
    `${HTTP_BASE}/api/cardputer/v1/topics/${encodeURIComponent(TOPIC_A)}/messages`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        client_msg_id: "cli_smoke_text",
        text: "hello from bridge smoke"
      })
    }
  );
  const sendAck = await sendAckRes.json();
  assert.equal(sendAck.type, "ack");
  assert.equal(sendAck.client_msg_id, "cli_smoke_text");
  console.log("stage: wait delivery");
  await waitForEvent(eventsA, (event) => event.type === "delivery_status" && event.client_msg_id === "cli_smoke_text");

  console.log("stage: device text turn");
  const deviceTurnRes = await fetch(`${HTTP_BASE}/api/device-text-turn`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({
      device_id: "cpadv-dev",
      message: "what topic am I in?"
    })
  });
  const deviceTurn = await deviceTurnRes.json();
  assert.equal(deviceTurn.status, "success");
  assert.ok(String(deviceTurn.reply || "").includes("Echo: what topic am I in?"));
  const lastSendRes = await fetch("http://127.0.0.1:31990/debug/last-send");
  const lastSend = await lastSendRes.json();
  assert.ok(String(lastSend?.message || "").includes("\"recent_topics_overview\""));
  assert.ok(String(lastSend?.message || "").includes("\"available_topics\""));
  assert.ok(String(lastSend?.message || "").includes("\"current_topic\""));

  console.log("stage: resend");
  const resendRes = await fetch(
    `${HTTP_BASE}/api/cardputer/v1/topics/${encodeURIComponent(TOPIC_A)}/messages`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        client_msg_id: "cli_smoke_text",
        text: "hello from bridge smoke changed"
      })
    }
  );
  const resendAck = await resendRes.json();
  assert.equal(resendAck.message_id, sendAck.message_id);
  assert.equal(resendAck.seq, sendAck.seq);

  wsA.close();
  await sleep(100);

  console.log("stage: replay");
  const { ws: wsReplay, events: replayEvents } = await openSocket(TOPIC_A, sendAck.seq);
  await waitForEvent(replayEvents, (event) => event.type === "connected");
  const replay = await waitForEvent(
    replayEvents,
    (event) => event.type === "new_message" && event.message?.seq === sendAck.seq
  );
  assert.equal(replay.message.client_msg_id, "cli_smoke_text");
  wsReplay.close();

  console.log("stage: voice upload");
  const { wav } = await prepareFixtures();
  const voiceBytes = await readFile(wav);
  const form = new FormData();
  form.set("client_msg_id", "cli_smoke_voice");
  form.set("duration_ms", "1200");
  form.set("file", new Blob([voiceBytes], { type: "audio/wav" }), "voice.wav");
  console.log("stage: ws connect B");
  const { ws: wsB, events: eventsB } = await openSocket(TOPIC_B, 1);
  await waitForEvent(eventsB, (event) => event.type === "connected");
  const voiceRes = await fetch(
    `${HTTP_BASE}/api/cardputer/v1/topics/${encodeURIComponent(TOPIC_B)}/voice`,
    {
      method: "POST",
      headers: authHeaders(),
      body: form
    }
  );
  const voiceAck = await voiceRes.json();
  assert.equal(voiceAck.type, "ack");
  await waitForEvent(eventsB, (event) => event.type === "voice_message_ready" && event.message_id === voiceAck.message_id);

  console.log("stage: inject incoming voice");
  await fetch("http://127.0.0.1:31990/inject/voice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic_key: TOPIC_B })
  });
  const incomingVoice = await waitForEvent(eventsB, (event) => event.type === "voice_message_ready" && event.message_id !== voiceAck.message_id);
  const mediaRes = await fetch(`${HTTP_BASE}${incomingVoice.download.url}`, { headers: authHeaders() });
  assert.equal(mediaRes.status, 200);
  const mediaBytes = await mediaRes.arrayBuffer();
  assert.ok(mediaBytes.byteLength > 0);

  wsB.close();
  await sleep(100);

  console.log("stage: reconnect_required");
  const { ws: wsReconnect, events: reconnectEvents } = await openSocket(TOPIC_B, 999999);
  const reconnectRequired = await waitForEvent(reconnectEvents, (event) => event.type === "reconnect_required");
  assert.equal(reconnectRequired.reason, "HISTORY_RESET");
  wsReconnect.close();

  console.log("stage: auth_error");
  const { ws: wsAuth, events: authEvents } = await openSocket(TOPIC_A, 1, "bad-token");
  const authError = await waitForEvent(authEvents, (event) => event.type === "auth_error");
  assert.equal(authError.code, "DEVICE_REVOKED");
  wsAuth.close();

  console.log("stage: auth failure rate limit");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const invalidRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {
      headers: { Authorization: "Bearer bad-token" }
    });
    assert.equal(invalidRes.status, 401);
  }
  const limitedRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {
    headers: { Authorization: "Bearer bad-token" }
  });
  assert.equal(limitedRes.status, 429);
  const recoveredRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {
    headers: authHeaders()
  });
  assert.equal(recoveredRes.status, 200);
  assert.equal(recoveredRes.headers.get("cache-control"), "no-store");

  console.log("stage: forwarded auth identity cannot be prefix-spoofed");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const invalidRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {
      headers: {
        Authorization: "Bearer bad-token",
        "x-forwarded-for": `198.51.100.${attempt + 1}, 203.0.113.99`
      }
    });
    assert.equal(invalidRes.status, 401);
  }
  const forwardedLimitedRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {
    headers: {
      Authorization: "Bearer bad-token",
      "x-forwarded-for": "198.51.100.250, 203.0.113.99"
    }
  });
  assert.equal(forwardedLimitedRes.status, 429);
  const forwardedRecoveredRes = await fetch(`${HTTP_BASE}/api/cardputer/v1/topics`, {
    headers: {
      ...authHeaders(),
      "x-forwarded-for": "198.51.100.251, 203.0.113.99"
    }
  });
  assert.equal(forwardedRecoveredRes.status, 200);

  const persistedState = JSON.parse(await readFile(resolve(ROOT, "tmp-smoke/state/state.json"), "utf8"));
  assert.ok(
    persistedState.device_events?.["cpadv-dev"]?.some((event) => event.event_id === ota.event_id),
    "OTA event must survive subsequent live-runtime saves"
  );

  console.log("bridge smoke: ok");
} finally {
  bridge.kill("SIGTERM");
  mock.kill("SIGTERM");
  await sleep(200);
}
