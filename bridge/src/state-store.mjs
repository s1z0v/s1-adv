import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { nowIso, readJsonFile, writeJsonAtomic } from "./utils.mjs";

function isGenericTopicTitle(value = "") {
  return /^Помощник(?:\s*\/\s*\d+|\s+id:-?\d+\s+topic:\d+)?$/u.test(String(value || "").trim());
}

function parseTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function lastMessageActivityMs(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    const parsed = parseTimeMs(item?.updated_at || item?.created_at);
    if (parsed > 0) {
      return parsed;
    }
  }
  return 0;
}

function readNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.floor(parsed));
}

function secretsEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""), "utf8");
  const rightBytes = Buffer.from(String(right || ""), "utf8");
  return leftBytes.length > 0 &&
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}

function collectMediaIds(value, refs = new Set()) {
  if (!value || typeof value !== "object") {
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMediaIds(item, refs);
    }
    return refs;
  }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "media_id" || key === "playback_media_id") && typeof item === "string" && item) {
      refs.add(item);
      continue;
    }
    collectMediaIds(item, refs);
  }
  return refs;
}

function parseTelegramTopicKey(topicKey = "") {
  const match = String(topicKey || "").match(/^tg:[^:]+:[^:]+:(-?\d+):(\d+)$/u);
  if (!match) {
    return null;
  }
  return {
    chat_id: match[1],
    thread_id: Number(match[2])
  };
}

function initialState(config) {
  const devices = Object.fromEntries(
    (config.devices || []).map((device) => [
      device.device_id,
      {
        device_id: device.device_id,
        device_token: device.device_token,
        topics: [...(device.topics || [])],
        default_topic_key: device.default_topic_key || device.topics?.[0] || null,
        current_topic_key: device.default_topic_key || device.topics?.[0] || null,
        revoked_at: null,
        created_at: nowIso()
      }
    ])
  );
  const topics = Object.fromEntries(
    (config.topics || []).map((topic) => [
      topic.topic_key,
      {
        ...topic,
        head_seq: 0,
        inbound_scan_cursor_ms: 0
      }
    ])
  );
  return {
    devices,
    topics,
    messages: {},
    media: {},
    idempotency: {},
    read_state: {},
    device_events: {}
  };
}

export class StateStore {
  constructor(config) {
    this.config = config;
    this.filePath = path.join(config.stateDir, "state.json");
    this.state = initialState(config);
    this.saveTail = Promise.resolve();
  }

  async load() {
    const defaults = initialState(this.config);
    this.state = await readJsonFile(this.filePath, defaults);
    this.state.devices ||= {};
    this.state.topics ||= {};
    this.state.messages ||= {};
    this.state.media ||= {};
    this.state.idempotency ||= {};
    this.state.read_state ||= {};
    this.state.device_events ||= {};

    // Device identities are an authorization boundary.  Treat the deployed
    // config as authoritative so removing a device or rotating its token does
    // not leave the previous credential active in the persisted state file.
    const configuredDeviceIds = new Set(Object.keys(defaults.devices));
    for (const deviceId of Object.keys(this.state.devices)) {
      if (!configuredDeviceIds.has(deviceId)) {
        delete this.state.devices[deviceId];
      }
    }

    for (const [deviceId, defaultDevice] of Object.entries(defaults.devices)) {
      const existing = this.state.devices[deviceId] || {};
      const configuredTopics = [...new Set(defaultDevice.topics || [])]
        .filter((topicKey) => defaults.topics[topicKey] || this.state.topics[topicKey]);
      const retainedTopics = this.config.security?.retainPersistedDeviceTopics === true
        ? (existing.topics || []).filter(
            (topicKey) => defaults.topics[topicKey] || this.state.topics[topicKey]
          )
        : [];
      const topics = [...new Set([...configuredTopics, ...retainedTopics])];
      const defaultTopicKey = [
        defaultDevice.default_topic_key,
        existing.default_topic_key,
        topics[0] || null
      ].find((topicKey) => topicKey && topics.includes(topicKey)) || null;
      const currentTopicKey =
        existing.current_topic_key && topics.includes(existing.current_topic_key)
          ? existing.current_topic_key
          : defaultTopicKey;
      this.state.devices[deviceId] = {
        ...defaultDevice,
        ...existing,
        device_id: deviceId,
        device_token: defaultDevice.device_token || "",
        topics,
        default_topic_key: defaultTopicKey,
        current_topic_key: currentTopicKey
      };
      this.state.device_events[deviceId] ||= [];
    }

    for (const [topicKey, defaultTopic] of Object.entries(defaults.topics)) {
      const existing = this.state.topics[topicKey] || {};
      if (existing.session_key && existing.session_key !== defaultTopic.session_key) {
        // A config remap revokes the old session and its cached conversation.
        this.state.messages[topicKey] = [];
        for (const [key, media] of Object.entries(this.state.media)) {
          if (media.topic_key === topicKey) delete this.state.media[key];
        }
        for (const key of Object.keys(this.state.idempotency)) {
          if (key.startsWith(`${topicKey}::`)) delete this.state.idempotency[key];
        }
        for (const [id, events] of Object.entries(this.state.device_events)) {
          this.state.device_events[id] = events.filter(event => event.topic_key !== topicKey);
        }
        existing.head_seq = 0;
        existing.inbound_scan_cursor_ms = 0;
      }
      const preferDefaultTitle =
        defaultTopic.title &&
        (!existing.title || isGenericTopicTitle(existing.title) || !isGenericTopicTitle(defaultTopic.title));
      this.state.topics[topicKey] = {
        ...defaultTopic,
        ...existing,
        session_key: defaultTopic.session_key,
        chat_id: defaultTopic.chat_id,
        thread_id: defaultTopic.thread_id,
        title: preferDefaultTitle ? defaultTopic.title : existing.title,
        emoji: existing.emoji || defaultTopic.emoji || defaultTopic.icon || null,
        icon: existing.icon || defaultTopic.icon || defaultTopic.emoji || null
      };
    }

    for (const topicKey of Object.keys(this.state.topics)) {
      this.state.messages[topicKey] ||= [];
    }
    this.compact();
  }

  async save() {
    // Concurrent ACKs and terminal receipts must not rename an older snapshot
    // over a newer durable outbox state. Capture state when each write runs.
    const write = async () => {
      this.compact();
      await writeJsonAtomic(this.filePath, this.state);
    };
    const saved = this.saveTail.then(write, write);
    this.saveTail = saved.catch(() => {});
    await saved;
  }

  compact() {
    const maxMessagesPerTopic = Math.max(50, Number(this.config.state?.maxMessagesPerTopic) || 250);
    for (const [topicKey, messages] of Object.entries(this.state.messages || {})) {
      if (!Array.isArray(messages)) {
        this.state.messages[topicKey] = [];
        continue;
      }
      if (messages.length > maxMessagesPerTopic) {
        this.state.messages[topicKey] = messages.slice(-maxMessagesPerTopic);
      }
    }

    const referencedMediaIds = collectMediaIds(this.state.messages || {});
    const maxUnreferencedMediaEntries = readNonNegativeInt(
      this.config.state?.maxUnreferencedMediaEntries,
      120
    );
    const mediaEntries = Object.entries(this.state.media || {});
    const unreferencedMediaEntries = [];
    const compactedMedia = {};
    for (const [mediaId, media] of mediaEntries) {
      if (referencedMediaIds.has(mediaId)) {
        compactedMedia[mediaId] = media;
      } else {
        unreferencedMediaEntries.push([mediaId, media]);
      }
    }
    if (maxUnreferencedMediaEntries > 0) {
      for (const [mediaId, media] of unreferencedMediaEntries.slice(-maxUnreferencedMediaEntries)) {
        compactedMedia[mediaId] = media;
      }
    }
    this.state.media = compactedMedia;

    const maxIdempotencyEntries = Math.max(100, Number(this.config.state?.maxIdempotencyEntries) || 1000);
    const idempotencyEntries = Object.entries(this.state.idempotency || {});
    if (idempotencyEntries.length > maxIdempotencyEntries) {
      idempotencyEntries.sort((left, right) => {
        const leftTime = parseTimeMs(left[1]?.accepted_at);
        const rightTime = parseTimeMs(right[1]?.accepted_at);
        return rightTime - leftTime;
      });
      this.state.idempotency = Object.fromEntries(idempotencyEntries.slice(0, maxIdempotencyEntries));
    }

    const maxDeviceEvents = Math.max(20, Number(this.config.state?.maxDeviceEventsPerDevice) || 100);
    for (const [deviceId, events] of Object.entries(this.state.device_events || {})) {
      if (!Array.isArray(events)) {
        this.state.device_events[deviceId] = [];
        continue;
      }
      const pending = events.filter((event) => !event.acked_at);
      const acked = events.filter((event) => event.acked_at).slice(-Math.floor(maxDeviceEvents / 2));
      this.state.device_events[deviceId] = [...acked, ...pending].slice(-maxDeviceEvents);
    }
  }

  findDeviceByToken(token) {
    return Object.values(this.state.devices).find(
      (device) => secretsEqual(device.device_token, token) && !device.revoked_at
    );
  }

  getDevice(deviceId) {
    return this.state.devices[deviceId] || null;
  }

  getCurrentTopicKey(deviceId) {
    const device = this.state.devices[deviceId];
    if (!device) {
      return null;
    }
    const allowlisted = Array.isArray(device.topics) ? device.topics : [];
    const preferred = [
      device.current_topic_key,
      device.default_topic_key,
      allowlisted[0] || null
    ].find((topicKey) => topicKey && allowlisted.includes(topicKey) && this.state.topics[topicKey]);
    if (!preferred) {
      return null;
    }
    if (device.current_topic_key !== preferred) {
      device.current_topic_key = preferred;
    }
    return preferred;
  }

  setCurrentTopicKey(deviceId, topicKey) {
    const device = this.state.devices[deviceId];
    if (!device || !topicKey || !device.topics.includes(topicKey) || !this.state.topics[topicKey]) {
      return false;
    }
    device.current_topic_key = topicKey;
    return true;
  }

  getTopic(topicKey) {
    return this.state.topics[topicKey] || null;
  }

  setTopicTitle(topicKey, title) {
    const topic = this.state.topics[topicKey];
    if (!topic || typeof title !== "string") {
      return false;
    }
    const normalized = title.trim();
    if (!normalized) {
      return false;
    }
    topic.title = normalized;
    return true;
  }

  findTopicByTelegram(chatId, threadId) {
    const chat = String(chatId || "");
    const thread = Number(threadId || 0);
    if (!chat || !thread) {
      return null;
    }
    return Object.values(this.state.topics).find(
      (topic) => {
        const parsed = parseTelegramTopicKey(topic.topic_key);
        return String(topic.chat_id || parsed?.chat_id || "") === chat &&
          Number(topic.thread_id || parsed?.thread_id || 0) === thread;
      }
    ) || null;
  }

  upsertTopic(topic) {
    const topicKey = String(topic?.topic_key || "").trim();
    if (!topicKey) {
      return null;
    }
    const existing = this.state.topics[topicKey] || {};
    const incomingTitle = typeof topic.title === "string" ? topic.title.trim() : "";
    const currentTitle = typeof existing.title === "string" ? existing.title.trim() : "";
    const title =
      incomingTitle && (!currentTitle || isGenericTopicTitle(currentTitle))
        ? incomingTitle
        : currentTitle || incomingTitle || "Topic";
    const updatedAt =
      topic.updated_at ||
      topic.last_activity_at ||
      existing.updated_at ||
      existing.last_activity_at ||
      null;
    const parsed = parseTelegramTopicKey(topicKey);
    this.state.topics[topicKey] = {
      ...existing,
      ...topic,
      topic_key: topicKey,
      title,
      display_title: topic.display_title || existing.display_title || title,
      short_title: topic.short_title || existing.short_title || title,
      emoji: topic.emoji || existing.emoji || topic.icon || existing.icon || null,
      icon: topic.icon || existing.icon || topic.emoji || existing.emoji || null,
      chat_id: topic.chat_id || existing.chat_id || parsed?.chat_id,
      thread_id: topic.thread_id || existing.thread_id || parsed?.thread_id,
      head_seq: existing.head_seq || topic.head_seq || 0,
      inbound_scan_cursor_ms: existing.inbound_scan_cursor_ms || topic.inbound_scan_cursor_ms || 0,
      updated_at: updatedAt,
      last_activity_at: updatedAt
    };
    this.state.messages[topicKey] ||= [];
    return this.state.topics[topicKey];
  }

  ensureDeviceTopic(deviceId, topicKey) {
    const device = this.state.devices[deviceId];
    if (!device || !topicKey || !this.state.topics[topicKey]) {
      return false;
    }
    device.topics ||= [];
    if (!device.topics.includes(topicKey)) {
      device.topics.push(topicKey);
      if (!device.default_topic_key) {
        device.default_topic_key = topicKey;
      }
      if (!device.current_topic_key) {
        device.current_topic_key = topicKey;
      }
      return true;
    }
    return false;
  }

  topicLastActivityMs(topicKey) {
    const topic = this.state.topics[topicKey];
    if (!topic) {
      return 0;
    }
    return Math.max(
      parseTimeMs(topic.last_activity_at),
      parseTimeMs(topic.updated_at),
      parseTimeMs(topic.created_at),
      lastMessageActivityMs(this.state.messages[topicKey] || [])
    );
  }

  listTopicsForDevice(deviceId, options = {}) {
    const device = this.state.devices[deviceId];
    if (!device) {
      return [];
    }
    const currentTopicKey = this.getCurrentTopicKey(deviceId);
    const sinceMs = Number(options.sinceMs || 0);
    const minRecent = Math.max(0, Number(options.minRecent || 0));
    let rows = device.topics
      .map((topicKey, originalIndex) => ({ topic: this.state.topics[topicKey], originalIndex }))
      .filter(Boolean)
      .filter(({ topic }) => Boolean(topic))
      .map(({ topic, originalIndex }) => {
        const parsed = parseTelegramTopicKey(topic.topic_key);
        const lastActivityMs = this.topicLastActivityMs(topic.topic_key);
        const lastActivityAt = lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : null;
        return {
          topic_key: topic.topic_key,
          session_key: topic.session_key,
          title: topic.title,
          display_title: topic.display_title || topic.title,
          short_title: topic.short_title || topic.title,
          emoji: topic.emoji || topic.icon || null,
          chat_id: topic.chat_id || parsed?.chat_id,
          thread_id: topic.thread_id || parsed?.thread_id,
          contour_id: topic.contour_id,
          unread_count: Math.max(
            0,
            (this.state.messages[topic.topic_key] || []).filter((item) => item.sender?.kind !== "device").length
          ),
          head_seq: topic.head_seq || 0,
          last_activity_at: lastActivityAt,
          updated_at: topic.updated_at || lastActivityAt,
          current: topic.topic_key === currentTopicKey,
          default: topic.topic_key === device.default_topic_key,
          original_index: originalIndex
        };
      });
    if (sinceMs > 0) {
      const recentRows = rows.filter((row) => {
        const activityMs = parseTimeMs(row.last_activity_at || row.updated_at);
        return row.current || row.default || activityMs >= sinceMs;
      });
      if (recentRows.length >= minRecent) {
        rows = recentRows;
      }
    }
    if (options.sortByActivity !== false) {
      rows.sort((left, right) => {
        const activityDelta =
          parseTimeMs(right.last_activity_at || right.updated_at) -
          parseTimeMs(left.last_activity_at || left.updated_at);
        if (activityDelta !== 0) {
          return activityDelta;
        }
        return Number(left.original_index || 0) - Number(right.original_index || 0);
      });
    }
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      rows = rows.slice(0, Math.max(1, Math.floor(options.limit)));
    }
    return rows.map(({ original_index: _originalIndex, ...row }) => row);
  }

  getHistory(topicKey, beforeSeq, limit) {
    const items = [...(this.state.messages[topicKey] || [])];
    const filtered = beforeSeq > 0 ? items.filter((item) => item.seq < beforeSeq) : items;
    const page = filtered.slice(Math.max(0, filtered.length - limit));
    return {
      type: "history_page",
      topic_key: topicKey,
      head_seq: this.state.topics[topicKey]?.head_seq || 0,
      next_before_seq: page.length > 0 ? page[0].seq : null,
      items: page
    };
  }

  getIdempotent(topicKey, clientMsgId) {
    return this.state.idempotency[`${topicKey}::${clientMsgId}`] || null;
  }

  setIdempotent(topicKey, clientMsgId, ack) {
    this.state.idempotency[`${topicKey}::${clientMsgId}`] = ack;
  }

  findMessageByUpstream(topicKey, upstreamMessageId) {
    return (this.state.messages[topicKey] || []).find(
      (item) => item.source?.upstream_message_id === upstreamMessageId
    );
  }

  findLikelyOutboundDuplicate(topicKey, normalized) {
    return (this.state.messages[topicKey] || []).find((item) => {
      if (item.sender.kind !== "device" || item.deleted_at) {
        return false;
      }
      if (item.content.kind !== normalized.content.kind) {
        return false;
      }
      if (normalized.content.kind === "text") {
        return item.content.text === normalized.content.text;
      }
      return item.content.voice?.duration_ms === normalized.content.voice?.duration_ms;
    });
  }

  findRecentDeviceText(topicKey, text, sinceMs) {
    return [...(this.state.messages[topicKey] || [])]
      .reverse()
      .find((item) => {
        if (item.sender?.kind !== "device" || item.deleted_at || item.content?.kind !== "text") {
          return false;
        }
        const createdAtMs = Date.parse(item.created_at || "");
        if (!Number.isFinite(createdAtMs) || createdAtMs < sinceMs) {
          return false;
        }
        return item.content.text === text;
      });
  }

  appendMessage(topicKey, message) {
    const topic = this.state.topics[topicKey];
    if (!topic) {
      throw new Error(`unknown topic ${topicKey}`);
    }
    const nextSeq = (topic.head_seq || 0) + 1;
    const enriched = {
      ...message,
      seq: nextSeq
    };
	    this.state.messages[topicKey] ||= [];
	    this.state.messages[topicKey].push(enriched);
	    topic.head_seq = nextSeq;
    const activityAt = enriched.updated_at || enriched.created_at || nowIso();
    topic.updated_at = activityAt;
    topic.last_activity_at = activityAt;
	    return enriched;
	  }

  enqueueDeviceEventForTopic(topicKey, event) {
    const topic = this.state.topics[topicKey];
    if (!topic || !event?.event_id) {
      return 0;
    }
    let count = 0;
    for (const [deviceId, device] of Object.entries(this.state.devices || {})) {
      if (!Array.isArray(device.topics) || !device.topics.includes(topicKey)) {
        continue;
      }
      this.state.device_events[deviceId] ||= [];
      if (this.state.device_events[deviceId].some((item) => item.event_id === event.event_id)) {
        continue;
      }
      this.state.device_events[deviceId].push({
        ...event,
        topic_key: topicKey,
        queued_at: event.queued_at || nowIso(),
        acked_at: null
      });
      count += 1;
    }
    return count;
  }

  enqueueDeviceEvent(deviceId, event) {
    const device = this.state.devices?.[deviceId];
    if (!device || !event?.event_id) {
      return false;
    }
    this.state.device_events[deviceId] ||= [];
    if (this.state.device_events[deviceId].some((item) => item.event_id === event.event_id)) {
      return false;
    }
    this.state.device_events[deviceId].push({
      ...event,
      queued_at: event.queued_at || nowIso(),
      acked_at: null
    });
    return true;
  }

  listPendingDeviceEvents(deviceId, { limit = 5, topicKey = "", senderKind = "" } = {}) {
    const events = this.state.device_events?.[deviceId] || [];
    const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 5)));
    const matching = events
      .filter((event) => !event.acked_at)
      .filter((event) => !topicKey || event.topic_key === topicKey)
      .filter((event) => {
        if (!senderKind) {
          return true;
        }
        return event.message?.sender?.kind === senderKind;
      });
    return [
      ...matching.filter((event) => event.priority === "urgent"),
      ...matching.filter((event) => event.priority !== "urgent")
    ].slice(0, max);
  }

  ackDeviceEvent(deviceId, eventId) {
    const events = this.state.device_events?.[deviceId] || [];
    const event = events.find((item) => item.event_id === eventId);
    if (!event) {
      return false;
    }
    event.acked_at ||= nowIso();
    return true;
  }

  putMedia(media) {
    this.state.media[media.media_id] = media;
  }

  getMedia(mediaId) {
    return this.state.media[mediaId] || null;
  }

  markTopicScanCursor(topicKey, ms) {
    const topic = this.state.topics[topicKey];
    if (topic) {
      topic.inbound_scan_cursor_ms = Math.max(topic.inbound_scan_cursor_ms || 0, ms);
    }
  }

  getTopicScanCursor(topicKey) {
    return this.state.topics[topicKey]?.inbound_scan_cursor_ms || 0;
  }
}
