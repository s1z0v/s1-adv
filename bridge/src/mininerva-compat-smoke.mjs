import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { encodeMininervaFrame, decodeMininervaFrame } from "./mininerva-compat.mjs";
import { prepareFixtures } from "./fixtures.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WS_URL = "ws://127.0.0.1:31989/compat/mininerva/ws";
const TOPIC_B = "tg:root-main:default:-1001234567890:1984";

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

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:31989/healthz");
      if (response.ok) {
        return;
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
        reject(new Error("timed out waiting for compat event"));
      }
    }, 50);
  });
}

function openCompatSocket() {
  const events = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("message", (raw) => {
      const decoded = decodeMininervaFrame(raw);
      if (decoded) {
        events.push(decoded);
      }
    });
    ws.on("open", () => resolve({ ws, events }));
    ws.on("error", reject);
  });
}

await prepareFixtures();
await rm(resolve(ROOT, "tmp-smoke"), { recursive: true, force: true });

const mock = spawnManaged("node", ["src/mock-upstream.mjs"], {
  MOCK_UPSTREAM_PORT: "31990"
});
const bridge = spawnManaged("node", ["src/server.mjs"], {
  CARDPUTER_BRIDGE_CONFIG: "config.smoke.json"
});

try {
  console.log("stage: compat health");
  await waitForHealth();

  console.log("stage: compat connect");
  const { ws, events } = await openCompatSocket();
  ws.send(
    encodeMininervaFrame("auth", {
      device_id: "mininerva-dev",
      device_name: "Mininerva Test",
      version: "1.0.0",
      api_key: "dtk_demo_cardputer_test_only_00000000000000000001"
    })
  );

  const auth = await waitForEvent(events, (event) => event.type === "auth_response");
  assert.equal(auth.payload.success, true);
  await waitForEvent(events, (event) => event.type === "status");

  console.log("stage: compat topics");
  ws.send(
    encodeMininervaFrame("command", {
      command: "list_topics"
    })
  );
  const topicList = await waitForEvent(
    events,
    (event) => event.type === "command" && event.payload.command === "topics"
  );
  assert.equal(topicList.payload.topics.length, 2);

  console.log("stage: compat switch topic");
  ws.send(
    encodeMininervaFrame("command", {
      command: "switch_topic",
      topic_key: TOPIC_B
    })
  );
  const switched = await waitForEvent(
    events,
    (event) => event.type === "command" && event.payload.command === "switch_topic"
  );
  assert.equal(switched.payload.current_topic.topic_key, TOPIC_B);

  console.log("stage: compat ping");
  ws.send(
    encodeMininervaFrame("ping", {
      timestamp: Date.now()
    })
  );
  await waitForEvent(events, (event) => event.type === "pong");

  console.log("stage: compat text");
  ws.send(
    encodeMininervaFrame("text", {
      text: "compat smoke hello",
      device_id: "mininerva-dev"
    })
  );
  const response = await waitForEvent(
    events,
    (event) =>
      event.type === "response_final" && String(event.payload.text || "").includes("Echo: compat smoke hello")
  );
  assert.equal(response.payload.is_final, true);

  ws.close();
  console.log("mininerva compat smoke: ok");
} finally {
  bridge.kill("SIGTERM");
  mock.kill("SIGTERM");
  await sleep(200);
}
