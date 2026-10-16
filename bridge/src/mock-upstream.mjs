import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";
import { prepareFixtures } from "./fixtures.mjs";
import { parseVisibleText, stripTelegramEnvelope } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.MOCK_UPSTREAM_HOST || "127.0.0.1";
const PORT = Number(process.env.MOCK_UPSTREAM_PORT || 31890);
const TOKEN = process.env.MOCK_UPSTREAM_TOKEN || "upstream-secret";

const TOPICS = [
  {
    topic_key: "tg:root-main:default:-1001234567890:323",
    session_key: "agent:main:telegram:group:-1001234567890:topic:323",
    title: "Помощник",
    thread_id: 323
  },
  {
    topic_key: "tg:root-main:default:-1001234567890:1984",
    session_key: "agent:main:telegram:group:-1001234567890:topic:1984",
    title: "Deploy",
    thread_id: 1984
  }
];

const topicBySession = new Map(TOPICS.map((topic) => [topic.session_key, topic]));
const state = {
  messages: Object.fromEntries(TOPICS.map((topic) => [topic.session_key, []])),
  subscribers: new Map(),
  lastSend: null
};

function nowIso() {
  return new Date().toISOString();
}

function topicTitleFor(topicId) {
  return TOPICS.find((topic) => topic.thread_id === Number(topicId))?.title || "Помощник";
}

function visibleTelegramText({ messageId, senderId = "123456789", sender = "Example User", topicId, body, audio = false }) {
  const topicTitle = topicTitleFor(topicId);
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify(
      {
        message_id: String(messageId),
        sender_id: String(senderId),
        conversation_label: `${topicTitle} id:-1001234567890 topic:${topicId}`,
        sender,
        timestamp: nowIso(),
        group_subject: "Помощник",
        thread_title: topicTitle,
        topic_id: String(topicId),
        is_forum: true,
        is_group_chat: true
      },
      null,
      2
    ),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify(
      {
        label: `${sender} (${senderId})`,
        id: String(senderId),
        name: sender
      },
      null,
      2
    ),
    "```",
    "",
    audio ? `[Audio]\nUser text:\n[Telegram topic:${topicId}] ${sender}: <media:audio>\nTranscript:\n${body}` : body
  ].join("\n");
}

function appendMessage(sessionKey, message, messageId = `up_${Date.now()}`) {
  state.messages[sessionKey].push(message);
  const subscribers = state.subscribers.get(sessionKey) || new Set();
  for (const ws of subscribers) {
    ws.send(
      JSON.stringify({
        type: "event",
        event: "session.message",
        payload: {
          sessionKey,
          messageId,
          message
        }
      })
    );
  }
}

function seed() {
  appendMessage(
    TOPICS[0].session_key,
    {
      role: "user",
      content: [{ type: "text", text: visibleTelegramText({ messageId: 1437, topicId: 323, body: "Need Cardputer bridge contract." }) }],
      timestamp: Date.now() - 5000
    },
    "1437"
  );
  appendMessage(
    TOPICS[0].session_key,
    {
      role: "assistant",
      content: [{ type: "text", text: "Bridge handoff is being prepared." }],
      timestamp: Date.now() - 4000
    },
    "a1"
  );
  appendMessage(
    TOPICS[1].session_key,
    {
      role: "user",
      content: [{ type: "text", text: visibleTelegramText({ messageId: 1501, topicId: 1984, body: "Check deploy status on the server." }) }],
      timestamp: Date.now() - 3000
    },
    "1501"
  );
}

seed();

const http = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/inject/text") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve) => req.on("end", resolve));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const topic = TOPICS.find((item) => item.topic_key === payload.topic_key) || TOPICS[0];
    appendMessage(
      topic.session_key,
      {
        role: "assistant",
        content: [{ type: "text", text: payload.text || "Injected assistant reply." }],
        timestamp: Date.now()
      }
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/inject/voice") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    await new Promise((resolve) => req.on("end", resolve));
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const topic = TOPICS.find((item) => item.topic_key === payload.topic_key) || TOPICS[0];
    appendMessage(
      topic.session_key,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: visibleTelegramText({
              messageId: 1900 + state.messages[topic.session_key].length,
              topicId: Number(topic.thread_id || topic.topic_key.split(":").at(-1)),
              body: "Incoming upstream voice transcript.",
              audio: true
            })
          }
        ],
        timestamp: Date.now()
      }
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/debug/last-send") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(state.lastSend || null));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http });
wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    const frame = JSON.parse(raw.toString("utf8"));
    if (frame.type !== "req") {
      return;
    }
    if (frame.method === "connect") {
      const ok = frame.params?.auth?.token === TOKEN;
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok,
          payload: ok
            ? {
                type: "hello-ok",
                protocol: 3,
                server: { version: "mock", connId: `conn_${Date.now()}` },
                features: {
                  methods: [
                    "chat.history",
                    "sessions.send",
                    "sessions.resolve",
                    "sessions.get",
                    "sessions.messages.subscribe"
                  ],
                  events: ["session.message"]
                },
                snapshot: { stateVersion: 1, ts: Date.now() },
                policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 30000 }
              }
            : undefined,
          error: ok ? undefined : { code: "AUTH", message: "bad token" }
        })
      );
      return;
    }
    if (frame.method === "sessions.messages.subscribe") {
      const key = frame.params.key;
      state.subscribers.set(key, state.subscribers.get(key) || new Set());
      state.subscribers.get(key).add(ws);
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { subscribed: true, key } }));
      return;
    }
    if (frame.method === "chat.history") {
      const messages = state.messages[frame.params.sessionKey] || [];
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { sessionKey: frame.params.sessionKey, messages: messages.slice(-(frame.params.limit || 200)) } }));
      return;
    }
    if (frame.method === "sessions.resolve") {
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true, key: frame.params.key } }));
      return;
    }
    if (frame.method === "sessions.get") {
      const topic = topicBySession.get(frame.params.key);
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            key: frame.params.key,
            title: topic?.title || "Помощник",
            origin: {
              thread_title: topic?.title || "Помощник",
              thread_id: topic?.thread_id || null
            },
            metadata: {
              conversation_label: `${topic?.title || "Помощник"} id:-1001234567890 topic:${topic?.thread_id || 0}`,
              thread_title: topic?.title || "Помощник"
            },
            messages: state.messages[frame.params.key] || []
          }
        })
      );
      return;
    }
    if (frame.method === "sessions.send") {
      const key = frame.params.key;
      const visibleText = stripTelegramEnvelope(parseVisibleText([{ type: "text", text: frame.params.message }]));
      state.lastSend = {
        key,
        message: frame.params.message,
        visibleText,
        recorded_at: nowIso()
      };
      const message = {
        role: "user",
        content: [{ type: "text", text: frame.params.message }],
        timestamp: Date.now()
      };
      appendMessage(key, message, frame.params.idempotencyKey || `m_${Date.now()}`);
      setTimeout(() => {
        appendMessage(
          key,
          {
            role: "assistant",
            content: [{ type: "text", text: `Echo: ${visibleText}` }],
            timestamp: Date.now()
          },
          `assistant_${Date.now()}`
        );
      }, 30);
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            runId: frame.params.idempotencyKey || `run_${Date.now()}`,
            messageSeq: state.messages[key].length
          }
        })
      );
      return;
    }
  });
  ws.on("close", () => {
    for (const subscribers of state.subscribers.values()) {
      subscribers.delete(ws);
    }
  });
});

await prepareFixtures();
http.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ host: HOST, port: PORT, token: TOKEN }, null, 2));
});
