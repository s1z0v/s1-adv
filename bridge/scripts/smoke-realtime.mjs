import fs from "node:fs/promises";
import WebSocket from "ws";

const configPath = process.argv[2] || "config.json";
const bridgeUrl = process.env.CARDPUTER_BRIDGE_REALTIME_URL || "wss://bridge.example.com/api/cardputer/v1/realtime";
const smokeText = process.env.CARDPUTER_REALTIME_SMOKE_TEXT || "Say one short word: ready.";
const smokeTimeoutMs = Math.max(5000, Number(process.env.CARDPUTER_REALTIME_SMOKE_TIMEOUT_MS) || 30000);
const useBinaryAudio = process.env.CARDPUTER_REALTIME_BINARY === "1";
const sendBinaryConnect = process.env.CARDPUTER_REALTIME_BINARY_CONNECT === "1";
const sendBinaryInput = process.env.CARDPUTER_REALTIME_BINARY_INPUT === "1";
const binaryInputPcmPath = process.env.CARDPUTER_REALTIME_INPUT_PCM || "";
if (sendBinaryInput && !useBinaryAudio) {
  throw new Error("CARDPUTER_REALTIME_BINARY_INPUT requires CARDPUTER_REALTIME_BINARY=1");
}
if (sendBinaryInput && !binaryInputPcmPath) {
  throw new Error("CARDPUTER_REALTIME_BINARY_INPUT requires CARDPUTER_REALTIME_INPUT_PCM");
}
const binaryInputPcm = sendBinaryInput ? await fs.readFile(binaryInputPcmPath) : null;

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const device = config.devices?.[0];
if (!device?.device_id || !device?.device_token) {
  throw new Error("config missing first device credentials");
}

const topic =
  config.topics?.find((item) => item.topic_key && item.title === "Bridge") ||
  config.topics?.find((item) => item.topic_key) ||
  null;
if (!topic?.topic_key) {
  throw new Error("config missing topic");
}

function makeBinaryAudioFrame(type, sequence, pcm) {
  const frame = Buffer.allocUnsafe(8 + pcm.length);
  frame[0] = type;
  frame[1] = 1;
  frame.writeUInt16LE(0, 2);
  frame.writeUInt32LE(sequence >>> 0, 4);
  pcm.copy(frame, 8);
  return frame;
}

const ws = new WebSocket(bridgeUrl);
const deadline = Date.now() + smokeTimeoutMs;
const startedAt = Date.now();
let connectedAt = 0;
let readyAt = 0;
let requestAt = 0;
let firstAudioAt = 0;
let audioTransport = "";
let ready = false;
let gotAudio = false;
let gotDone = false;
let gotAudioDone = false;
let responseDoneEvent = null;
let timer = null;
let audioBytes = 0;
let lastAudioAt = 0;
let audioDoneAt = 0;
const strictOrder = process.env.CARDPUTER_REALTIME_STRICT_ORDER === "1";

function finishIfComplete() {
  if (!responseDoneEvent || !gotAudioDone || gotDone) {
    return;
  }
  gotDone = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  console.log(JSON.stringify({
    ok: true,
    ready,
    gotAudio,
    text: responseDoneEvent.text || "",
    connect_transport: sendBinaryConnect ? "binary-json" : "text-json",
    audio_transport: audioTransport,
    audio_bytes: audioBytes,
    audio_seconds: audioBytes / 48000,
    terminal_order: audioDoneAt >= lastAudioAt ? "PCM -> audio.done -> response.done" : "invalid",
    request: smokeText,
    latency_ms: {
      bridge_connected: connectedAt > 0 ? connectedAt - startedAt : null,
      realtime_ready: readyAt > 0 ? readyAt - startedAt : null,
      first_audio: firstAudioAt > 0 && requestAt > 0 ? firstAudioAt - requestAt : null,
      response_done: requestAt > 0 ? Date.now() - requestAt : null
    }
  }, null, 2));
  ws.close();
}

function sendJson(payload, options) {
  ws.send(JSON.stringify(payload), options);
}

ws.on("open", () => {
  sendJson({
    type: "connect",
    device_id: device.device_id,
    device_token: device.device_token,
    firmware_version: process.env.CARDPUTER_REALTIME_FIRMWARE_VERSION || "0.2.125-dev",
    firmware_git: "smoke",
    topic_key: topic.topic_key,
    sample_rate: 24000,
    binary_audio: useBinaryAudio
  }, sendBinaryConnect ? { binary: true } : undefined);
});

ws.on("message", (raw, isBinary) => {
  if (isBinary) {
    if (strictOrder && responseDoneEvent) throw new Error("PCM after response.done");
    if (raw.length <= 8 || raw[0] !== 0x02 || raw[1] !== 1 || ((raw.length - 8) & 1) !== 0) {
      throw new Error("invalid binary audio frame");
    }
    // A tool-backed response can contain a short pre-tool audio segment and a
    // second final audio segment. A new PCM frame starts a new completion
    // boundary, so do not let the first audio.done finish the smoke early.
    gotAudioDone = false;
    gotAudio = true;
    audioBytes += raw.length - 8;
    lastAudioAt = Date.now();
    if (firstAudioAt === 0) {
      firstAudioAt = Date.now();
    }
    return;
  }
  const event = JSON.parse(raw.toString("utf8"));
  const type = event.type || "";
  if (type === "connected") {
    connectedAt = Date.now();
    audioTransport = event.audio_transport || "";
    return;
  }
  if (type === "realtime.ready") {
    ready = true;
    readyAt = Date.now();
    if (sendBinaryInput) {
      const speechBytes = binaryInputPcm.length;
      const pcm = Buffer.concat([binaryInputPcm, Buffer.alloc(24000 * 2 * 0.7)]);
      let sequence = 0;
      let offset = 0;
      const sendNext = () => {
        if (offset >= pcm.length) {
          return;
        }
        if (requestAt === 0 && offset >= speechBytes) {
          requestAt = Date.now();
        }
        ws.send(makeBinaryAudioFrame(0x01, sequence, pcm.subarray(offset, offset + 1920)));
        sequence += 1;
        offset += 1920;
        setTimeout(sendNext, 40);
      };
      sendNext();
    } else {
      requestAt = Date.now();
      sendJson({ type: "text.send", text: smokeText });
    }
    return;
  }
  if (type === "audio.delta") {
    gotAudio = true;
    audioBytes += Buffer.from(event.audio || event.delta || "", "base64").length;
    lastAudioAt = Date.now();
    if (firstAudioAt === 0) {
      firstAudioAt = Date.now();
    }
    return;
  }
  if (type === "audio.done") {
    gotAudioDone = true;
    audioDoneAt = Date.now();
    finishIfComplete();
    return;
  }
  if (type === "response.done") {
    if (strictOrder && !gotAudioDone) throw new Error("response.done before audio.done");
    responseDoneEvent = event;
    finishIfComplete();
    return;
  }
  if (type === "realtime.error" || type === "auth_error" || type === "protocol_error") {
    console.error(JSON.stringify(event, null, 2));
    process.exitCode = 1;
    ws.close();
  }
});

ws.on("close", () => {
  if (!gotDone && process.exitCode !== 1) {
    console.error(JSON.stringify({ ok: false, ready, gotAudio, reason: "closed_before_done" }, null, 2));
    process.exitCode = 1;
  }
});

ws.on("error", (error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});

timer = setInterval(() => {
  if (Date.now() < deadline) {
    return;
  }
  clearInterval(timer);
  if (!gotDone) {
    console.error(JSON.stringify({ ok: false, ready, gotAudio, reason: "timeout" }, null, 2));
    process.exitCode = 1;
    ws.close();
  }
}, 250);
