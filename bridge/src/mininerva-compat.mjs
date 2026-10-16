import { WebSocketServer } from "ws";
import { makeId, nowIso, stripMarkdownForDevice } from "./utils.mjs";
import { isRecord, parseRequestUrl } from "./security-policy.mjs";

const CRC16_TABLE = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
  0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
  0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
  0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
  0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
  0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
  0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
  0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
  0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
  0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
  0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
  0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
  0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
  0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
  0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
  0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
  0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
  0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
  0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
  0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
  0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
  0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
  0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
  0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
  0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
  0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
  0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
  0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
  0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
  0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
  0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
  0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0
];

const MESSAGE_TYPE_TO_CODE = {
  auth: 0x01,
  auth_response: 0x02,
  ping: 0x03,
  pong: 0x04,
  text: 0x10,
  audio: 0x11,
  response: 0x12,
  response_final: 0x13,
  status: 0x20,
  command: 0x21,
  error: 0x22,
  audio_config: 0x30
};

const CODE_TO_MESSAGE_TYPE = Object.fromEntries(
  Object.entries(MESSAGE_TYPE_TO_CODE).map(([key, value]) => [value, key])
);

function calculateCRC16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff]) & 0xffff;
  }
  return crc;
}

export function decodeMininervaFrame(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length < 12) {
    return null;
  }
  const magic = bytes[0];
  const version = bytes[1];
  const typeCode = bytes[2];
  const payloadLength = bytes.readUInt16LE(4);
  const expectedLength = 10 + payloadLength + 2;
  if (magic !== 0x4f || version !== 1 || bytes.length < expectedLength) {
    return null;
  }
  const withoutCrc = bytes.subarray(0, 10 + payloadLength);
  const crc = bytes.readUInt16LE(10 + payloadLength);
  if (calculateCRC16(withoutCrc) !== crc) {
    return null;
  }
  const payloadBytes = bytes.subarray(10, 10 + payloadLength);
  let payload = {};
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    payload = { raw: payloadBytes.toString("base64") };
  }
  if (!isRecord(payload)) return null;
  return {
    type: CODE_TO_MESSAGE_TYPE[typeCode] || "unknown",
    payload,
    timestamp: bytes.readUInt32LE(6)
  };
}

export function encodeMininervaFrame(type, payload = {}, timestamp = Date.now()) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.alloc(10 + payloadBytes.length + 2);
  frame[0] = 0x4f;
  frame[1] = 1;
  frame[2] = MESSAGE_TYPE_TO_CODE[type] || 0xff;
  frame[3] = 0;
  frame.writeUInt16LE(payloadBytes.length, 4);
  frame.writeUInt32LE(timestamp >>> 0, 6);
  payloadBytes.copy(frame, 10);
  const crc = calculateCRC16(frame.subarray(0, 10 + payloadBytes.length));
  frame.writeUInt16LE(crc, 10 + payloadBytes.length);
  return frame;
}

function resolveCompatTopic(runtime, device, requestedTopicKey = "") {
  const configuredDevice = (runtime.config.devices || []).find(
    (candidate) => candidate.device_id === device.device_id
  );
  const allowlisted = device.topics || [];
  if (requestedTopicKey && allowlisted.includes(requestedTopicKey)) {
    const requestedTopic = runtime.store.getTopic(requestedTopicKey);
    if (requestedTopic) {
      return requestedTopic;
    }
  }
  const configuredDefault = configuredDevice?.default_topic_key || runtime.config.mininervaCompat?.defaultTopicKey;
  if (configuredDefault && allowlisted.includes(configuredDefault)) {
    return runtime.store.getTopic(configuredDefault);
  }
  const rankedTopics = allowlisted
    .map((topicKey) => runtime.store.getTopic(topicKey))
    .filter(Boolean)
    .sort((left, right) => {
      const leftHead = Number(left?.head_seq || 0);
      const rightHead = Number(right?.head_seq || 0);
      if (leftHead !== rightHead) {
        return rightHead - leftHead;
      }
      return String(left?.thread_id || "").localeCompare(String(right?.thread_id || ""));
    });
  const firstNonRoot = rankedTopics.find((topic) => String(topic.thread_id) !== "1");
  return firstNonRoot || rankedTopics[0] || runtime.store.getTopic(allowlisted[0] || "");
}

function listCompatTopics(runtime, device) {
  return runtime.store
    .listTopicsForDevice(device.device_id)
    .map((topic, index) => {
      const full = runtime.store.getTopic(topic.topic_key) || {};
      return {
        index: index + 1,
        topic_key: topic.topic_key,
        session_key: topic.session_key,
        title: full.title || topic.title || topic.topic_key,
        thread_id: full.thread_id || null,
        contour_id: full.contour_id || null,
        head_seq: topic.head_seq || 0,
        unread_count: topic.unread_count || 0
      };
    });
}

function compatTopicPayload(topic, index = null) {
  if (!topic) {
    return null;
  }
  return {
    index,
    topic_key: topic.topic_key,
    session_key: topic.session_key,
    title: topic.title,
    thread_id: topic.thread_id || null,
    contour_id: topic.contour_id || null,
    head_seq: topic.head_seq || 0
  };
}

function formatCompatTopicList(topics, currentTopicKey = "") {
  if (!topics.length) {
    return "No topics available.";
  }
  return topics
    .map((topic) => `${topic.topic_key === currentTopicKey ? "*" : " "} ${topic.index}. ${topic.title}`)
    .join("\n");
}

function resolveCompatTopicFromSelector(runtime, device, selector = "") {
  const trimmed = String(selector || "").trim();
  if (!trimmed) {
    return resolveCompatTopic(runtime, device, "");
  }

  const topics = listCompatTopics(runtime, device);
  const byIndex = Number.parseInt(trimmed, 10);
  if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= topics.length) {
    return runtime.store.getTopic(topics[byIndex - 1].topic_key);
  }

  return resolveCompatTopic(runtime, device, trimmed);
}

function sendCompatCommand(ws, payload) {
  ws.send(encodeMininervaFrame("command", payload));
}

function sendCompatResponse(ws, text, extra = {}) {
  ws.send(
    encodeMininervaFrame("response_final", {
      text: stripMarkdownForDevice(text),
      is_final: true,
      ...extra
    })
  );
}

function sendCompatTopics(ws, runtime, device, currentTopicKey) {
  const topics = listCompatTopics(runtime, device);
  sendCompatCommand(ws, {
    command: "topics",
    topics,
    current_topic_key: currentTopicKey
  });
  sendCompatResponse(ws, formatCompatTopicList(topics, currentTopicKey), {
    topic_key: currentTopicKey
  });
}

function sendCompatCurrentTopic(ws, runtime, device, currentTopicKey) {
  const topic = runtime.store.getTopic(currentTopicKey);
  const topics = listCompatTopics(runtime, device);
  const current = topics.find((item) => item.topic_key === currentTopicKey);
  sendCompatCommand(ws, {
    command: "current_topic",
    current_topic: compatTopicPayload(topic, current?.index || null)
  });
  if (topic) {
    sendCompatStatus(ws, `Current topic: ${topic.title}`, {
      topic_key: topic.topic_key
    });
  }
}

function switchCompatTopic(ws, runtime, selector = "") {
  const topic = resolveCompatTopicFromSelector(runtime, ws.compatSession.device, selector);
  if (!topic) {
    sendCompatError(ws, "unknown_topic", { selector });
    return false;
  }
  ws.compatSession.topicKey = topic.topic_key;
  ws.topicKey = topic.topic_key;
  sendCompatCommand(ws, {
    command: "switch_topic",
    current_topic: compatTopicPayload(topic)
  });
  sendCompatStatus(ws, `Switched to ${topic.title}`, {
    topic_key: topic.topic_key
  });
  return true;
}

function handleCompatSlashCommand(ws, runtime, text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }

  const parts = trimmed.split(/\s+/);
  const command = (parts[0] || "").toLowerCase();
  const rest = trimmed.slice(parts[0].length).trim();

  if (command === "/topics" || command === "/sessions") {
    sendCompatTopics(ws, runtime, ws.compatSession.device, ws.compatSession.topicKey);
    return true;
  }

  if (command === "/topic" || command === "/session") {
    if (!rest || rest === "current") {
      sendCompatCurrentTopic(ws, runtime, ws.compatSession.device, ws.compatSession.topicKey);
      return true;
    }
    switchCompatTopic(ws, runtime, rest);
    return true;
  }

  if (command === "/next") {
    const topics = listCompatTopics(runtime, ws.compatSession.device);
    const currentIndex = topics.findIndex((item) => item.topic_key === ws.compatSession.topicKey);
    const next = topics[(currentIndex + 1 + topics.length) % topics.length];
    if (next) {
      switchCompatTopic(ws, runtime, next.topic_key);
    }
    return true;
  }

  if (command === "/prev") {
    const topics = listCompatTopics(runtime, ws.compatSession.device);
    const currentIndex = topics.findIndex((item) => item.topic_key === ws.compatSession.topicKey);
    const prev = topics[(currentIndex - 1 + topics.length) % topics.length];
    if (prev) {
      switchCompatTopic(ws, runtime, prev.topic_key);
    }
    return true;
  }

  return false;
}

function sendCompatStatus(ws, status, extra = {}) {
  ws.send(encodeMininervaFrame("status", { status, ...extra }));
}

function sendCompatError(ws, error, extra = {}) {
  ws.send(encodeMininervaFrame("error", { error, ...extra }));
}

function forwardCompatEvent(ws, payload) {
  if (payload.type === "new_message") {
    const message = payload.message || {};
    if (message.sender?.kind === "assistant" && message.content?.kind === "text" && message.content.text) {
      ws.send(
        encodeMininervaFrame("response_final", {
          text: stripMarkdownForDevice(message.content.text),
          is_final: true,
          topic_key: payload.topic_key,
          message_id: message.id,
          seq: message.seq
        })
      );
      return;
    }
    return;
  }

  if (payload.type === "delivery_status" && ws.compatClientMsgIds?.has(payload.client_msg_id)) {
    if (payload.state === "failed") {
      sendCompatError(ws, payload.error || "delivery failed", {
        client_msg_id: payload.client_msg_id
      });
      return;
    }
    sendCompatStatus(ws, payload.state === "mirrored" ? "Delivered" : "Accepted", {
      client_msg_id: payload.client_msg_id,
      state: payload.state
    });
    return;
  }

  if (payload.type === "voice_message_ready") {
    sendCompatStatus(ws, "Voice available in native topic client", {
      media_id: payload.media_id,
      message_id: payload.message_id
    });
  }
}

export function createMininervaCompatServer({ runtime, config, recordAuthFailure = () => {}, clearAuthFailures = () => {} }) {
  const path = config.mininervaCompat?.path || "/compat/mininerva/ws";
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Number(config.security?.maxWsPayloadBytes) || 64 * 1024
  });

  wss.on("connection", (ws, req) => {
    runtime.clients.add(ws);
    ws.compatMode = "mininerva";
    ws.compatClientMsgIds = new Set();
    const authTimer = setTimeout(() => {
      if (ws.compatSession || ws.readyState !== 1) {
        return;
      }
      ws.send(encodeMininervaFrame("auth_response", { success: false, error: "Auth timeout" }));
      ws.close();
    }, Number(config.security?.wsAuthTimeoutMs) || 5000);
    ws.on("message", (raw) => { void (async () => {
      const frame = decodeMininervaFrame(raw);
      if (!frame) {
        recordAuthFailure(req, config);
        sendCompatError(ws, "invalid frame");
        ws.close(1008);
        return;
      }

      if (!ws.compatSession && frame.type !== "auth") {
        ws.send(encodeMininervaFrame("auth_response", { success: false, error: "Expected auth message" }));
        ws.close();
        return;
      }

      if (frame.type === "auth") {
        const device = runtime.store.findDeviceByToken(frame.payload.api_key || "");
        const requestedTopicKey = String(frame.payload.topic_key || "").trim();
        const topic = device ? resolveCompatTopic(runtime, device, requestedTopicKey) : null;
        if (!device || !topic) {
          recordAuthFailure(req, config);
          ws.send(encodeMininervaFrame("auth_response", { success: false, error: "Invalid API key" }));
          ws.close();
          return;
        }
        ws.compatSession = {
          id: makeId("mini"),
          device,
          topicKey: topic.topic_key
        };
        clearAuthFailures(req, config);
        clearTimeout(authTimer);
        ws.topicKey = topic.topic_key;
        ws.send(
          encodeMininervaFrame("auth_response", {
            success: true,
            session_id: ws.compatSession.id,
            topic_key: topic.topic_key,
            topic_title: topic.title,
            available_topics: listCompatTopics(runtime, device).length
          })
        );
        sendCompatStatus(ws, `Connected to ${topic.title}`);
        return;
      }

      if (frame.type === "ping") {
        ws.send(
          encodeMininervaFrame("pong", {
            ping_timestamp: frame.payload.timestamp || frame.timestamp || 0,
            timestamp: Date.now()
          })
        );
        return;
      }

      if (frame.type === "command") {
        const command = String(frame.payload.command || frame.payload.action || "").trim().toLowerCase();
        if (command === "list_topics" || command === "topics" || command === "list_sessions") {
          sendCompatTopics(ws, runtime, ws.compatSession.device, ws.compatSession.topicKey);
          return;
        }
        if (command === "current_topic" || command === "current_session" || command === "status") {
          sendCompatCurrentTopic(ws, runtime, ws.compatSession.device, ws.compatSession.topicKey);
          return;
        }
        if (command === "switch_topic" || command === "switch_session") {
          const selector = String(
            frame.payload.topic_key || frame.payload.topic_index || frame.payload.selector || ""
          ).trim();
          if (!selector) {
            sendCompatError(ws, "switch_topic_requires_selector");
            return;
          }
          switchCompatTopic(ws, runtime, selector);
          return;
        }
        sendCompatError(ws, `unsupported_command:${command || "empty"}`);
        return;
      }

      if (frame.type === "audio_config") {
        ws.compatAudioConfig = frame.payload;
        sendCompatStatus(ws, "Audio config received");
        return;
      }

      if (frame.type === "audio") {
        sendCompatError(ws, "voice_not_supported_in_compat_yet");
        return;
      }

      if (frame.type !== "text") {
        sendCompatError(ws, `unsupported_message_type:${frame.type}`);
        return;
      }

      const text = String(frame.payload.text || "").trim();
      if (!text) {
        return;
      }
      if (handleCompatSlashCommand(ws, runtime, text)) {
        return;
      }
      const requestedTopicKey = String(frame.payload.topic_key || "").trim();
      const requestedTopic = requestedTopicKey
        ? resolveCompatTopic(runtime, ws.compatSession.device, requestedTopicKey)
        : null;
      if (requestedTopic) {
        ws.compatSession.topicKey = requestedTopic.topic_key;
        ws.topicKey = requestedTopic.topic_key;
      }

      const clientMsgId = `mini:${ws.compatSession.id}:${Date.now()}`;
      ws.compatClientMsgIds.add(clientMsgId);
      sendCompatStatus(ws, "Sending...", { client_msg_id: clientMsgId });

      try {
        await runtime.sendText({
          device: ws.compatSession.device,
          topicKey: ws.compatSession.topicKey,
          clientMsgId,
          text
        });
      } catch (error) {
        sendCompatError(ws, String(error.message || error), {
          client_msg_id: clientMsgId,
          at: nowIso()
        });
      }
    })().catch(() => {
      if (ws.readyState === 1) { sendCompatError(ws, "invalid request"); ws.close(1008); }
    }); });

    ws.on("error", () => {
      clearTimeout(authTimer);
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      runtime.clients.delete(ws);
    });
  });

  return {
    path,
    handleUpgrade(req, socket, head) {
      const url = parseRequestUrl(req);
      if (url.pathname !== path) {
        return false;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return true;
    },
    forwardEvent: forwardCompatEvent
  };
}
