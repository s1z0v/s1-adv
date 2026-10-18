import { REPLY_LANGUAGE_POLICY, requestedReplyLanguage } from "./reply-language.mjs";
import { firmwareCapability, firmwareWorkflowPaths } from "./firmware-automation.mjs";
import { PrivateStorageBudget } from "./storage-budget.mjs";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { appendFile, chmod, copyFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import Busboy from "busboy";
import WebSocket, { WebSocketServer } from "ws";
import { StateStore } from "./state-store.mjs";
import { UpstreamGatewayClient } from "./upstream-client.mjs";
import { createMininervaCompatServer } from "./mininerva-compat.mjs";
import {
  agentIdForSession,
  hasInternalOtaAccess,
  isRecord,
  parseRequestUrl,
  RealtimeAdmissionController,
  requestClientIp,
  validateDeviceTokens,
  validateUpstreamTransport,
  websocketOriginAllowed
} from "./security-policy.mjs";
import {
  ensureDir,
  writeJsonAtomic,
  extractMetadataBlock,
  isTelegramVoiceTranscript,
  json,
  makeId,
  normalizeTimestamp,
  nowIso,
  parseVisibleText,
  readJsonFile,
  sha256,
  sleep,
  stripMarkdownForDevice,
  stripTelegramEnvelope
} from "./utils.mjs";
import { voiceThinking, unwrapCardputerEnvelope, audioTerminalReady, voiceReplyWaitMs, gatewayTurnCorrelation, assistantReplyMatchesTurn } from "./turn-delivery-policy.mjs";
import { DurableTurnOutbox } from "./turn-outbox.mjs";
import { decodeVoiceUpload } from "./voice-upload-codec.mjs";
import { RealtimePacingBudget, REALTIME_MAX_AUDIO_LEAD_MS } from "./realtime-pacing-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "..", "config.json");
const OPENAI_API_BASE = "https://api.openai.com/v1";
const OPENAI_WIF_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DEFAULT_OMNIBOT_SHIM = {
  enabled: true,
  sttProvider: "local-whisper",
  sttModel: "gpt-4o-mini-transcribe",
  sttTimeoutMs: 60000,
  sttFallbackProvider: "none",
  sttGeminiModel: "",
  sttLocalBin: "/usr/local/bin/whisper-cli",
  sttLocalModel: "/var/lib/openclaw-cardputer-bridge/models/ggml-base.bin",
  sttLocalLanguage: "auto",
  sttLocalThreads: 4,
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "alloy",
  ttsFallbackProvider: "espeak",
  ttsFallbackBin: "espeak-ng",
  ttsFallbackVoiceRu: "ru",
  ttsFallbackVoiceEn: "en-us",
  ttsSampleRate: 12000,
  ttsTimeoutMs: 8000,
  turnWaitMs: 60000,
  voiceTurnWaitMs: 25000,
  turnPollMs: 100
};

const DEFAULT_FAST_LANE = {
  enabled: false,
  voiceEnabled: true,
  textEnabled: true,
  provider: "codex-oauth",
  model: "gpt-5.4-mini",
  models: ["gpt-5.4-mini"],
  api: "responses",
  codexAuthStorePath: "/var/lib/openclaw-cardputer-bridge/codex-home/auth.json",
  codexRefreshSkewMs: 120000,
  reasoningEffort: "minimal",
  verbosity: "low",
  timeoutMs: 5000,
  maxTokens: 260,
  temperature: 0.2,
  fallbackToOpenClaw: true,
  historyLimit: 2,
  historyTextChars: 120,
  replyMaxChars: 900
};

const DEFAULT_REALTIME_VOICE = {
  enabled: false,
  model: "gpt-realtime",
  voice: "alloy",
  inputAudioFormat: "pcm16",
  outputAudioFormat: "pcm16",
  sampleRate: 24000,
  vadMode: "semantic_vad",
  vadEagerness: "low",
  vadThreshold: 0.5,
  vadPrefixPaddingMs: 300,
  vadSilenceDurationMs: 400,
  maxSessionMs: 55 * 60 * 1000,
  binaryAudioEnabled: true,
  deviceAudioPacingMs: 20,
  deviceAudioPacingChunkMs: 30,
  maxPacedAudioBytes: 8 * 1024 * 1024,
  maxActivePerDevice: 2,
  maxActiveGlobal: 8,
  startLimitPerDevice: 30,
  startWindowMs: 60 * 1000,
  reasoningEffort: "",
  s1ToolsEnabled: true,
  s1ToolTimeoutMs: 60000,
  s1ToolMaxChars: 4000,
  authMode: "auto",
  wifAllowApiKeyFallback: true,
  wifRefreshSkewMs: 60000,
  wifTokenTimeoutMs: 5000,
  instructions: ""
};

const REALTIME_DEVICE_AUDIO_DELTA_CHARS = 4096;
const REALTIME_DEVICE_AUDIO_DELTA_BYTES = 4096;
const REALTIME_BINARY_FRAME_HEADER_BYTES = 8;
const REALTIME_BINARY_FRAME_VERSION = 1;
const REALTIME_BINARY_INPUT_PCM = 0x01;
const REALTIME_BINARY_OUTPUT_PCM = 0x02;
const REALTIME_MAX_BUFFERED_BYTES = 512 * 1024;
const codexOAuthRefreshInFlight = new Map();
let realtimeWifCredentialCache = null;

function resolvePath(baseDir, maybeRelative) {
  if (!maybeRelative) {
    return maybeRelative;
  }
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(baseDir, maybeRelative);
}

async function loadConfig() {
  const configPath = process.env.CARDPUTER_BRIDGE_CONFIG
    ? path.resolve(process.cwd(), process.env.CARDPUTER_BRIDGE_CONFIG)
    : DEFAULT_CONFIG_PATH;
  const config = await readJsonFile(configPath, null);
  if (!config) {
    throw new Error(`config not found: ${configPath}`);
  }
  const baseDir = path.dirname(configPath);
  config.stateDir = resolvePath(baseDir, config.stateDir);
  config.media.inboundDir = resolvePath(baseDir, config.media.inboundDir || path.join(config.stateDir,"inbound"));
  config.media.canonicalDir = resolvePath(baseDir, config.media.canonicalDir);
  config.media.playbackDir = resolvePath(baseDir, config.media.playbackDir);
  config.media.tmpDir = resolvePath(baseDir, config.media.tmpDir);
  config.assets ||= {};
  config.assets.rootDir = resolvePath(
    baseDir,
    config.assets.rootDir || path.join(config.stateDir, "assets")
  );
  config.assets.logsDir = resolvePath(
    baseDir,
    config.assets.logsDir || path.join(config.stateDir, "logs")
  );
  config.assets.deviceClass ||= "cardputer_adv";
  config.assets.audioPrefix ||= "/pomodoro/audio";
  config.assets.replyCategory ||= "ai_answers";
  config.assets.replySampleRate ||= 8000;
  config.assets.maxFileBytes ||= 10 * 1024 * 1024;
  config.assets.maxManifestFiles ||= 512;
  config.assets.maxManifestBytes ||= 2 * 1024 * 1024;
  config.firmware ||= {};
  config.firmware.rootDir = resolvePath(
    baseDir,
    config.firmware.rootDir || path.join(config.stateDir, "firmware")
  );
  config.firmware.deviceClass ||= config.assets.deviceClass || "cardputer_adv";
  config.firmware.channel ||= "dev";
  config.firmware.manifestFilename ||= "manifest.json";
  config.firmware.minBattery ||= 40;
  config.firmware.confirmRequired ??= true;
  config.firmware.maxFileBytes ||= 10 * 1024 * 1024;
  config.upstream ||= {};
  config.upstream.deviceIdentityPath = resolvePath(
    baseDir,
    config.upstream.deviceIdentityPath || path.join(config.stateDir, "upstream-device.json")
  );
  config.upstream.clientDisplayName ||= "OpenClaw Cardputer Bridge";
  config.upstream.deviceFamily ||= "bridge";
  config.upstream.locale ||= "en-US";
  config.upstream.userAgent ||= "openclaw-cardputer-bridge/0.1.0";
  config.server ||= { host: "127.0.0.1", port: 31889 };
  config.state ||= {};
  config.state.maxMessagesPerTopic ||= 250;
  config.state.maxIdempotencyEntries ||= 1000;
  config.historyBootstrapLimit ||= 80;
  config.maxUploadBytes ||= 4 * 1024 * 1024;
  config.maxVoiceDurationMs ||= 120000;
  config.reconnectRequiredCode ||= "HISTORY_RESET";
  config.security = {
    allowedOrigins: [],
    trustedProxyAddresses: [],
    maxJsonBytes: 128 * 1024,
    maxLogBytes: 256 * 1024,
    maxWsPayloadBytes: 64 * 1024,
    wsAuthTimeoutMs: 5000,
    authFailureLimit: 20,
    authFailureWindowMs: 60000,
    authBlockMs: 300000,
    inboxInjectEnabled: false,
    internalOtaEnabled: false,
    internalOtaToken: process.env.CARDPUTER_INTERNAL_OTA_TOKEN || "",
    maxWsConnectionsPerIp: 32,
    maxWsConnectionsGlobal: 128,
    maxActiveRequestsPerDevice: 2,
    maxActiveRequestsGlobal: 8,
    requestStartLimitPerDevice: 30,
    multipartMaxFields: 16,
    multipartFieldBytes: 8192,
    ...(config.security || {})
  };
  config.mininervaCompat ||= {
    path: "/compat/mininerva/ws"
  };
  config.deviceTurnContext = {
    enabled: true,
    shortReplyWords: 15,
    voiceReplyMaxSeconds: 25,
    topicCatalogLimit: 12,
    voiceTopicCatalogLimit: 3,
    topicPreviewLimit: 3,
    voiceTopicPreviewLimit: 0,
    topicPreviewEntryLimit: 2,
    topicPreviewTextChars: 120,
    topicPreviewChars: 700,
    recentHistoryLimit: 4,
    voiceRecentHistoryLimit: 3,
    recentTextChars: 140,
    voiceRecentTextChars: 96,
    recentHistoryChars: 900,
    voiceRecentHistoryChars: 420,
    ...(config.deviceTurnContext || {})
  };
  config.omnibotShim = {
    ...DEFAULT_OMNIBOT_SHIM,
    ...(config.omnibotShim || {})
  };
  config.fastLane = {
    ...DEFAULT_FAST_LANE,
    ...(config.fastLane || {})
  };
  config.realtimeVoice = {
    ...DEFAULT_REALTIME_VOICE,
    ...(config.realtimeVoice || {})
  };
  validateDeviceTokens(config);
  validateUpstreamTransport(config);
  return config;
}

function authErrorPayload(message) {
  return {
    type: "auth_error",
    code: "DEVICE_REVOKED",
    message,
    retryable: false
  };
}

const DEVICE_ACTION_CATALOG_VERSION = "2026-10-17.1";
const DEVICE_ACTION_CATALOG = [
  { type: "focus.start", group: "focus", description: "Start or resume focus timer", example: "start pomodoro for 45 minutes" },
  { type: "focus.pause", group: "focus", description: "Pause a running focus timer", example: "pause focus" },
  { type: "focus.resume", group: "focus", description: "Resume paused focus timer", example: "resume focus" },
  { type: "focus.reset", group: "focus", description: "Reset focus timer", example: "reset pomodoro" },
  { type: "focus.set_duration", group: "focus", description: "Set focus duration in minutes", example: "set pomodoro to 45 minutes" },
  { type: "focus.set_short_break", group: "focus", description: "Set short break duration", example: "make short breaks 10 minutes" },
  { type: "focus.set_long_break", group: "focus", description: "Set long break duration", example: "set long break to 20 minutes" },
  { type: "focus.set_cycles", group: "focus", description: "Set focus cycles per round", example: "set pomodoro cycles to 4" },
  { type: "focus.set_autostart", group: "focus", description: "Toggle focus auto-start", example: "turn focus auto start on" },
  { type: "focus.set_metronome", group: "focus", description: "Toggle focus metronome", example: "turn metronome off" },
  { type: "focus.set_bpm", group: "focus", description: "Set metronome BPM", example: "set metronome to 80 bpm" },
  { type: "ui.open", group: "ui", description: "Open a local screen", example: "open battery screen" },
  { type: "audio.play", group: "audio", description: "Play an audio library asset", example: "play the nutrition plan" },
  { type: "voice.play", group: "audio", description: "Play a saved voice note", example: "play last voice note" },
  { type: "settings.set_audio_language", group: "settings", description: "Set audio language", example: "set audio language to Russian" },
  { type: "settings.set_ota_auto", group: "settings", description: "Toggle automatic OTA", example: "turn automatic updates on" },
  { type: "settings.set_ota_boot_check", group: "settings", description: "Toggle boot update checks", example: "check updates on boot" },
  { type: "settings.set_ota_min_battery", group: "settings", description: "Set OTA battery threshold", example: "only update above 50 percent battery" },
  { type: "ota.check", group: "firmware", description: "Fetch the latest firmware OTA manifest", example: "check for firmware update" },
  { type: "ota.apply", group: "firmware", description: "Apply the latest available firmware OTA after explicit user consent", example: "install the firmware update" },
  { type: "pet.feed", group: "pet", description: "Feed the OpenClaw pet", example: "feed the pet" },
  { type: "pet.play", group: "pet", description: "Play with the OpenClaw pet", example: "play with the pet" },
  { type: "pet.clean", group: "pet", description: "Clean the OpenClaw pet", example: "clean the pet" },
  { type: "pet.sleep", group: "pet", description: "Put the pet to sleep", example: "put the pet to sleep" },
  { type: "pet.medicine", group: "pet", description: "Heal the pet", example: "give the pet medicine" },
  { type: "pet.discipline", group: "pet", description: "Discipline the pet", example: "discipline the pet" },
  { type: "pet.hunt", group: "pet", description: "Send the pet hunting Wi-Fi", example: "send the pet hunting" },
  { type: "pet.explore", group: "pet", description: "Let the pet explore", example: "let the pet explore" },
  { type: "pet.reset", group: "pet", description: "Reset pet state", example: "reset the pet" }
];

const CARDPUTER_FIRMWARE_CONTEXT_VERSION = "2026-05-03.1";
const CARDPUTER_FIRMWARE_WORK_RE =
  /\b(firmware|ota|release|build|flash|version|bump)\b|\b(?:add|build|publish|release)\b.{0,48}\b(?:calculator|calc)\b|прошивк|верс(?:ия|ию|ии)|сборк|собер|собери|опубликуй|публикац|релиз|добав(?:ь|ить).{0,48}калькулятор|добавь функцию|добавить функцию/iu;
const CARDPUTER_PRIMARY_TOPIC_TITLE = "Cardputer";
const CARDPUTER_SINGLE_TOPIC_MODE = true;
const CARDPUTER_FIRMWARE_TOPIC_TITLE = "Cardputer Firmware";
const CARDPUTER_FIRMWARE_JOB_TOPIC_PREFIX = "Cardputer Firmware Job";
const CARDPUTER_FIRMWARE_REPO =
  process.env.CARDPUTER_FIRMWARE_REPO || "/root/.openclaw/workspace/repos/cardputer-firmware";
const CARDPUTER_FIRMWARE_APP_DIR = path.join(CARDPUTER_FIRMWARE_REPO, "bots/CardputerADV");
const CARDPUTER_FIRMWARE_BUILD_BIN =
  process.env.CARDPUTER_FIRMWARE_BUILD_BIN || "/root/.openclaw/workspace/bin/cardputer_adv_pio.sh";
const CARDPUTER_FIRMWARE_PUBLISH_BIN =
  process.env.CARDPUTER_FIRMWARE_PUBLISH_BIN || "/root/.openclaw/workspace/bin/cardputer_publish_firmware.sh";
const CARDPUTER_FIRMWARE_SMOKE_BIN =
  process.env.CARDPUTER_FIRMWARE_SMOKE_BIN || "/root/.openclaw/workspace/bin/cardputer_release_smoke.sh";
const cardputerFirmwareJobs = new Set();
const CARDPUTER_FIRMWARE_CAPABILITIES = {
  hardware: {
    device: "M5Stack CardPuter ADV",
    mcu: "ESP32-S3",
    flash: "8MB embedded flash",
    ota_layout: "dual OTA app slots, 0x300000 bytes per app slot",
    firmware_repo: CARDPUTER_FIRMWARE_REPO,
    bridge_repo: path.join(CARDPUTER_FIRMWARE_REPO,"bridge"),
    build_command: CARDPUTER_FIRMWARE_BUILD_BIN,
    server_firmware_repo: CARDPUTER_FIRMWARE_REPO,
    server_build_wrapper: CARDPUTER_FIRMWARE_BUILD_BIN,
    server_publish_wrapper: CARDPUTER_FIRMWARE_PUBLISH_BIN,
    publish_route: "review, commit source, build, push source, publish OTA, verify manifest and image"
  },
  implemented_features: [
    "Pomodoro/focus timer: start, pause, resume, reset, set focus duration, breaks, cycles, autostart, metronome, BPM",
    "One configured conversation; no on-device topic browser, creation or switching",
    "Local UI screens: home, chat, voice, library, folders, notes, assets, focus, logs, settings, battery, firmware/OTA",
    "Calculator screen: basic arithmetic with +, -, *, /, decimal numbers, parentheses, clear, backspace, and Enter to evaluate",
    "Audio library and saved voice note playback by existing asset index/query/path",
    "Pet/Tamagotchi actions: feed, play, clean, sleep, medicine, discipline, hunt, explore, reset",
    "Settings: audio language, OTA auto update, OTA boot check, OTA minimum battery",
    "Firmware OTA: fetch manifest, show candidate/current version, apply OTA, boot guard confirm/rollback, show firmware slot usage",
    "Standard voice turn: record, upload raw audio, transcribe, route to current topic, play synthesized reply audio",
    "Realtime voice exists as an experimental mode; do not treat it as the stable default voice UX yet"
  ],
  absent_or_not_directly_executable: [
    "Arbitrary new app/function not already listed in implemented_features",
    "Arbitrary audio playback from text via audio.play/voice.play; visible reply audio synthesis handles spoken replies"
  ],
  behavior_rules: [
    "If the user asks to run an implemented feature, execute it with supported device_actions when possible.",
    "If the user asks to run a feature that is absent, say it is not in the current firmware and ask whether to develop and publish it.",
    "If the user confirms developing an absent feature, treat it as firmware work: inspect and edit the configured checkout, commit reviewed source, build that commit, push it, publish an OTA candidate, verify it, and report the version.",
    "Do not claim a firmware feature exists unless it appears in implemented_features or the current manifest/release notes.",
    "For firmware analysis/build/release requests, use the dedicated Cardputer Firmware topic/session with repo path, branch/runbook, build command, OTA publish route, and verification expectations.",
    "Use exactly one firmware build at a time with the configured job_session_contract.build_wrapper, which provides private provisioning and the release lock.",
    "Never run parallel PlatformIO builds against the same CardputerADV .pio/build directory; use the wrapper/lock or an isolated build dir."
  ]
};

const DEVICE_ACTION_TYPES = new Set(DEVICE_ACTION_CATALOG.map((action) => action.type));

const DEVICE_UI_MODES = new Set([
  "home",
  "pulse",
  "chat",
  "chat_full",
  "chat_eyes",
  "face",
  "eyes",
  "hero",
  "voice",
  "library",
  "folders",
  "assets",
  "focus",
  "logs",
  "settings",
  "calculator",
  "calc",
  "battery",
  "ota",
  "firmware"
]);

function clampNumber(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

function boundedString(value, max = 64) {
  return String(value || "").trim().slice(0, max);
}

function normalizeDeviceActionType(value) {
  return String(value || "").trim().toLowerCase().replace(/_/gu, ".");
}

function sanitizeDeviceAction(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const type = normalizeDeviceActionType(raw.type || raw.action);
  if (!DEVICE_ACTION_TYPES.has(type)) {
    return null;
  }

  const action = { type };
  if (type.startsWith("focus.")) {
    if (Object.hasOwn(raw, "minutes")) {
      action.minutes = clampNumber(raw.minutes, 1, 60, 25);
    }
    if (Object.hasOwn(raw, "minute")) {
      action.minutes = clampNumber(raw.minute, 1, 60, action.minutes || 25);
    }
    if (Object.hasOwn(raw, "mins")) {
      action.minutes = clampNumber(raw.mins, 1, 60, action.minutes || 25);
    }
    if (Object.hasOwn(raw, "duration_minutes")) {
      action.minutes = clampNumber(raw.duration_minutes, 1, 60, action.minutes || 25);
    }
    if (Object.hasOwn(raw, "duration")) {
      action.minutes = clampNumber(raw.duration, 1, 60, action.minutes || 25);
    }
    if (Object.hasOwn(raw, "cycles")) {
      action.cycles = clampNumber(raw.cycles, 1, 9, 4);
    }
    if (Object.hasOwn(raw, "bpm")) {
      action.bpm = clampNumber(raw.bpm, 30, 160, 60);
    }
    if (Object.hasOwn(raw, "value")) {
      action.value = Boolean(raw.value);
    }
    if (Object.hasOwn(raw, "enabled")) {
      action.value = Boolean(raw.enabled);
    }
  } else if (type === "ui.open") {
    const mode = boundedString(raw.mode || raw.screen || raw.value, 32).toLowerCase().replace(/[-\s]+/gu, "_");
    if (!DEVICE_UI_MODES.has(mode)) {
      return null;
    }
    action.mode = mode;
  } else if (type === "audio.play" || type === "voice.play") {
    let hasLocator = false;
    if (Object.hasOwn(raw, "index")) {
      action.index = clampNumber(raw.index, 0, 999, 0);
      hasLocator = true;
    }
    if (raw.query || raw.title) {
      action.query = boundedString(raw.query || raw.title, 72);
      hasLocator = true;
    }
    if (raw.path) {
      const localPath = boundedString(raw.path, 96);
      if (localPath.startsWith("/audio/") || localPath.startsWith("/pomodoro/audio/") ||
          localPath.startsWith("/voice/") || localPath.startsWith("/reply/")) {
        action.path = localPath;
        hasLocator = true;
      }
    }
    if (!hasLocator) {
      return null;
    }
  } else if (type === "settings.set_audio_language") {
    const language = boundedString(raw.language || raw.value, 8).toLowerCase();
    if (!["ru", "en", "es"].includes(language)) {
      return null;
    }
    action.value = language;
  } else if (type === "settings.set_ota_auto" || type === "settings.set_ota_boot_check") {
    action.value = Boolean(raw.value ?? raw.enabled);
  } else if (type === "settings.set_ota_min_battery") {
    action.value = clampNumber(raw.value ?? raw.percent, 5, 95, 40);
  } else if (type === "topic.open") {
    if (Object.hasOwn(raw, "index")) {
      action.index = clampNumber(raw.index, 0, 999, 0);
    }
    if (raw.key) {
      action.key = boundedString(raw.key, 80);
    }
    if (raw.query || raw.title) {
      action.query = boundedString(raw.query || raw.title, 72);
    }
  }
  return action;
}

function sanitizeDeviceActions(rawActions) {
  const list = Array.isArray(rawActions) ? rawActions : [rawActions];
  const actions = [];
  for (const raw of list) {
    const action = sanitizeDeviceAction(raw);
    if (action) {
      actions.push(action);
      if (actions.length >= 4) {
        break;
      }
    }
  }
  return actions;
}

function parseDeviceActionsJson(value) {
  try {
    return sanitizeDeviceActions(JSON.parse(value));
  } catch {
    return [];
  }
}

function findJsonValueEnd(text, startIndex) {
  let index = startIndex;
  while (index < text.length && /\s/u.test(text[index])) {
    index += 1;
  }
  const first = text[index];
  if (first !== "[" && first !== "{") {
    return -1;
  }

  const stack = [first === "[" ? "]" : "}"];
  let inString = false;
  let escaped = false;
  for (let pos = index + 1; pos < text.length; pos += 1) {
    const char = text[pos];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "[" || char === "{") {
      stack.push(char === "[" ? "]" : "}");
    } else if (char === "]" || char === "}") {
      if (stack.pop() !== char) {
        return -1;
      }
      if (stack.length === 0) {
        return pos + 1;
      }
    }
  }
  return -1;
}

function stripInlineDeviceActionMarkers(text, addActions) {
  const marker = "[[cardputer_actions:";
  const lower = text.toLowerCase();
  let cursor = 0;
  let output = "";
  while (cursor < text.length) {
    const markerIndex = lower.indexOf(marker, cursor);
    if (markerIndex < 0) {
      output += text.slice(cursor);
      break;
    }

    const valueStart = markerIndex + marker.length;
    const valueEnd = findJsonValueEnd(text, valueStart);
    if (valueEnd < 0 || text.slice(valueEnd, valueEnd + 2) !== "]]") {
      output += text.slice(cursor, markerIndex + marker.length);
      cursor = markerIndex + marker.length;
      continue;
    }

    addActions(text.slice(valueStart, valueEnd));
    output += text.slice(cursor, markerIndex);
    cursor = valueEnd + 2;
  }
  return output;
}

function extractDeviceActionsFromText(input) {
  let visibleText = String(input || "");
  const actions = [];
  const addActions = (jsonText) => {
    for (const action of parseDeviceActionsJson(jsonText)) {
      if (actions.length < 4) {
        actions.push(action);
      }
    }
  };

  visibleText = visibleText.replace(/```cardputer_actions\s*([\s\S]*?)```/giu, (_match, jsonText) => {
    addActions(jsonText);
    return "";
  });
  visibleText = stripInlineDeviceActionMarkers(visibleText, addActions);

  const trimmed = visibleText.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.device_actions) {
        for (const action of sanitizeDeviceActions(parsed.device_actions)) {
          if (actions.length < 4) {
            actions.push(action);
          }
        }
        visibleText = String(parsed.reply || parsed.full_text || parsed.text || "").trim();
      }
    } catch {
      // Keep visible text unchanged when the assistant sent normal text.
    }
  }

  return {
    visibleText: visibleText.trim(),
    actions: actions.slice(0, 4)
  };
}

function inferFocusMinutesFromText(...values) {
  for (const value of values) {
    const text = String(value || "").toLowerCase();
    if (!text) {
      continue;
    }
    if (/\bhalf\s+hour\b|пол\s*часа|полчас/iu.test(text)) {
      return 30;
    }
    const minuteMatch = text.match(/(?:на|for|to|set\s+to|ставлю\s+на|запускаю\s+на)?\s*(\d{1,2})\s*(?:мин(?:ут[уы]?|ут)?|minutes?|mins?|m\b)/iu);
    if (minuteMatch) {
      return clampNumber(minuteMatch[1], 1, 60, 25);
    }
    const hourMatch = text.match(/(?:на|for)?\s*(\d{1,2})\s*(?:час(?:а|ов)?|hours?|h\b)/iu);
    if (hourMatch) {
      return clampNumber(Number(hourMatch[1]) * 60, 1, 60, 60);
    }
  }
  return null;
}

function alignFocusActionMinutes(actions, ...texts) {
  const inferredMinutes = inferFocusMinutesFromText(...texts);
  if (!inferredMinutes) {
    return actions;
  }
  return actions.map((action) => {
    if (!action || (action.type !== "focus.start" && action.type !== "focus.set_duration")) {
      return action;
    }
    if (action.minutes === inferredMinutes) {
      return action;
    }
    return { ...action, minutes: inferredMinutes };
  });
}

function buildDeviceActionPolicyText() {
  const actionTypes = DEVICE_ACTION_CATALOG.map((action) => action.type).join(", ");
  const examples = DEVICE_ACTION_CATALOG
    .filter((action) => action.example)
    .slice(0, 8)
    .map((action) => `"${action.example}" -> ${action.type}`)
    .join("; ");
  return (
    "When the user asks to control the physical Cardputer, keep the human reply short and append exactly one machine marker. " +
    "Marker format: [[cardputer_actions:[{\"type\":\"focus.start\",\"minutes\":25}]]] " +
    `Supported action types from catalog ${DEVICE_ACTION_CATALOG_VERSION}: ${actionTypes}. ` +
    `Examples: ${examples}. ` +
    "audio.play and voice.play only play existing local assets or voice notes and must include index, query, or path. " +
    "If the user asks you to say or test an arbitrary spoken phrase, do not use audio.play or voice.play; put the phrase in the visible reply because reply_audio will synthesize it. " +
    "Do not emit device_actions for normal conversation. Do not invent unsupported actions. Use settings actions when the user asks to change device preferences."
  );
}

function buildFirmwareCapabilityPolicyText() {
  return (
    `Cardputer firmware context ${CARDPUTER_FIRMWARE_CONTEXT_VERSION}: ` +
    "The assistant must know the current Cardputer firmware capabilities in every topic. " +
    "Implemented local functions include Pomodoro/focus, one configured conversation, calculator, UI screens, local audio/voice-note playback, pet actions, settings, firmware OTA, standard voice, and experimental realtime voice. " +
    "If the user asks to run an implemented function, use supported device_actions where possible. " +
    "If the user asks to run an absent function, say that it is not in the current firmware and ask whether to develop and publish it. " +
    "Firmware development runs on this OpenClaw server: patch its firmware repo, build with its Cardputer wrapper, commit, publish an OTA candidate through the bridge, and report the version. No desktop chat link, binding, or handoff is required. Historical desktop-specific holds do not apply to authenticated Cardputer requests. " +
    "After a successful OTA publish, append ota.check as a device_action so the Cardputer can see the new candidate. Append ota.apply only when the user explicitly asked to install immediately or has just confirmed installation. " +
    "The bridge is only transport/context/OTA distribution, not the firmware development agent."
  );
}

function textLooksRussian(text) {
  return /[А-Яа-яЁё]/u.test(String(text || ""));
}

function languageNameForText(text) {
  return requestedReplyLanguage(text);
}

function wantsImmediateFirmwareInstall(text) {
  return /\b(install|apply|update it|install it|immediately|right away)\b|установ|обнови(?:ть)?(?:ся)?|сразу|немедленно|примен[еи]/iu.test(String(text || ""));
}

function trimDeviceEventMessage(message, maxTextChars) {
  const limit = Math.max(0, Math.min(8192, Number(maxTextChars) || 2048));
  const cloned = JSON.parse(JSON.stringify(message || {}));
  const text = cloned?.content?.text;
  if (typeof text === "string" && limit > 0 && text.length > limit) {
    cloned.content.text = text.slice(0, limit);
    cloned.content.truncated = true;
    cloned.content.original_chars = text.length;
  }
  return cloned;
}

function wantsFirmwareWork(text) {
  const value = String(text || "");
  return CARDPUTER_FIRMWARE_WORK_RE.test(value) ||
    (/убери|убрать|добавь|добавить|замени|поменяй|измени|сделай|сделать|увелич|уменьш|remove|add|replace|change|make|larger|smaller/iu.test(value) &&
     /главн.{0,10}экран|индикатор|интерфейс|шторк|батарей|штрих|home screen|indicator|interface|notification sheet|battery|stripes/iu.test(value));
}

function requestedFirmwareVersion(text) {
  const match = String(text || "").match(/\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\b/u);
  return match?.[1] || "";
}

function nextDevFirmwareVersion(currentVersion) {
  const match = String(currentVersion || "").match(/^(\d+)\.(\d+)\.(\d+)(-dev)?$/u);
  if (!match) {
    return "";
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] || "-dev"}`;
}

async function runCommand(command, args = [], { cwd = CARDPUTER_FIRMWARE_REPO, timeoutMs = 10 * 60 * 1000 } = {}) {
  return await new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      HOME:
        process.env.HOME && process.env.HOME !== "/nonexistent"
          ? process.env.HOME
          : "/var/lib/openclaw-cardputer-bridge",
      PLATFORMIO_CORE_DIR: process.env.PLATFORMIO_CORE_DIR || "/root/.platformio"
    };
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 12000) {
        output = output.slice(-12000);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command timed out: ${command} ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`command failed ${code}: ${command} ${args.join(" ")}\n${output}`));
      }
    });
  });
}

async function replaceFirmwareVersion(filePath, version) {
  const current = await readFile(filePath, "utf8");
  const next = current.replace(/0\.2\.\d+-dev/gu, version);
  if (next === current) {
    throw new Error(`version marker not found in ${filePath}`);
  }
  await writeFile(filePath, next);
}

function deviceActionMarker(actions) {
  return `[[cardputer_actions:${JSON.stringify(actions)}]]`;
}

function fastCommandReplyFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }
  const lower = raw.toLowerCase();
  if (/(?:запусти|открой|покажи|open|show|launch|start)\s+(?:калькулятор|calculator|calc)\b/iu.test(lower)) {
    return `Открываю экран калькулятора. ${deviceActionMarker([{ type: "ui.open", mode: "calculator" }])}`;
  }
  const minutesMatch = lower.match(/(?:на|for|to|set\s+to)?\s*(\d{1,2})\s*(?:мин|минут|minutes?|m\b)/iu);
  const minutes = minutesMatch ? clampNumber(minutesMatch[1], 1, 60, 25) : 25;
  const wantsFocus = /помодор|pomodoro|фокус|focus/iu.test(lower);
  const wantsStart = /запусти|старт|начни|поставь|start|begin|run|set/iu.test(lower);
  if (wantsFocus && wantsStart) {
    return `Запускаю помодоро на ${minutes} минут. ${deviceActionMarker([{ type: "focus.start", minutes }])}`;
  }
  if (wantsFocus && /пауза|pause|останови/iu.test(lower)) {
    return `Ставлю фокус на паузу. ${deviceActionMarker([{ type: "focus.pause" }])}`;
  }
  if (wantsFocus && /продолж|resume|continue/iu.test(lower)) {
    return `Продолжаю фокус. ${deviceActionMarker([{ type: "focus.resume" }])}`;
  }
  if (wantsFocus && /сброс|reset|restart/iu.test(lower)) {
    return `Сбрасываю фокус. ${deviceActionMarker([{ type: "focus.reset" }])}`;
  }
  return null;
}

function buildDeviceActionsPayload() {
  return {
    ok: true,
    catalog_version: DEVICE_ACTION_CATALOG_VERSION,
    max_actions_per_reply: 4,
    marker_format: "[[cardputer_actions:[{\"type\":\"focus.start\",\"minutes\":25}]]]",
    ui_modes: [...DEVICE_UI_MODES],
    actions: DEVICE_ACTION_CATALOG
  };
}

function requestError(res, code, message, extra = {}) {
  return json(res, code, {
    error: message,
    ...extra
  });
}

class RequestTooLargeError extends Error {
  constructor(message = "request_too_large") {
    super(message);
    this.name = "RequestTooLargeError";
    this.statusCode = 413;
  }
}

function isRequestTooLarge(error) {
  return error instanceof RequestTooLargeError || error?.statusCode === 413;
}

function applyCors(req, res, config) {
  const origin = String(req.headers.origin || "").trim();
  const allowedOrigins = Array.isArray(config.security?.allowedOrigins)
    ? config.security.allowedOrigins.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const originAllowed = origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin));
  if (originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Device-Token,X-Conversation-Key,X-Reply-Audio,X-Save-Reply-Audio,X-Audio-Sample-Rate,X-Client-Msg-Id,X-Turn-Id");
  res.setHeader("Access-Control-Max-Age", "600");
}

function parseAuthorization(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function parseOmnibotAuthToken(req) {
  return (
    parseAuthorization(req) ||
    String(req.headers["x-device-token"] || "").trim()
  );
}

const authFailureBuckets = new Map();

function authRateSettings(config) {
  return {
    limit: Math.max(5, Number(config.security?.authFailureLimit) || 20),
    windowMs: Math.max(10000, Number(config.security?.authFailureWindowMs) || 60000),
    blockMs: Math.max(30000, Number(config.security?.authBlockMs) || 300000)
  };
}

function pruneAuthFailureBuckets(now = Date.now()) {
  if (authFailureBuckets.size <= 2048) {
    return;
  }
  for (const [ip, bucket] of authFailureBuckets) {
    if (bucket.blockedUntil <= now && bucket.windowStartedAt + 10 * 60 * 1000 <= now) {
      authFailureBuckets.delete(ip);
    }
  }
  while (authFailureBuckets.size > 2048) {
    authFailureBuckets.delete(authFailureBuckets.keys().next().value);
  }
}

function recordAuthFailure(req, config) {
  const now = Date.now();
  const ip = requestClientIp(req, config);
  const settings = authRateSettings(config);
  const existing = authFailureBuckets.get(ip);
  const bucket = !existing || existing.windowStartedAt + settings.windowMs <= now
    ? { count: 0, windowStartedAt: now, blockedUntil: 0 }
    : existing;
  bucket.count += 1;
  if (bucket.count >= settings.limit) {
    bucket.blockedUntil = Math.max(bucket.blockedUntil, now + settings.blockMs);
  }
  authFailureBuckets.set(ip, bucket);
  pruneAuthFailureBuckets(now);
}

function clearAuthFailures(req, config) {
  authFailureBuckets.delete(requestClientIp(req, config));
}

function isAuthRateLimited(req, config) {
  const bucket = authFailureBuckets.get(requestClientIp(req, config));
  return Boolean(bucket && bucket.blockedUntil > Date.now());
}

function rejectRateLimitedUpgrade(socket) {
  try {
    socket.write(
      "HTTP/1.1 429 Too Many Requests\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n"
    );
  } catch {}
  socket.destroy();
}

function isOmnibotShimPath(pathname) {
  return (
    pathname === "/api/device-text-turn" ||
    pathname === "/api/device-audio-turn" ||
    pathname === "/api/device-audio-turn-raw" ||
    pathname === "/api/device-tts"
  );
}

async function readRequestBuffer(req, maxBytes = 128 * 1024) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        continue;
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error?.code === "ECONNRESET" || String(error?.message || "").toLowerCase().includes("aborted")) {
      return null;
    }
    throw error;
  }
  if (tooLarge) {
    throw new RequestTooLargeError();
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, maxBytes = 128 * 1024) {
  const raw = await readRequestBuffer(req, maxBytes);
  if (raw === null) {
    return null;
  }
  if (!raw.length) {
    return {};
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

async function streamRequestToFile(req, filePath, maxBytes) {
  await ensureDir(path.dirname(filePath));
  const writer = createWriteStream(filePath);
  let bytes = 0;
  let writerError = null;
  writer.on("error", (error) => {
    writerError = error;
  });
  try {
    for await (const chunk of req) {
      if (writerError) {
        throw writerError;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new RequestTooLargeError("upload_too_large");
      }
      if (!writer.write(buffer)) {
        await once(writer, "drain");
      }
    }
    writer.end();
    await once(writer, "finish");
    if (writerError) {
      throw writerError;
    }
    return bytes;
  } catch (error) {
    if (!writer.destroyed) {
      writer.destroy();
    }
    if (!writer.closed) await once(writer, "close").catch(() => {});
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readMultipartUpload(req, config, { toFilePath = null } = {}) {
  const maxBytes = Number(config.maxUploadBytes) || 4 * 1024 * 1024;
  const maxFields = Number(config.security?.multipartMaxFields) || 16;
  const fieldSize = Number(config.security?.multipartFieldBytes) || 8192;
  if (toFilePath) {
    await ensureDir(path.dirname(toFilePath));
  }

  return await new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: {
        fileSize: maxBytes,
        files: 1,
        fields: maxFields,
        parts: maxFields + 1,
        fieldSize
      }
    });
    const fields = {};
    const chunks = [];
    let originalFileName = toFilePath ? path.basename(toFilePath) : "upload.bin";
    let mimeType = "application/octet-stream";
    let bytes = 0;
    let fileSeen = false;
    let limited = false;
    let writer = null;
    let writerDone = Promise.resolve();

    const cleanupAndReject = async (error) => {
      if (writer) {
        writer.destroy();
      }
      if (toFilePath) {
        await rm(toFilePath, { force: true }).catch(() => {});
      }
      reject(error);
    };

    bb.on("field", (name, value) => {
      fields[String(name).slice(0, 64)] = String(value || "").slice(0, fieldSize);
    });
    bb.on("file", (_name, stream, info) => {
      if (fileSeen) {
        limited = true;
        stream.resume();
        return;
      }
      fileSeen = true;
      originalFileName = info.filename || originalFileName;
      mimeType = info.mimeType || mimeType;
      if (toFilePath) {
        writer = createWriteStream(toFilePath);
        writerDone = new Promise((resolveWriter, rejectWriter) => {
          writer.on("finish", resolveWriter);
          writer.on("error", rejectWriter);
        });
        // The body may still be arriving when the filesystem fails.
        // Keep rejection handled until the parser's close handler joins it.
        writerDone.catch(() => {});
      }
      stream.on("limit", () => {
        limited = true;
        stream.resume();
      });
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (limited) {
          return;
        }
        if (toFilePath) {
          writer.write(chunk);
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("end", () => {
        if (writer) {
          writer.end();
        }
      });
      stream.on("error", (error) => void cleanupAndReject(error));
    });
    bb.on("filesLimit", () => {
      limited = true;
    });
    bb.on("fieldsLimit", () => {
      limited = true;
    });
    bb.on("partsLimit", () => {
      limited = true;
    });
    bb.on("error", (error) => void cleanupAndReject(error));
    bb.on("close", async () => {
      try {
        await writerDone;
        if (limited || bytes > maxBytes) {
          await cleanupAndReject(new RequestTooLargeError("upload_too_large"));
          return;
        }
        resolve({
          fields,
          originalFileName,
          mimeType,
          bytes,
          data: toFilePath ? undefined : Buffer.concat(chunks),
          uploadPath: toFilePath
        });
      } catch (error) {
        await cleanupAndReject(error);
      }
    });
    req.pipe(bb);
  });
}

function openAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function geminiApiKey(config) {
  return String(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    config?.omnibotShim?.geminiApiKey ||
    ""
  ).trim();
}

function openAiHeaders(apiKey) {
  const cleaned = String(apiKey || "").trim();
  if (!cleaned) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  return {
    Authorization: `Bearer ${cleaned}`
  };
}

function realtimeWifSettings(config) {
  return {
    identityProviderId: String(
      process.env.OPENAI_WIF_IDENTITY_PROVIDER_ID ||
      config.realtimeVoice?.wifIdentityProviderId ||
      ""
    ).trim(),
    serviceAccountId: String(
      process.env.OPENAI_WIF_SERVICE_ACCOUNT_ID ||
      config.realtimeVoice?.wifServiceAccountId ||
      ""
    ).trim(),
    subjectToken: String(process.env.OPENAI_WIF_SUBJECT_TOKEN || "").trim(),
    subjectTokenFile: String(
      process.env.OPENAI_WIF_SUBJECT_TOKEN_FILE ||
      config.realtimeVoice?.wifSubjectTokenFile ||
      ""
    ).trim(),
    subjectTokenType: String(
      process.env.OPENAI_WIF_SUBJECT_TOKEN_TYPE ||
      config.realtimeVoice?.wifSubjectTokenType ||
      "urn:ietf:params:oauth:token-type:jwt"
    ).trim(),
    tokenUrl: OPENAI_WIF_TOKEN_URL
  };
}

function realtimeWifConfigured(settings) {
  return Boolean(
    settings.identityProviderId &&
    settings.serviceAccountId &&
    (settings.subjectToken || settings.subjectTokenFile)
  );
}

async function readRealtimeWifSubjectToken(settings) {
  if (settings.subjectToken) {
    return settings.subjectToken;
  }
  if (!settings.subjectTokenFile) {
    throw new Error("OPENAI WIF subject token is not configured");
  }
  const token = String(await readFile(settings.subjectTokenFile, "utf8")).trim();
  if (!token) {
    throw new Error("OPENAI WIF subject token file is empty");
  }
  return token;
}

async function exchangeRealtimeWifCredential(config, settings) {
  const subjectToken = await readRealtimeWifSubjectToken(settings);
  const cacheKey = sha256([
    settings.identityProviderId,
    settings.serviceAccountId,
    settings.subjectTokenType,
    subjectToken
  ].join("\n"));
  const refreshSkewMs = Math.max(
    10000,
    Number(config.realtimeVoice?.wifRefreshSkewMs) || DEFAULT_REALTIME_VOICE.wifRefreshSkewMs
  );
  if (realtimeWifCredentialCache?.cacheKey === cacheKey &&
      Date.now() + refreshSkewMs < realtimeWifCredentialCache.expiresAt) {
    return realtimeWifCredentialCache.token;
  }
  const timeoutMs = Math.max(
    1000,
    Number(config.realtimeVoice?.wifTokenTimeoutMs) || DEFAULT_REALTIME_VOICE.wifTokenTimeoutMs
  );
  const response = await fetch(settings.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: settings.subjectTokenType,
      subject_token: subjectToken,
      identity_provider_id: settings.identityProviderId,
      service_account_id: settings.serviceAccountId
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`OPENAI WIF token exchange failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  const token = String(payload?.access_token || "").trim();
  if (!token || String(payload?.token_type || "Bearer").toLowerCase() !== "bearer") {
    throw new Error("OPENAI WIF token exchange returned no bearer credential");
  }
  const lifetimeMs = Math.max(30000, Number(payload?.expires_in || 0) * 1000 || 60000);
  realtimeWifCredentialCache = {
    cacheKey,
    token,
    expiresAt: Date.now() + lifetimeMs
  };
  console.info(`[realtime-auth] openai credential=wif expires_in=${Math.round(lifetimeMs / 1000)}`);
  return token;
}

async function resolveRealtimeOpenAiCredential(config) {
  const mode = String(config.realtimeVoice?.authMode || "auto").trim().toLowerCase();
  if (!["auto", "wif", "api_key"].includes(mode)) {
    throw new Error("Invalid Realtime auth mode");
  }
  const settings = realtimeWifSettings(config);
  const apiKey = openAiApiKey();
  if (mode !== "api_key" && realtimeWifConfigured(settings)) {
    try {
      return {
        token: await exchangeRealtimeWifCredential(config, settings),
        source: "wif"
      };
    } catch (error) {
      const fallbackAllowed = config.realtimeVoice?.wifAllowApiKeyFallback !== false;
      if (!fallbackAllowed || !apiKey) {
        throw error;
      }
      console.warn(
        `[realtime-auth] wif_failed fallback=api_key err=${String(error.message || error).slice(0, 180)}`
      );
    }
  } else if (mode === "wif" && !realtimeWifConfigured(settings)) {
    const fallbackAllowed = config.realtimeVoice?.wifAllowApiKeyFallback !== false;
    if (!fallbackAllowed || !apiKey) {
      throw new Error("OPENAI WIF is required but not configured");
    }
    console.warn("[realtime-auth] wif_missing fallback=api_key");
  }
  if (!apiKey) {
    throw new Error("No OpenAI credential is configured for Realtime");
  }
  return { token: apiKey, source: "api_key" };
}

function safeWsSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  return true;
}

function safeWsSendThenClose(ws, payload, closeCode = 1008, closeReason = "rejected") {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  let closing = false;
  let fallbackTimer = null;
  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
    }
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(closeCode, closeReason);
      } catch {}
    }
  };
  fallbackTimer = setTimeout(close, 500);
  fallbackTimer.unref?.();
  try {
    ws.send(serialized, close);
  } catch {
    close();
    return false;
  }
  return true;
}

function wsErrorForLog(error) {
  const code = String(error?.code || "unknown")
    .replace(/[^A-Za-z0-9_.:-]/gu, "_")
    .slice(0, 80);
  const message = String(error?.message || "unknown")
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 240);
  return `code=${code} message=${JSON.stringify(message)}`;
}

function makeRealtimeBinaryFrame(type, sequence, pcm) {
  const audio = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const frame = Buffer.allocUnsafe(REALTIME_BINARY_FRAME_HEADER_BYTES + audio.length);
  frame[0] = type;
  frame[1] = REALTIME_BINARY_FRAME_VERSION;
  frame.writeUInt16LE(0, 2);
  frame.writeUInt32LE(sequence >>> 0, 4);
  audio.copy(frame, REALTIME_BINARY_FRAME_HEADER_BYTES);
  return frame;
}

function parseRealtimeBinaryFrame(raw) {
  const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  if (frame.length <= REALTIME_BINARY_FRAME_HEADER_BYTES ||
      frame[1] !== REALTIME_BINARY_FRAME_VERSION) {
    return null;
  }
  const pcm = frame.subarray(REALTIME_BINARY_FRAME_HEADER_BYTES);
  if ((pcm.length & 1) !== 0) {
    return null;
  }
  return {
    type: frame[0],
    sequence: frame.readUInt32LE(4),
    pcm
  };
}

function firmwareVersionAtLeast(value, minimum) {
  const parse = (item) => {
    const match = String(item || "").match(/^(\d+)\.(\d+)\.(\d+)/u);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const current = parse(value);
  const required = parse(minimum);
  if (!current || !required) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) {
      return current[index] > required[index];
    }
  }
  return true;
}

function safeWsSendBinary(ws, frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN ||
      Number(ws.bufferedAmount || 0) > REALTIME_MAX_BUFFERED_BYTES) {
    return false;
  }
  ws.send(frame, { binary: true });
  return true;
}

function realtimeInstructions(config, topic) {
  const base = String(config.realtimeVoice?.instructions || "").trim();
  const topicTitle = String(topic?.display_title || topic?.title || "Current topic").trim();
  const topicEmoji = String(topic?.emoji || topic?.icon || "").trim();
  return [
    "You are OpenClaw speaking live with Sergey through a tiny M5Stack Cardputer ADV.",
    REPLY_LANGUAGE_POLICY,
    "Prefer 1-2 spoken sentences. Do not do deep analysis in this realtime mode unless the user explicitly asks.",
    `Current Telegram/OpenClaw topic: ${topicEmoji ? `${topicEmoji} ` : ""}${topicTitle}.`,
    config.realtimeVoice?.s1ToolsEnabled === false
      ? ""
      : (
        "Use s1_run whenever the request needs S1 memory, current system state, private tools, an action outside the Cardputer, or deeper work. " +
        "For simple conversational replies, answer directly. Preserve any cardputer_actions marker returned by S1 exactly."
      ),
    "For local device actions, include the same machine marker protocol as the normal bridge after the spoken sentence.",
    buildDeviceActionPolicyText(),
    buildFirmwareCapabilityPolicyText(),
    base,
    REPLY_LANGUAGE_POLICY
  ].filter(Boolean).join(" ");
}

function realtimeTurnDetection(config) {
  const mode = String(config.realtimeVoice?.vadMode || DEFAULT_REALTIME_VOICE.vadMode)
    .trim()
    .toLowerCase();
  if (mode === "semantic_vad") {
    const requestedEagerness = String(
      config.realtimeVoice?.vadEagerness || DEFAULT_REALTIME_VOICE.vadEagerness
    ).trim().toLowerCase();
    const eagerness = ["low", "medium", "high", "auto"].includes(requestedEagerness)
      ? requestedEagerness
      : DEFAULT_REALTIME_VOICE.vadEagerness;
    return {
      type: "semantic_vad",
      eagerness,
      create_response: true,
      interrupt_response: true
    };
  }
  return {
    type: "server_vad",
    create_response: true,
    interrupt_response: true,
    threshold: Number(config.realtimeVoice?.vadThreshold ?? 0.5),
    prefix_padding_ms: Number(config.realtimeVoice?.vadPrefixPaddingMs ?? 300),
    silence_duration_ms: Number(
      config.realtimeVoice?.vadSilenceDurationMs ?? DEFAULT_REALTIME_VOICE.vadSilenceDurationMs
    )
  };
}

function realtimeS1Tools(config) {
  if (config.realtimeVoice?.s1ToolsEnabled === false) {
    return [];
  }
  return [{
    type: "function",
    name: "s1_run",
    description: (
      "Run a request inside the current S1/OpenClaw session. Use it for personal memory, " +
      "current system state, private tools, external actions, or work that needs more than a short live reply."
    ),
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "A complete, self-contained request for S1 in the user's language."
        }
      },
      required: ["request"],
      additionalProperties: false
    }
  }];
}

function redactRealtimeSensitiveText(value) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|device[_-]?token|password|secret)\b(\s*[:=]\s*)["']?[^\s"',}\]]+/giu,
      "$1$2[REDACTED]"
    );
}

async function openRealtimeModelSocket(config, topic, device) {
  const model = encodeURIComponent(String(config.realtimeVoice?.model || "gpt-realtime").trim());
  const inputRate = Number(config.realtimeVoice?.sampleRate) || DEFAULT_REALTIME_VOICE.sampleRate;
  const reasoningEffort = String(config.realtimeVoice?.reasoningEffort || "").trim();
  const safetyIdentifier = `cardputer-${sha256(String(device?.device_id || "unknown")).slice(0, 32)}`;
  const credential = await resolveRealtimeOpenAiCredential(config);
  const tools = realtimeS1Tools(config);
  const ws = new WebSocket(`${OPENAI_API_BASE.replace(/^http/u, "ws")}/realtime?model=${model}`, {
    headers: {
      ...openAiHeaders(credential.token),
      "OpenAI-Safety-Identifier": safetyIdentifier
    }
  });
  ws.realtimeAuthSource = credential.source;
  ws.once("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: String(config.realtimeVoice?.model || "gpt-realtime"),
        instructions: realtimeInstructions(config, topic),
        output_modalities: ["audio"],
        // Audio tokens share this budget with text/reasoning. 240 truncated
        // otherwise short spoken answers (e.g. slow counting to twenty).
        max_output_tokens: 2048,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: inputRate
            },
            transcription: {
              model: String(config.omnibotShim?.sttModel || "gpt-4o-mini-transcribe")
            },
            turn_detection: realtimeTurnDetection(config)
          },
          output: {
            format: {
              type: "audio/pcm",
              rate: inputRate
            },
            voice: String(config.realtimeVoice?.voice || config.omnibotShim?.ttsVoice || "alloy")
          }
        }
      }
    }));
  });
  return ws;
}

function realtimeFunctionCalls(event) {
  const calls = [];
  const add = (item) => {
    if (!item || item.type !== "function_call" || !item.call_id || !item.name) {
      return;
    }
    calls.push({
      callId: String(item.call_id),
      name: String(item.name),
      arguments: String(item.arguments || "{}"),
      responseAlreadyDone: event?.type === "response.done"
    });
  };
  if (event?.type === "response.output_item.done") {
    add(event.item);
  }
  if (event?.type === "response.function_call_arguments.done") {
    add({
      type: "function_call",
      call_id: event.call_id,
      name: event.name,
      arguments: event.arguments
    });
  }
  for (const item of event?.response?.output || []) {
    add(item);
  }
  return calls;
}

async function runRealtimeS1Tool({ runtime, device, topic, sessionId, call, inputTranscript, config }) {
  if (call.name !== "s1_run") {
    throw new Error(`unsupported realtime function ${call.name}`);
  }
  let args = null;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    throw new Error("s1_run arguments are invalid JSON");
  }
  const request = String(args?.request || "").trim();
  if (!request) {
    throw new Error("s1_run request is empty");
  }
  const replyStartedAtMs = Date.now();
  const clientMsgId = `${sessionId}:s1:${call.callId}`.slice(0, 96);
  const ack = await runtime.sendText({
    device,
    topicKey: topic.topic_key,
    clientMsgId,
    text: String(inputTranscript || request).trim(),
    upstreamText: runtime.buildDeviceTurnUpstreamText({
      device,
      topicKey: topic.topic_key,
      text: (
        "Realtime request from the authenticated Cardputer. Never return passwords, API keys, " +
        "OAuth tokens, device tokens, private keys, or other credential material. " +
        `Execute only within the existing S1 sender/tool policy.\n\n${request}`
      ),
      inputMode: "realtime_voice_tool"
    }),
    waitForUpstream: true
  });
  const reply = await runtime.waitForAssistantReply(
    topic.topic_key,
    ack.seq,
    Math.max(3000, Number(config.realtimeVoice?.s1ToolTimeoutMs) || DEFAULT_REALTIME_VOICE.s1ToolTimeoutMs),
    config.omnibotShim?.turnPollMs,
    replyStartedAtMs,
    ack
  );
  if (!reply) {
    throw new Error("S1 did not answer before the Realtime tool timeout");
  }
  const maxChars = Math.max(
    256,
    Number(config.realtimeVoice?.s1ToolMaxChars) || DEFAULT_REALTIME_VOICE.s1ToolMaxChars
  );
  return redactRealtimeSensitiveText(reply.content?.text || "").trim().slice(0, maxChars);
}

async function wireRealtimeBridge({
  clientWs,
  runtime,
  device,
  topic,
  config,
  binaryAudio = false,
  firmwareVersion = "unknown",
  openModelSocket = openRealtimeModelSocket
}) {
  const sessionId = makeId("rt");
  const startedAt = Date.now();
  let modelWs = null;
  let closed = false;
  let responseText = "";
  let inputTranscript = "";
  let speechStoppedAt = 0;
  let firstAudioAt = 0;
  let outputAudioSequence = 0;
  let pacedAudioBuffer = Buffer.alloc(0);
  let pacedAudioDonePending = false;
  let pacedResponseDonePending = null;
  let pacedAudioTimer = null;
  let lastInputAudioSequence = null;
  let readySent = false;
  let binaryInputFrames = 0;
  let binaryInputBytes = 0;
  let s1ToolCallsInFlight = 0;
  let s1ToolUsedForTurn = false;
  let pendingToolResponseDone = 0;
  let turnSequence = 0;
  let turnOpen = false;
  let turnAudioBytes = 0;
  let turnAudioTerminalSent = false;
  const handledToolCallIds = new Set();
  const outputSampleRate = Number(config.realtimeVoice?.sampleRate) || DEFAULT_REALTIME_VOICE.sampleRate;
  const outputPacingMs = Math.max(
    10,
    Math.min(100, Number(config.realtimeVoice?.deviceAudioPacingMs) || DEFAULT_REALTIME_VOICE.deviceAudioPacingMs)
  );
  // Recover after scheduling pauses at up to 30/20 ms, but bound total lead
  // to the fixed device buffers. Unbounded 1.5x delivery queues seconds of
  // audio before pong and falsely trips the device's 3s heartbeat timeout.
  const outputPacingChunkMs = Math.max(
    outputPacingMs,
    Math.min(
      100,
      Number(config.realtimeVoice?.deviceAudioPacingChunkMs) ||
        DEFAULT_REALTIME_VOICE.deviceAudioPacingChunkMs
    )
  );
  const outputPacingBytes = Math.max(
    2,
    Math.floor(outputSampleRate * 2 * outputPacingChunkMs / 1000 / 2) * 2
  );
  const maxPacedAudioBytes = Math.max(
    256 * 1024,
    Number(config.realtimeVoice?.maxPacedAudioBytes) || DEFAULT_REALTIME_VOICE.maxPacedAudioBytes
  );
  const pacedBinaryAudio = binaryAudio && firmwareVersionAtLeast(firmwareVersion, "0.2.125");
  const pacingBudget = new RealtimePacingBudget(outputSampleRate);

  const stopAudioPacer = () => {
    if (pacedAudioTimer) {
      clearInterval(pacedAudioTimer);
      pacedAudioTimer = null;
    }
    pacedAudioBuffer = Buffer.alloc(0);
    pacedAudioDonePending = false;
    pacedResponseDonePending = null;
  };

  const beginTurn = (text = "") => {
    turnSequence += 1;
    turnOpen = true;
    responseText = "";
    inputTranscript = String(text || "").trim();
    speechStoppedAt = 0;
    firstAudioAt = 0;
    turnAudioBytes = 0;
    turnAudioTerminalSent = false;
    s1ToolUsedForTurn = false;
  };

  const closeBoth = (reason = "closed") => {
    if (closed) {
      return;
    }
    closed = true;
    stopAudioPacer();
    try {
      if (modelWs && modelWs.readyState === WebSocket.OPEN) {
        modelWs.close();
      }
    } catch {}
    safeWsSend(clientWs, { type: "realtime.closed", session_id: sessionId, reason });
  };

  const pumpPacedAudio = () => {
    if (closed || !pacedBinaryAudio) {
      return;
    }
    if (clientWs.readyState !== WebSocket.OPEN) {
      stopAudioPacer();
      return;
    }
    if (pacedAudioBuffer.length > 0) {
      const chunkBytes = pacingBudget.take(performance.now(), pacedAudioBuffer.length, outputPacingBytes);
      if (chunkBytes > 0) {
        const chunk = pacedAudioBuffer.subarray(0, chunkBytes);
        const frame = makeRealtimeBinaryFrame(
          REALTIME_BINARY_OUTPUT_PCM,
          outputAudioSequence,
          chunk
        );
        outputAudioSequence = (outputAudioSequence + 1) >>> 0;
        if (!safeWsSendBinary(clientWs, frame)) {
          console.warn(`[realtime] device_backpressure session=${sessionId} buffered=${clientWs.bufferedAmount || 0}`);
          closeBoth("device_backpressure");
          try {
            clientWs.close();
          } catch {}
          return;
        }
        pacedAudioBuffer = Buffer.from(pacedAudioBuffer.subarray(chunkBytes));
      }
    }
    if (pacedAudioDonePending && pacedAudioBuffer.length === 0) {
      pacedAudioDonePending = false;
      safeWsSend(clientWs, { type: "audio.done", session_id: sessionId });
      turnAudioTerminalSent = true;
      console.info(`[realtime] audio_terminal session=${sessionId} bytes=${turnAudioBytes}`);
      // Firmware <=0.2.129 inferred that audio.done ended S1 thinking. Reassert
      // the explicit phase after a tool-call preamble drains for compatibility.
      if (s1ToolCallsInFlight > 0) {
        safeWsSend(clientWs, { type: "realtime.thinking", session_id: sessionId, phase: "s1" });
      }
    }
    if (pacedResponseDonePending && audioTerminalReady(pacedAudioBuffer.length, pacedAudioDonePending)) {
      safeWsSend(clientWs, pacedResponseDonePending);
      console.info(`[realtime] response_terminal session=${sessionId}`);
      pacedResponseDonePending = null;
    }
  };

  if (pacedBinaryAudio) {
    pacedAudioTimer = setInterval(pumpPacedAudio, outputPacingMs);
    pacedAudioTimer.unref?.();
  }

  const timeout = setTimeout(() => {
    closeBoth("session_timeout");
    try {
      clientWs.close();
    } catch {}
  }, Math.max(30000, Number(config.realtimeVoice?.maxSessionMs) || DEFAULT_REALTIME_VOICE.maxSessionMs));

  try {
    modelWs = await openModelSocket(config, topic, device);
  } catch (error) {
    clearTimeout(timeout);
    safeWsSend(clientWs, {
      type: "realtime.error",
      session_id: sessionId,
      message: String(error.message || error).slice(0, 240)
    });
    clientWs.close();
    return;
  }

  modelWs.on("open", () => {
    console.info(
      `[realtime] open device=${device.device_id} topic=${topic.topic_key} session=${sessionId} ` +
      `auth=${modelWs.realtimeAuthSource || "unknown"} vad=${realtimeTurnDetection(config).type} ` +
      `s1_tools=${config.realtimeVoice?.s1ToolsEnabled === false ? 0 : 1} ` +
      `firmware=${firmwareVersion} pacing_ms=${pacedBinaryAudio ? outputPacingMs : 0} ` +
      `pacing_chunk_ms=${pacedBinaryAudio ? outputPacingChunkMs : 0} ` +
      `pacing_max_lead_ms=${pacedBinaryAudio ? REALTIME_MAX_AUDIO_LEAD_MS : 0}`
    );
  });

  const handleS1ToolCall = async (call) => {
    if (!call?.callId || handledToolCallIds.has(call.callId)) {
      return;
    }
    handledToolCallIds.add(call.callId);
    s1ToolCallsInFlight += 1;
    s1ToolUsedForTurn = true;
    if (!call.responseAlreadyDone) {
      pendingToolResponseDone += 1;
    }
    safeWsSend(clientWs, { type: "realtime.thinking", session_id: sessionId, phase: "s1" });
    const toolStartedAt = Date.now();
    let output;
    try {
      const result = await runRealtimeS1Tool({
        runtime,
        device,
        topic,
        sessionId,
        call,
        inputTranscript,
        config
      });
      output = JSON.stringify({ ok: true, result, source: "s1" });
      console.info(
        `[realtime-tool] s1_done session=${sessionId} call=${call.callId.slice(0, 48)} ` +
        `ms=${Date.now() - toolStartedAt} chars=${result.length}`
      );
    } catch (error) {
      const message = redactRealtimeSensitiveText(error.message || error).slice(0, 500);
      output = JSON.stringify({ ok: false, error: message, source: "s1" });
      console.warn(
        `[realtime-tool] s1_failed session=${sessionId} call=${call.callId.slice(0, 48)} ` +
        `ms=${Date.now() - toolStartedAt} err=${message}`
      );
    }
    if (modelWs?.readyState === WebSocket.OPEN && !closed) {
      responseText = "";
      firstAudioAt = 0;
      // Keep phase=s1 asserted until the final response.done. Clearing it here
      // exposes the completed tool-preamble audio.done to the device's missing
      // terminal watchdog before the final response has produced any audio.
      modelWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.callId,
          output
        }
      }));
      modelWs.send(JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: (
            `${realtimeInstructions(config, topic)} Briefly tell the user the S1 result. ` +
            "Preserve any cardputer_actions marker from the tool result exactly."
          )
        }
      }));
    }
    s1ToolCallsInFlight = Math.max(0, s1ToolCallsInFlight - 1);
  };

  modelWs.on("message", async (raw) => {
    let event = null;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    const type = String(event?.type || "");
    const functionCalls = realtimeFunctionCalls(event);
    if (functionCalls.length > 0) {
      for (const call of functionCalls) {
        void handleS1ToolCall(call);
      }
      if (type === "response.done" && pendingToolResponseDone > 0) {
        pendingToolResponseDone -= 1;
        console.info(
          `[realtime-tool] tool_response_done session=${sessionId} pending=${pendingToolResponseDone}`
        );
      }
      return;
    }
    if (type === "session.updated" && !readySent) {
      readySent = true;
      safeWsSend(clientWs, {
        type: "realtime.ready",
        session_id: sessionId,
        model: config.realtimeVoice?.model || "gpt-realtime",
        sample_rate: Number(config.realtimeVoice?.sampleRate) || DEFAULT_REALTIME_VOICE.sampleRate,
        audio_transport: binaryAudio ? "binary-v1" : "json-base64-v1",
        vad_mode: realtimeTurnDetection(config).type,
        s1_tools: config.realtimeVoice?.s1ToolsEnabled !== false,
        auth_source: modelWs.realtimeAuthSource || "unknown"
      });
      return;
    }
    if ((type === "response.audio.delta" || type === "response.output_audio.delta") && event.delta) {
      if (firstAudioAt === 0) {
        firstAudioAt = Date.now();
        console.info(
          `[realtime] first_audio session=${sessionId} ` +
          `after_speech_stop_ms=${speechStoppedAt > 0 ? firstAudioAt - speechStoppedAt : -1}`
        );
      }
      const audio = String(event.delta || "");
      if (binaryAudio) {
        const pcm = Buffer.from(audio, "base64");
        turnAudioBytes += pcm.length;
        if (pacedBinaryAudio && pcm.length > 0) {
          if (pacedAudioBuffer.length + pcm.length > maxPacedAudioBytes) {
            console.warn(
              `[realtime] paced_audio_overflow session=${sessionId} ` +
              `queued=${pacedAudioBuffer.length} incoming=${pcm.length}`
            );
            closeBoth("paced_audio_overflow");
            try {
              clientWs.close();
            } catch {}
            return;
          }
          pacedAudioBuffer = pacedAudioBuffer.length === 0
            ? Buffer.from(pcm)
            : Buffer.concat([pacedAudioBuffer, pcm]);
        } else if (!pacedBinaryAudio && pcm.length > 0) {
          const requestedChunkBytes = Math.max(
            1024,
            Number(config.realtimeVoice?.deviceAudioDeltaBytes) || REALTIME_DEVICE_AUDIO_DELTA_BYTES
          );
          const chunkBytes = Math.max(1024, Math.floor(requestedChunkBytes / 2) * 2);
          for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
            const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
            const frame = makeRealtimeBinaryFrame(
              REALTIME_BINARY_OUTPUT_PCM,
              outputAudioSequence,
              chunk
            );
            outputAudioSequence = (outputAudioSequence + 1) >>> 0;
            if (!safeWsSendBinary(clientWs, frame)) {
              console.warn(`[realtime] device_backpressure session=${sessionId} buffered=${clientWs.bufferedAmount || 0}`);
              closeBoth("device_backpressure");
              try {
                clientWs.close();
              } catch {}
              return;
            }
          }
        }
        return;
      }
      const requestedChunkSize = Math.max(
        1024,
        Number(config.realtimeVoice?.deviceAudioDeltaChars) || REALTIME_DEVICE_AUDIO_DELTA_CHARS
      );
      const chunkSize = Math.max(1024, requestedChunkSize - (requestedChunkSize % 4));
      for (let offset = 0; offset < audio.length; offset += chunkSize) {
        safeWsSend(clientWs, {
          type: "audio.delta",
          session_id: sessionId,
          audio: audio.slice(offset, offset + chunkSize),
          sample_rate: Number(config.realtimeVoice?.sampleRate) || DEFAULT_REALTIME_VOICE.sampleRate
        });
      }
      return;
    }
    if (type === "response.audio.done" || type === "response.output_audio.done") {
      if (pacedBinaryAudio) {
        pacedAudioDonePending = true;
        if (pacedAudioBuffer.length === 0) {
          pumpPacedAudio();
        }
        return;
      }
      safeWsSend(clientWs, { type: "audio.done", session_id: sessionId });
      turnAudioTerminalSent = true;
      if (s1ToolCallsInFlight > 0) {
        safeWsSend(clientWs, { type: "realtime.thinking", session_id: sessionId, phase: "s1" });
      }
      return;
    }
    if ((type === "response.audio_transcript.delta" || type === "response.output_audio_transcript.delta" ||
         type === "response.text.delta" ||
         type === "response.output_text.delta") && event.delta) {
      responseText += String(event.delta || "");
      safeWsSend(clientWs, { type: "text.delta", session_id: sessionId, delta: String(event.delta || "") });
      return;
    }
    if ((type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done" ||
         type === "response.text.done" ||
         type === "response.output_text.done") && (event.transcript || event.text)) {
      responseText = String(event.transcript || event.text || responseText || "").trim();
      safeWsSend(clientWs, { type: "text.done", session_id: sessionId, text: responseText });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      inputTranscript = String(event.transcript || "").trim();
      safeWsSend(clientWs, { type: "transcript.done", session_id: sessionId, text: inputTranscript });
      return;
    }
    if (type === "input_audio_buffer.speech_started") {
      beginTurn();
      safeWsSend(clientWs, { type: "speech.started", session_id: sessionId });
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      speechStoppedAt = Date.now();
      safeWsSend(clientWs, { type: "speech.stopped", session_id: sessionId });
      return;
    }
    if (type === "response.done") {
      if (pendingToolResponseDone > 0) {
        pendingToolResponseDone -= 1;
        console.info(
          `[realtime-tool] tool_response_done session=${sessionId} pending=${pendingToolResponseDone}`
        );
        return;
      }
      if (s1ToolCallsInFlight > 0) {
        console.info(
          `[realtime-tool] response_waiting session=${sessionId} inflight=${s1ToolCallsInFlight}`
        );
        return;
      }
      if (!turnOpen) {
        beginTurn(inputTranscript);
      }
      const responseDoneAt = Date.now();
      console.info(
        `[realtime] response_done session=${sessionId} ` +
        `status=${event.response?.status || "unknown"} reason=${event.response?.status_details?.reason || event.response?.status_details?.error?.code || "-"} output_tokens=${event.response?.usage?.output_tokens ?? -1} audio_tokens=${event.response?.usage?.output_token_details?.audio_tokens ?? -1} paced_bytes=${pacedAudioBuffer.length} ` +
        `after_speech_stop_ms=${speechStoppedAt > 0 ? responseDoneAt - speechStoppedAt : -1} ` +
        `first_audio_ms=${speechStoppedAt > 0 && firstAudioAt > 0 ? firstAudioAt - speechStoppedAt : -1}`
      );
      const extracted = extractDeviceActionsFromText(responseText);
      const actions = alignFocusActionMinutes(extracted.actions, extracted.visibleText, responseText, inputTranscript);
      if (actions.length > 0) {
        safeWsSend(clientWs, {
          type: "device_actions",
          session_id: sessionId,
          actions
        });
      }
      // Complete the device turn independently of history persistence. A slow
      // store must not strand a drained speaker behind its stream watchdog.
      const responseTerminal = { type: "response.done", session_id: sessionId, text: stripMarkdownForDevice(extracted.visibleText || responseText) };
      if (pacedBinaryAudio && turnAudioBytes > 0 && !turnAudioTerminalSent) pacedAudioDonePending = true;
      if (pacedBinaryAudio && !audioTerminalReady(pacedAudioBuffer.length, pacedAudioDonePending)) {
        pacedResponseDonePending = responseTerminal;
      } else {
        safeWsSend(clientWs, responseTerminal);
        console.info(`[realtime] response_terminal session=${sessionId}`);
      }
      const storedInput = inputTranscript;
      const storedResponse = responseText;
      const storedTurnSequence = turnSequence;
      const storedWithS1 = s1ToolUsedForTurn;
      turnOpen = false;
      try {
        if (storedInput && !storedWithS1) {
          await runtime.appendDeviceText({
            device,
            topicKey: topic.topic_key,
            clientMsgId: `${sessionId}:turn:${storedTurnSequence}:user`,
            text: storedInput,
            source: "cardputer_realtime"
          });
        }
        const visible = stripMarkdownForDevice(extracted.visibleText || storedResponse).trim();
        if (visible && !storedWithS1) {
          await runtime.appendAssistantReply({
            topicKey: topic.topic_key,
            text: visible,
            clientMsgId: `${sessionId}:turn:${storedTurnSequence}:assistant`,
            source: "cardputer_realtime",
            queueDeviceEvent: false
          });
        }
      } catch (error) {
        console.warn(`[realtime] store_failed session=${sessionId} err=${String(error.message || error).slice(0, 240)}`);
      }
      return;
    }
    if (type === "error") {
      const message = String(event?.error?.message || event?.message || "realtime error").slice(0, 240);
      console.warn(`[realtime] model_error session=${sessionId} err=${message}`);
      safeWsSend(clientWs, { type: "realtime.error", session_id: sessionId, message });
    }
  });

  modelWs.on("error", (error) => {
    console.warn(`[realtime] model_ws_error session=${sessionId} err=${String(error.message || error).slice(0, 240)}`);
    safeWsSend(clientWs, {
      type: "realtime.error",
      session_id: sessionId,
      message: String(error.message || error).slice(0, 240)
    });
  });

  modelWs.on("close", () => {
    clearTimeout(timeout);
    stopAudioPacer();
    if (!closed) {
      console.info(`[realtime] model_closed device=${device.device_id} session=${sessionId} ms=${Date.now() - startedAt}`);
      closed = true;
      safeWsSendThenClose(
        clientWs,
        { type: "realtime.closed", session_id: sessionId, reason: "model_closed" },
        1011,
        "model closed"
      );
    }
  });

  clientWs.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (!binaryAudio) {
        safeWsSend(clientWs, { type: "protocol_error", message: "binary audio was not negotiated" });
        return;
      }
      if (!modelWs || modelWs.readyState !== WebSocket.OPEN) {
        safeWsSend(clientWs, { type: "realtime.wait", session_id: sessionId });
        return;
      }
      const frame = parseRealtimeBinaryFrame(raw);
      if (!frame || frame.type !== REALTIME_BINARY_INPUT_PCM) {
        safeWsSend(clientWs, { type: "protocol_error", message: "invalid binary audio frame" });
        return;
      }
      if (lastInputAudioSequence !== null &&
          frame.sequence !== ((lastInputAudioSequence + 1) >>> 0)) {
        console.warn(
          `[realtime] input_sequence_gap session=${sessionId} ` +
          `expected=${(lastInputAudioSequence + 1) >>> 0} got=${frame.sequence}`
        );
      }
      lastInputAudioSequence = frame.sequence;
      if (Number(modelWs.bufferedAmount || 0) > REALTIME_MAX_BUFFERED_BYTES) {
        console.warn(`[realtime] model_backpressure session=${sessionId} buffered=${modelWs.bufferedAmount || 0}`);
        closeBoth("model_backpressure");
        try {
          clientWs.close();
        } catch {}
        return;
      }
      modelWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: frame.pcm.toString("base64")
      }));
      binaryInputFrames += 1;
      binaryInputBytes += frame.pcm.length;
      if (binaryInputFrames === 1) {
        console.info(
          `[realtime] binary_input_first session=${sessionId} ` +
          `seq=${frame.sequence} bytes=${frame.pcm.length}`
        );
      }
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      safeWsSend(clientWs, { type: "protocol_error", message: "invalid json" });
      return;
    }
    if (!modelWs || modelWs.readyState !== WebSocket.OPEN) {
      safeWsSend(clientWs, { type: "realtime.wait", session_id: sessionId });
      return;
    }
    const type = String(payload?.type || "");
    if (type === "audio.append") {
      const audio = String(payload.audio || "");
      if (audio) {
        modelWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      }
      return;
    }
    if (type === "audio.commit") {
      if (!turnOpen) {
        beginTurn();
      }
      if (binaryAudio) {
        console.info(
          `[realtime] binary_input_commit session=${sessionId} ` +
          `frames=${binaryInputFrames} bytes=${binaryInputBytes}`
        );
      }
      modelWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      modelWs.send(JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: realtimeInstructions(config, topic)
        }
      }));
      safeWsSend(clientWs, { type: "realtime.thinking", session_id: sessionId });
      return;
    }
    if (type === "text.send") {
      const text = String(payload.text || "").trim();
      if (text) {
        beginTurn(text);
        modelWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }]
          }
        }));
        modelWs.send(JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: realtimeInstructions(config, topic)
          }
        }));
      }
      return;
    }
    if (type === "close") {
      const clientReason = String(payload.reason || "unspecified")
        .replace(/[\r\n\t]/gu, " ")
        .slice(0, 96);
      console.info(
        `[realtime] client_close device=${device.device_id} session=${sessionId} ` +
        `reason=${JSON.stringify(clientReason)}`
      );
      closeBoth("client_close");
      try {
        clientWs.close();
      } catch {}
      return;
    }
    safeWsSend(clientWs, { type: "protocol_error", message: `unsupported realtime event: ${type}` });
  });

  clientWs.on("close", (code, reason) => {
    clearTimeout(timeout);
    stopAudioPacer();
    console.info(
      `[realtime] device_closed device=${device.device_id} session=${sessionId} ` +
      `code=${Number(code || 0)} reason_bytes=${Buffer.byteLength(reason || "")} ms=${Date.now() - startedAt}`
    );
    if (modelWs && modelWs.readyState === WebSocket.OPEN) {
      modelWs.close();
    }
  });
  clientWs.on("error", () => {
    clearTimeout(timeout);
  });
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) {
      return null;
    }
    const normalized = part.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractCodexAccountId(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function codexAccessExpiresAt(accessToken) {
  const expiresAtSeconds = Number(decodeJwtPayload(accessToken)?.exp || 0);
  return Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0
    ? expiresAtSeconds * 1000
    : 0;
}

async function readCodexAuthStore(authStorePath) {
  const store = JSON.parse(await readFile(authStorePath, "utf8"));
  const nativeTokens = store?.tokens;
  if (nativeTokens && typeof nativeTokens === "object") {
    const access = String(nativeTokens.access_token || "").trim();
    const refresh = String(nativeTokens.refresh_token || "").trim();
    if (!refresh) {
      throw new Error("codex_oauth_refresh_missing");
    }
    return {
      format: "codex-cli",
      store,
      profile: {
        provider: "openai-codex",
        type: "oauth",
        access,
        refresh,
        idToken: String(nativeTokens.id_token || "").trim(),
        expires: codexAccessExpiresAt(access),
        accountId: String(nativeTokens.account_id || "").trim() || extractCodexAccountId(access)
      }
    };
  }
  const profiles = store?.profiles && typeof store.profiles === "object" ? store.profiles : store;
  if (!profiles || typeof profiles !== "object") {
    throw new Error("codex_oauth_profiles_missing");
  }
  const entry = Object.entries(profiles).find(([, profile]) =>
    profile &&
    typeof profile === "object" &&
    profile.provider === "openai-codex" &&
    profile.type === "oauth"
  );
  if (!entry) {
    throw new Error("codex_oauth_profile_missing");
  }
  return {
    format: "openclaw-profiles",
    store,
    profiles,
    profileKey: entry[0],
    profile: entry[1]
  };
}

async function writeCodexAuthStore(authStorePath, store) {
  const tmpPath = `${authStorePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, authStorePath);
  await chmod(authStorePath, 0o600).catch(() => {});
}

async function refreshCodexOAuthProfile(authStorePath, profile) {
  const refreshToken = String(profile?.refresh || "").trim();
  if (!refreshToken) {
    throw new Error("codex_oauth_refresh_missing");
  }
  const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error(detail ? `codex_oauth_refresh_failed_${response.status}: ${detail}` : `codex_oauth_refresh_failed_${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.access_token || !payload?.refresh_token || typeof payload.expires_in !== "number") {
    throw new Error("codex_oauth_refresh_invalid_response");
  }
  return {
    ...profile,
    access: payload.access_token,
    refresh: payload.refresh_token,
    idToken: payload.id_token || profile.idToken,
    expires: Date.now() + payload.expires_in * 1000,
    accountId: extractCodexAccountId(payload.access_token) || profile.accountId
  };
}

async function persistCodexOAuthProfile(authStorePath, loaded, refreshed) {
  if (loaded.format === "codex-cli") {
    loaded.store.tokens = {
      ...(loaded.store.tokens || {}),
      access_token: refreshed.access,
      refresh_token: refreshed.refresh,
      id_token: refreshed.idToken || loaded.store.tokens?.id_token,
      account_id: refreshed.accountId || loaded.store.tokens?.account_id
    };
    loaded.store.last_refresh = new Date().toISOString();
  } else {
    loaded.profiles[loaded.profileKey] = refreshed;
  }
  await writeCodexAuthStore(authStorePath, loaded.store);
}

async function resolveCodexOAuthAccessToken({ authStorePath, refreshSkewMs = 120000 }) {
  const cleanedPath = String(authStorePath || "").trim();
  if (!cleanedPath) {
    throw new Error("codex_oauth_store_missing");
  }
  const skewMs = Math.max(30000, Number(refreshSkewMs) || 120000);
  const current = await readCodexAuthStore(cleanedPath);
  const currentAccess = String(current.profile?.access || "").trim();
  const currentExpires = Number(current.profile?.expires || 0);
  if (currentAccess && (!currentExpires || currentExpires > Date.now() + skewMs)) {
    return currentAccess;
  }
  const existingRefresh = codexOAuthRefreshInFlight.get(cleanedPath);
  if (existingRefresh) {
    return await existingRefresh;
  }
  const refreshPromise = (async () => {
    const loaded = await readCodexAuthStore(cleanedPath);
    const access = String(loaded.profile?.access || "").trim();
    const expires = Number(loaded.profile?.expires || 0);
    if (access && (!expires || expires > Date.now() + skewMs)) {
      return access;
    }
    const refreshed = await refreshCodexOAuthProfile(cleanedPath, loaded.profile);
    await persistCodexOAuthProfile(cleanedPath, loaded, refreshed);
    return refreshed.access;
  })();
  codexOAuthRefreshInFlight.set(cleanedPath, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (codexOAuthRefreshInFlight.get(cleanedPath) === refreshPromise) {
      codexOAuthRefreshInFlight.delete(cleanedPath);
    }
  }
}

async function openAiError(response, prefix) {
  let detail = "";
  try {
    const payload = await response.json();
    const error = payload?.error;
    if (typeof error === "string") {
      detail = error.trim();
    } else if (error && typeof error === "object") {
      detail = String(error.message || error.code || "").trim();
    }
  } catch {
    detail = "";
  }
  if (!detail) {
    try {
      detail = (await response.text()).trim().slice(0, 300);
    } catch {
      detail = "";
    }
  }
  throw new Error(detail ? `${prefix} (${response.status}): ${detail}` : `${prefix} (${response.status})`);
}

async function transcribeOpenAiAudio({ audioBytes, filename = "cardputer.wav", model, language = "", timeoutMs = 20000 }) {
  if (!audioBytes?.length) {
    return "";
  }
  const apiKey = openAiApiKey();
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", "Cardputer ADV, M5Stack, OpenClaw, S1-ADV, OTA.");
  if (String(language || "").trim()) {
    form.set("language", String(language || "").trim());
  }
  form.set("file", new Blob([audioBytes], { type: "audio/wav" }), filename);
  const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: openAiHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 20000))
  });
  if (!response.ok) {
    await openAiError(response, "OpenAI transcription failed");
  }
  const payload = await response.json();
  return typeof payload?.text === "string" ? payload.text.trim() : "";
}

async function transcribeGeminiAudio({ audioBytes, mimeType = "audio/wav", model = "gemini-2.5-flash-lite", apiKey }) {
  if (!audioBytes?.length) {
    return "";
  }
  const cleanedKey = String(apiKey || "").trim();
  if (!cleanedKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  const cleanedModel = String(model || "gemini-2.5-flash-lite").trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanedModel)}:generateContent?key=${encodeURIComponent(cleanedKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Transcribe this speech audio. Return only the spoken words in the original language. Do not translate. No commentary, no markdown."
            },
            {
              inline_data: {
                mime_type: mimeType || "audio/wav",
                data: Buffer.from(audioBytes).toString("base64")
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 512
      }
    }),
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(async () => ({ error: { message: await response.text().catch(() => "") } }));
  if (!response.ok) {
    const detail = String(payload?.error?.message || payload?.error || "").slice(0, 300);
    throw new Error(detail ? `Gemini transcription failed (${response.status}): ${detail}` : `Gemini transcription failed (${response.status})`);
  }
  const text = (Array.isArray(payload?.candidates) ? payload.candidates : [])
    .flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    .map((part) => String(part?.text || ""))
    .join("")
    .trim();
  return cleanupTranscriptText(text);
}

async function transcribeLocalWhisper(config, { audioBytes, language = "" }) {
  if (!audioBytes?.length) {
    return "";
  }
  const bin = String(config.omnibotShim?.sttLocalBin || "").trim();
  const model = String(config.omnibotShim?.sttLocalModel || "").trim();
  if (!bin || !model) {
    throw new Error("local_whisper_not_configured");
  }
  const runId = makeId("stt");
  const inputPath = path.join(config.media.tmpDir, `${runId}.wav`);
  const outputPrefix = path.join(config.media.tmpDir, runId);
  const outputPath = `${outputPrefix}.txt`;
  await ensureDir(config.media.tmpDir);
  await writeFile(inputPath, audioBytes, { mode: 0o600 });
  const configuredLanguage = String(language || config.omnibotShim?.sttLocalLanguage || "auto").trim();
  const args = [
    "-m", model,
    "-f", inputPath,
    "-of", outputPrefix,
    "-otxt",
    "-nt",
    "-np",
    "-t", String(Math.max(1, Number(config.omnibotShim?.sttLocalThreads) || 4))
  ];
  if (configuredLanguage && configuredLanguage !== "auto") {
    args.push("-l", configuredLanguage);
  }
  const timeoutMs = Math.max(1000, Number(config.omnibotShim?.sttTimeoutMs) || DEFAULT_OMNIBOT_SHIM.sttTimeoutMs);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
      const stderr = [];
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`local_whisper_timeout_${timeoutMs}ms`));
      }, timeoutMs);
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`local_whisper_failed_${code}: ${Buffer.concat(stderr).toString("utf8").trim().slice(0, 240)}`));
        }
      });
    });
    return cleanupTranscriptText(await readFile(outputPath, "utf8"));
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(outputPath, { force: true })
    ]);
  }
}

function cleanupTranscriptText(text) {
  let cleaned = String(text || "").trim();
  cleaned = cleaned
    .replace(/^here(?:'s| is)\s+the\s+transcript\s+of\s+the\s+audio\s*:\s*/iu, "")
    .replace(/^transcript\s*:\s*/iu, "")
    .replace(/^["“”]+|["“”]+$/gu, "")
    .trim();
  if (/cannot transcribe|audio file is empty|provide a valid audio/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

async function transcribeDeviceAudio(config, { audioBytes, filename = "cardputer.wav", mimeType = "audio/wav", language = "" }) {
  const provider = String(config.omnibotShim?.sttProvider || "local-whisper").trim().toLowerCase();
  if (provider === "local-whisper" || provider === "whisper-local" || provider === "whisper.cpp") {
    return await transcribeLocalWhisper(config, { audioBytes, language });
  }
  if (provider !== "openai" && provider !== "openai-api") {
    throw new Error(`unsupported_stt_provider_${provider || "missing"}`);
  }
  try {
    return await transcribeOpenAiAudio({
      audioBytes,
      filename,
      model: config.omnibotShim.sttModel,
      language,
      timeoutMs: config.omnibotShim.sttTimeoutMs
    });
  } catch (error) {
    const fallbackProvider = String(config.omnibotShim?.sttFallbackProvider || "").toLowerCase();
    const key = geminiApiKey(config);
    if (fallbackProvider !== "gemini" || !key) {
      throw error;
    }
    console.warn(`[stt] openai_failed fallback=gemini err=${String(error.message || error).slice(0, 240)}`);
    return await transcribeGeminiAudio({
      audioBytes,
      mimeType,
      model: config.omnibotShim.sttGeminiModel,
      apiKey: key
    });
  }
}

async function synthesizeOpenAiTtsPcm({ text, model, voice, timeoutMs = 0 }) {
  const cleaned = String(text || "").trim().slice(0, 2000);
  if (!cleaned) {
    return Buffer.alloc(0);
  }
  const apiKey = openAiApiKey();
  const controller = new AbortController();
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`OpenAI TTS timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;
  const response = await fetch(`${OPENAI_API_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      ...openAiHeaders(apiKey),
      "Content-Type": "application/json"
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      voice,
      input: cleaned,
      response_format: "pcm"
    })
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
  if (!response.ok) {
    await openAiError(response, "OpenAI TTS failed");
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function containsCyrillic(text) {
  return /[\u0400-\u04ff]/u.test(String(text || ""));
}

async function synthesizeEspeakTtsWav({ text, bin = "espeak-ng", voice = "en-us", timeoutMs = 12000 }) {
  const cleaned = String(text || "").trim().slice(0, 2000);
  if (!cleaned) {
    return Buffer.alloc(0);
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(bin, ["-v", voice, "-s", "165", "--stdout", "--", cleaned], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`espeak_timeout_${timeoutMs}ms`));
    }, Math.max(1000, Number(timeoutMs) || 12000));
    let outputBytes = 0;
    child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 12 * 1024 * 1024) { child.kill("SIGKILL"); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", chunk => { if (errChunks.length < 16) errChunks.push(Buffer.from(chunk)); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(normalizeWavHeaderSizes(Buffer.concat(chunks)));
        return;
      }
      const detail = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 240);
      reject(new Error(detail ? `espeak_exited_${code}: ${detail}` : `espeak_exited_${code}`));
    });
  });
}

function normalizeWavHeaderSizes(buffer) {
  if (!buffer || buffer.length < 44) {
    return buffer;
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return buffer;
  }
  const dataPos = buffer.indexOf("data", 12, "ascii");
  if (dataPos < 0 || dataPos + 8 > buffer.length) {
    return buffer;
  }
  const out = Buffer.from(buffer);
  out.writeUInt32LE(Math.max(0, out.length - 8), 4);
  out.writeUInt32LE(Math.max(0, out.length - dataPos - 8), dataPos + 4);
  return out;
}

async function completeOpenAiChat({ messages, model, maxTokens, temperature, timeoutMs }) {
  const cleanedModel = String(model || "").trim();
  if (!cleanedModel) {
    throw new Error("fast_lane_model_missing");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 9000));
  try {
    const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        ...openAiHeaders(openAiApiKey()),
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cleanedModel,
        messages,
        max_tokens: Math.max(16, Number(maxTokens) || 180),
        temperature: Math.max(0, Math.min(1, Number(temperature) || 0))
      })
    });
    if (!response.ok) {
      await openAiError(response, "OpenAI fast lane failed");
    }
    const payload = await response.json();
    const text = String(payload?.choices?.[0]?.message?.content || "").trim();
    if (!text) {
      throw new Error("fast_lane_empty_reply");
    }
    return {
      text,
      model: payload?.model || cleanedModel
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`fast_lane_timeout_${Math.max(1000, Number(timeoutMs) || 9000)}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractResponsesText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const chunks = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") {
        chunks.push(content.text);
      }
      if (typeof content?.transcript === "string") {
        chunks.push(content.transcript);
      }
    }
  }
  return chunks.join("").trim();
}

async function completeOpenAiResponses({ messages, model, maxTokens, timeoutMs, reasoningEffort, verbosity }) {
  const cleanedModel = String(model || "").trim();
  if (!cleanedModel) {
    throw new Error("fast_lane_model_missing");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 9000));
  try {
    const response = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        ...openAiHeaders(openAiApiKey()),
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cleanedModel,
        input: messages.map((message) => ({
          role: message.role,
          content: [
            {
              type: "input_text",
              text: String(message.content || "")
            }
          ]
        })),
        max_output_tokens: Math.max(16, Number(maxTokens) || 120),
        reasoning: {
          effort: String(reasoningEffort || "minimal")
        },
        text: {
          verbosity: String(verbosity || "low")
        }
      })
    });
    if (!response.ok) {
      await openAiError(response, "OpenAI fast lane failed");
    }
    const payload = await response.json();
    const text = extractResponsesText(payload);
    if (!text) {
      const incompleteReason = payload?.incomplete_details?.reason;
      if (payload?.status === "incomplete" && incompleteReason) {
        throw new Error(`fast_lane_incomplete_${incompleteReason}`);
      }
      throw new Error("fast_lane_empty_reply");
    }
    return {
      text,
      model: payload?.model || cleanedModel
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`fast_lane_timeout_${Math.max(1000, Number(timeoutMs) || 9000)}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCodexModelId(model) {
  const cleaned = String(model || "").trim();
  if (!cleaned) {
    throw new Error("codex_model_missing");
  }
  return cleaned.replace(/^openai-codex\//u, "");
}

function parseCodexResponsesSse(raw) {
  const textDeltas = [];
  const doneTexts = [];
  const errors = [];
  for (const line of String(raw || "").split(/\r?\n/u)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      textDeltas.push(event.delta);
      continue;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "message") {
      const itemText = (Array.isArray(event.item.content) ? event.item.content : [])
        .map((part) => String(part?.text || part?.refusal || ""))
        .join("");
      if (itemText) {
        doneTexts.push(itemText);
      }
      continue;
    }
    if (event.type === "response.failed") {
      const err = event.response?.error;
      errors.push(String(err?.message || err?.code || event.response?.incomplete_details?.reason || "response.failed"));
      continue;
    }
    if (event.type === "error") {
      errors.push(String(event.message || event.code || "codex_stream_error"));
    }
  }
  const text = (textDeltas.length > 0 ? textDeltas.join("") : doneTexts.join("\n")).trim();
  if (!text && errors.length > 0) {
    throw new Error(errors.join("; ").slice(0, 500));
  }
  return text;
}

async function completeCodexOAuthResponses({
  messages,
  model,
  timeoutMs,
  reasoningEffort,
  verbosity,
  authStorePath,
  refreshSkewMs
}) {
  const cleanedModel = normalizeCodexModelId(model);
  const system = messages.find((message) => message.role === "system")?.content || "";
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [
        {
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: String(message.content || "")
        }
      ]
    }));
  if (input.length === 0) {
    throw new Error("codex_input_missing");
  }
  const accessToken = await resolveCodexOAuthAccessToken({
    authStorePath,
    refreshSkewMs
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 9000));
  try {
    const response = await fetch(OPENAI_CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cleanedModel,
        instructions: String(system || "Answer briefly."),
        input,
        stream: true,
        store: false,
        reasoning: {
          effort: String(reasoningEffort || "low")
        },
        text: {
          verbosity: String(verbosity || "low")
        }
      })
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.trim().slice(0, 300);
      try {
        const payload = JSON.parse(raw);
        detail = String(payload?.detail || payload?.error?.message || detail).slice(0, 300);
      } catch {
        // keep raw detail
      }
      throw new Error(detail ? `Codex OAuth fast lane failed (${response.status}): ${detail}` : `Codex OAuth fast lane failed (${response.status})`);
    }
    const text = parseCodexResponsesSse(raw);
    if (!text) {
      throw new Error("codex_fast_lane_empty_reply");
    }
    return {
      text,
      model: `openai-codex/${cleanedModel}`
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`codex_fast_lane_timeout_${Math.max(1000, Number(timeoutMs) || 9000)}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function downsamplePcm16Mono(buffer, fromRate, toRate) {
  if (!buffer?.length || !fromRate || !toRate || fromRate === toRate) {
    return buffer;
  }
  if (fromRate % toRate !== 0) {
    return buffer;
  }
  const factor = Math.max(1, Math.floor(fromRate / toRate));
  if (factor <= 1) {
    return buffer;
  }
  const sampleCount = Math.floor(buffer.length / 2);
  const out = Buffer.alloc(Math.floor(sampleCount / factor) * 2);
  let outOffset = 0;
  for (let i = 0; i + factor <= sampleCount; i += factor) {
    let acc = 0;
    for (let j = 0; j < factor; j += 1) {
      acc += buffer.readInt16LE((i + j) * 2);
    }
    const averaged = Math.max(-32768, Math.min(32767, Math.round(acc / factor)));
    out.writeInt16LE(averaged, outOffset);
    outOffset += 2;
  }
  return out;
}

function createWavHeader(dataSize, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  const fileSize = 36 + dataSize;
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

function inferSenderKindFromRole(role) {
  if (role === "assistant") {
    return "assistant";
  }
  return "human";
}

function canonicalizeMirrorText(text) {
  if (typeof text !== "string") {
    return "";
  }
  return stripTelegramEnvelope(
    unwrapCardputerEnvelope(text)
    .replace(
      /Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/g,
      "",
    )
    .replace(
      /Cardputer runtime context \(bridge metadata\):\s*```json[\s\S]*?```\s*/g,
      "",
    )
    .replace(
      /Cardputer reply policy \(bridge metadata\):\s*```json[\s\S]*?```\s*/g,
      "",
    )
    .replace(/^\[Audio\]\s*/u, "")
    .replace(/^\[[^\]]+\]\s*/u, "")
    .replace(/^Cardputer:\s*/u, "")
  ).trim();
}

function trimmedPromptText(value, maxChars) {
  const text = stripMarkdownForDevice(value);
  if (!text) {
    return "";
  }
  const limit = Math.max(40, Number(maxChars) || 180);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function promptSenderLabel(message) {
  if (message?.sender?.kind === "assistant") {
    return "assistant";
  }
  if (message?.sender?.kind === "device") {
    return "user";
  }
  if (message?.sender?.kind === "human") {
    return "telegram_user";
  }
  return "system";
}

function wantsTopicContextForText(text) {
  const lower = String(text || "").toLowerCase();
  return /topic|топик|тема|чат|контекст|context|switch|переключ|следующ|предыдущ|истори/u.test(lower);
}

function isMeaningfulAssistantReplyText(text) {
  const cleaned = stripMarkdownForDevice(text)
    .replace(/\[\[cardputer_actions:[\s\S]*?\]\]/giu, "")
    .trim();
  if (!cleaned) {
    return false;
  }
  const normalized = cleaned.toLowerCase().replace(/[.!?\s]+/gu, "");
  if (["no_reply", "noreply", "null", "undefined"].includes(normalized)) {
    return false;
  }
  return true;
}

function buildDeviceTurnEnvelope({ context, policy, text, inputMode, compact = false }) {
  const stringify = (value) => JSON.stringify(value, null, compact ? 0 : 2);
  const lines = [
    "Cardputer runtime context (bridge metadata):",
    "```json",
    stringify(context),
    "```",
    "",
    "Cardputer reply policy (bridge metadata):",
    "```json",
    stringify(policy),
    "```",
    "",
    inputMode === "voice" ? "[Audio]" : "",
    "User text:",
    String(text || "").trim()
  ];
  return lines.filter((line, index) => line || (index > 0 && lines[index - 1] !== "")).join("\n")
    .trim();
}

function readJsonFileSyncSafe(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeTopicTitle(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value
    .replace(/\s+id:-?\d+\s+topic:\d+\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized;
}

function isCardputerInternalTopic(topic) {
  const title = normalizeTopicTitle(topic?.display_title || topic?.title || "");
  return Boolean(topic?.hidden) ||
    title === CARDPUTER_FIRMWARE_TOPIC_TITLE ||
    title.startsWith(`${CARDPUTER_FIRMWARE_JOB_TOPIC_PREFIX} `);
}

function extractTopicTitleFromSession(payload, fallbackTitle = "") {
  const candidates = [
    payload?.origin?.thread_title,
    payload?.origin?.threadTitle,
    payload?.topic?.title,
    payload?.metadata?.thread_title,
    payload?.metadata?.threadTitle,
    payload?.metadata?.topic_title,
    payload?.metadata?.topicTitle,
    payload?.title,
    payload?.label,
    payload?.display_name,
    payload?.displayName,
    payload?.conversation_label,
    payload?.conversationLabel,
    payload?.metadata?.conversation_label
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTopicTitle(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return normalizeTopicTitle(fallbackTitle);
}

function topicDisplayTitle(topic) {
  return normalizeTopicTitle(topic?.display_title || topic?.title || "") || "Topic";
}

function isGenericBridgeTopicTitle(value = "") {
  return /^Помощник(?:\s*\/\s*\d+|\s+id:-?\d+\s+topic:\d+)?$/u.test(String(value || "").trim()) ||
    /^telegram(?::|$)/iu.test(String(value || "").trim());
}

function topicKeyForTelegram(chatId, threadId, accountId = "default") {
  return `tg:root-main:${accountId}:${chatId}:${threadId}`;
}

function sessionKeyForTelegram(chatId, threadId) {
  return `agent:main:telegram:group:${chatId}:topic:${threadId}`;
}

function shortTitleForTopic(title, threadId) {
  const words = String(title || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const short = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] || "")
    .join("")
    .toUpperCase();
  return short || (threadId ? `T${String(threadId).slice(-2)}` : "TG");
}

function candidateSessionTopicTitle(row, threadId) {
  const candidates = [
    row?.derivedTitle,
    row?.subject,
    row?.label,
    row?.displayName
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTopicTitle(candidate);
    if (normalized && !isGenericBridgeTopicTitle(normalized) && !normalized.includes(String(threadId))) {
      return normalized;
    }
  }
  return "";
}

async function createTelegramForumTopic(config, { chatId, title }) {
  if (!config.telegram?.enabled || !config.telegram.botToken) {
    throw new Error("telegram disabled");
  }
  const cleanedTitle = String(title || "").trim().slice(0, 128);
  if (!cleanedTitle) {
    throw new Error("topic title required");
  }
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("name", cleanedTitle);
  const response = await fetch(
    `${config.telegram.apiBase}/bot${config.telegram.botToken}/createForumTopic`,
    { method: "POST", body: form }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`telegram createForumTopic failed: ${payload?.description || response.status}`);
  }
  return payload.result;
}

function compactHistoryItem(item, maxTextChars = 0) {
  const kind = item?.content?.kind || "text";
  let text = "";
  if (kind === "voice") {
    text = item?.content?.transcript || item?.content?.text || "";
    if (!text) {
      const durationMs = Number(item?.content?.voice?.duration_ms || 0);
      text = durationMs > 0 ? `Voice ${Math.round(durationMs / 1000)}s` : "Voice message";
    }
  } else {
    text = item?.content?.text || "";
  }
  text = stripMarkdownForDevice(item?.sender?.kind === "assistant" ? text : unwrapCardputerEnvelope(text));
  if (maxTextChars > 0 && text.length > maxTextChars) {
    text = `${text.slice(0, Math.max(0, maxTextChars - 1))}…`;
  }
  const mediaId = kind === "voice" ? String(item?.content?.voice?.media_id || "").trim() : "";
  return {
    id: item?.id,
    seq: item?.seq,
    created_at: item?.created_at,
    sender: {
      kind: item?.sender?.kind || "msg",
      display_name: item?.sender?.display_name || ""
    },
    content: {
      kind,
      text,
      transcript: kind === "voice" ? text : undefined,
      voice: kind === "voice"
        ? {
            media_id: mediaId || undefined,
            duration_ms: item?.content?.voice?.duration_ms || 0,
            playback_ready: Boolean(item?.content?.voice?.playback_ready),
            url: mediaId ? `/api/cardputer/v1/media/${encodeURIComponent(mediaId)}?format=wav` : undefined
          }
        : undefined
      }
  };
}

function compactHistoryItemVisible(item) {
  const content = item?.content || {};
  const text = String(content.text || content.transcript || "").trim();
  const voice = content.voice || {};
  return Boolean(text || voice.url || voice.media_id);
}

async function transcode({ inputPath, outputPath, args }) {
  await ensureDir(path.dirname(outputPath));
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", ["-nostdin", "-y", "-protocol_whitelist", "file,pipe",
      "-format_whitelist", "wav,mp3,ogg,flac,aac,mov,matroska,webm", "-i", inputPath,
      "-t", "120", ...args, outputPath], {
      stdio: "ignore"
    });
    const timeout = setTimeout(() => { ffmpeg.kill("SIGKILL"); }, 30_000);
    ffmpeg.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with ${code}`));
    });
    ffmpeg.on("error", error => { clearTimeout(timeout); reject(error); });
  });
}

async function walkFiles(rootDir) {
  const files = [];
  let visited=0;
  async function visit(currentDir,depth=0) {
    if(depth>12)throw new Error("asset_tree_depth_limit");
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if(++visited>10000)throw new Error("asset_tree_entry_limit");
      const currentPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(currentPath,depth+1);
        continue;
      }
      if (entry.isFile()) {
        files.push(currentPath);
      }
    }
  }
  try {
    await visit(rootDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return files.sort();
}

async function writeBufferAtomic(filePath, buffer) {
  const tmpPath = `${filePath}.${process.pid}.${makeId("tmp")}.tmp`;
  await ensureDir(path.dirname(filePath));
  try {
    await writeFile(tmpPath, buffer,{mode:0o600,flag:"wx"});
    await rename(tmpPath, filePath);
  } finally { await rm(tmpPath,{force:true}); }
}

async function maybeTranscribeVoice(config, filePath) {
  const bytes = await readFile(filePath);
  return await transcribeDeviceAudio(config, {
    audioBytes: bytes,
    filename: path.basename(filePath),
    mimeType: "audio/wav"
  });
}

async function maybeRelayTelegramText(config, topic, text, label = "Cardputer") {
  if (!config.telegram?.enabled || !config.telegram.relayOutgoingText) {
    return null;
  }
  if (!topic?.chat_id || !topic?.thread_id) {
    return null;
  }
  const form = new FormData();
  form.set("chat_id", String(topic.chat_id));
  form.set("message_thread_id", String(topic.thread_id));
  form.set("text", `${label}: ${text}`);
  const response = await fetch(
    `${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`,
    { method: "POST", body: form }
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`telegram sendMessage failed: ${JSON.stringify(payload)}`);
  }
  return payload.result?.message_id ? String(payload.result.message_id) : null;
}

async function maybeRelayTelegramVoice(config, topic, canonicalVoicePath) {
  if (!config.telegram?.enabled || !config.telegram.relayOutgoingVoice) {
    return null;
  }
  if (!topic?.chat_id || !topic?.thread_id) {
    return null;
  }
  const bytes = await readFile(canonicalVoicePath);
  const form = new FormData();
  form.set("chat_id", String(topic.chat_id));
  form.set("message_thread_id", String(topic.thread_id));
  form.set("voice", new Blob([bytes], { type: "audio/ogg" }), path.basename(canonicalVoicePath));
  const response = await fetch(
    `${config.telegram.apiBase}/bot${config.telegram.botToken}/sendVoice`,
    { method: "POST", body: form }
  );
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`telegram sendVoice failed: ${JSON.stringify(payload)}`);
  }
  return payload.result?.message_id ? String(payload.result.message_id) : null;
}

function buildConnectPayload(config, req) {
  const publicWsUrl =
    config.publicWsUrl ||
    `ws://${req?.headers?.host || `${config.server.host}:${config.server.port}`}/api/cardputer/v1/stream`;
  return {
    ok: true,
    ws_url: publicWsUrl
  };
}

function buildPublicHttpBaseUrl(config, req) {
  if (config.publicBaseUrl) {
    return String(config.publicBaseUrl).replace(/\/+$/u, "");
  }
  if (config.publicWsUrl) {
    return String(config.publicWsUrl)
      .replace(/^ws:/u, "http:")
      .replace(/^wss:/u, "https:")
      .replace(/\/api\/cardputer\/v1\/stream\/?$/u, "")
      .replace(/\/+$/u, "");
  }
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (req?.socket?.encrypted ? "https" : "http");
  return `${protocol}://${req?.headers?.host || `${config.server.host}:${config.server.port}`}`;
}

function isTruthyHeader(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || "").trim());
}

function safeSlug(value, fallback = "asset", max = 48) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .replace(/-{2,}/gu, "-");
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, max).replace(/-+$/u, "") || fallback;
}

function inferAssetLanguage(filename) {
  const match = filename.match(/-(ru|en|th|es|de|fr)(?:\.wav)?$/iu);
  return match ? match[1].toLowerCase() : undefined;
}

function titleFromFilename(filename) {
  return String(filename || "")
    .replace(/\.wav$/iu, "")
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function readWavDurationSeconds(buffer) {
  if (!buffer || buffer.length < 44) {
    return undefined;
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);
  const dataPos = buffer.indexOf("data", 12, "ascii");
  if (dataPos < 0 || dataPos + 8 > buffer.length) {
    return undefined;
  }
  const declaredDataSize = buffer.readUInt32LE(dataPos + 4);
  const availableDataSize = Math.max(0, buffer.length - dataPos - 8);
  const dataSize = Math.min(declaredDataSize || availableDataSize, availableDataSize || declaredDataSize);
  if (!sampleRate || !byteRate || !dataSize) {
    return undefined;
  }
  return Math.max(1, Math.round(dataSize / byteRate));
}

function extractWavPcm16Mono(buffer) {
  if (!buffer || buffer.length < 44) {
    return null;
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataPos = buffer.indexOf("data", 12, "ascii");
  if (channels !== 1 || bitsPerSample !== 16 || !sampleRate || dataPos < 0 || dataPos + 8 > buffer.length) {
    return null;
  }
  const declaredDataSize = buffer.readUInt32LE(dataPos + 4);
  const dataStart = dataPos + 8;
  const availableDataSize = Math.max(0, buffer.length - dataStart);
  const dataSize = Math.min(declaredDataSize || availableDataSize, availableDataSize || declaredDataSize);
  return {
    pcm: buffer.subarray(dataStart, dataStart + dataSize),
    sampleRate
  };
}

function sanitizeAssetSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return null;
  }
  const normalized = [];
  for (const raw of segments) {
    const segment = String(raw || "").trim();
    if (!segment || segment === "." || segment === "..") {
      return null;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/u.test(segment)) {
      return null;
    }
    normalized.push(segment);
  }
  return normalized;
}

class BridgeRuntime {
	  constructor(config) {
	    this.config = config;
	    this.store = new StateStore(config);
	    this.upstream = new UpstreamGatewayClient(config.upstream);
	    this.clients = new Set();
	    this.topicBySessionKey = new Map(config.topics.map((topic) => [topic.session_key, topic]));
	    this.bootstrapPromise = null;
    this.pendingMirrors = new Map();
    this.suppressedMirrors = new Map();
    this.deviceFirmwareReports = new Map();
    this.lastSessionTopicSyncMs = 0;
    this.startedAtMs = Date.now();
    this.turnOutbox = new DurableTurnOutbox({
      store: this.store,
      dispatch: entry => this.dispatchOutboxTurn(entry),
      wait: runId => this.upstream.rpc("agent.wait", { runId, timeoutMs: 1000 }),
      valid: entry => {
        const topic = this.store.getTopic(entry.topic_key);
        const device = this.store.state.devices[entry.device_id];
        return topic?.session_key === entry.session_key && device && !device.revoked_at &&
          device.topics?.includes(entry.topic_key);
      },
      changed: entry => this.updateOutboxReceipt(entry),
      terminal: entry => this.recordOutboxFailure(entry)
    });
	  }

  async start() {
    const legacyState = await readJsonFile(path.join(this.config.stateDir, "state.json"), null);
    if (Object.keys(legacyState?.devices || {}).length > 1)
      throw new Error("Legacy multi-device data cannot be reused by this single-device bridge. Migrate to separate private state, media, assets and firmware directories.");
    await ensureDir(this.config.stateDir);
    await ensureDir(this.config.media.inboundDir);
    await ensureDir(this.config.media.canonicalDir);
    await ensureDir(this.config.media.playbackDir);
    await ensureDir(this.config.media.tmpDir);
    await ensureDir(this.config.assets.rootDir);
    await ensureDir(this.config.assets.logsDir);
    await ensureDir(this.assetsAudioRootDir());
    await ensureDir(this.firmwareRootDir());
    await this.store.load();
    this.upstream.on("event", (frame) => void this.handleUpstreamEvent(frame));
    this.upstream.on("reconnected", () => {
      void this.scheduleBootstrap();
      this.turnOutbox.kick();
    });
    await this.turnOutbox.resume();
    // The HTTP service must stay observable while the gateway is unavailable.
    // UpstreamGatewayClient retries with bounded handshakes in the background.
    void this.upstream.start().then(() => {
      for (const topic of Object.values(this.store.state.topics || {})) {
        this.registerRuntimeTopic(topic);
      }
      this.scheduleBootstrap();
    }).catch((error) => {
      console.warn(`[upstream] startup failed: ${error.message}`);
    });
	  }

  registerRuntimeTopic(topic) {
    if (!topic?.session_key) {
      return;
    }
    this.topicBySessionKey.set(topic.session_key, topic);
    void this.upstream.subscribeSessionMessages(topic.session_key).catch((error) => {
      this.upstream.emit("warning", {
        type: "topic_subscribe_failed",
        topicKey: topic.topic_key,
        error
      });
    });
  }

  async ensureUpstreamSessionForTopic(topic, { forceCreate = false } = {}) {
    if (!topic?.session_key) {
      throw new Error("topic has no upstream session key");
    }
    if (!forceCreate) {
      try {
        await this.upstream.rpc("sessions.get", {
          key: topic.session_key
        });
        return;
      } catch (error) {
        const message = String(error.message || error || "");
        if (!message.toLowerCase().includes("session not found")) {
          throw error;
        }
      }
    }
    console.info(`[topics] creating upstream session key=${topic.session_key}`);
    const params = {
      key: topic.session_key,
      agentId: agentIdForSession(topic.session_key),
      label: topic.display_title || topic.title || `Topic ${topic.thread_id || ""}`.trim()
    };
    try {
      await this.upstream.rpc("sessions.create", params);
    } catch (error) {
      if (!String(error.message || error).toLowerCase().includes("label already in use")) throw error;
      // Labels are cosmetic and can be unique per agent on older Gateways.
      // Keep the exact requested session; never adopt another session by label.
      const { label, ...unlabeled } = params;
      await this.upstream.rpc("sessions.create", unlabeled);
    }
  }

  assetsAudioRootDir() {
    return path.join(this.config.assets.rootDir, this.config.assets.deviceClass, "audio");
  }

  assetsManifestPath() {
    return path.join(this.config.assets.rootDir, this.config.assets.deviceClass, "manifest.json");
  }

  assetFileUrl(req, relativePath) {
    const base = buildPublicHttpBaseUrl(this.config, req);
    return `${base}/api/cardputer/assets/file/${relativePath.split(path.sep).join("/")}`;
  }

  firmwareRootDir() {
    return path.join(this.config.firmware.rootDir, this.config.firmware.deviceClass);
  }

  firmwareManifestPath() {
    return path.join(this.firmwareRootDir(), this.config.firmware.manifestFilename);
  }

	  firmwareFileUrl(req, filename) {
	    const base = buildPublicHttpBaseUrl(this.config, req);
	    return `${base}/api/cardputer/firmware/file/${filename}`;
	  }

  firmwareWorkflowPaths() {
    return firmwareWorkflowPaths(this.config, { repoDir: CARDPUTER_FIRMWARE_REPO,
      build: CARDPUTER_FIRMWARE_BUILD_BIN, publish: CARDPUTER_FIRMWARE_PUBLISH_BIN,
      smoke: CARDPUTER_FIRMWARE_SMOKE_BIN });
  }

  buildFirmwarePromptContext() {
    const workflow = this.firmwareWorkflowPaths();
    const manifest = readJsonFileSyncSafe(this.firmwareManifestPath(), null);
    return {
      context_version: CARDPUTER_FIRMWARE_CONTEXT_VERSION,
      current_ota_candidate: manifest
        ? {
            version: String(manifest.version || ""),
            channel: String(manifest.channel || this.config.firmware.channel || "dev"),
            filename: String(manifest.filename || ""),
            size: Number(manifest.size || 0),
            sha256: String(manifest.sha256 || ""),
            build_git_sha: String(manifest.build_git_sha || ""),
            notes: String(manifest.notes || "")
          }
        : null,
      capabilities: { ...CARDPUTER_FIRMWARE_CAPABILITIES, hardware: {
        ...CARDPUTER_FIRMWARE_CAPABILITIES.hardware,
        firmware_repo: workflow.repoDir, bridge_repo: path.join(workflow.repoDir, "bridge"),
        build_command: workflow.build, server_firmware_repo: workflow.repoDir,
        server_build_wrapper: workflow.build, server_publish_wrapper: workflow.publish
      } },
      supported_device_actions: {
        catalog_version: DEVICE_ACTION_CATALOG_VERSION,
        types: DEVICE_ACTION_CATALOG.map((action) => action.type)
      }
    };
  }

  async syncRecentTelegramSessionsForDevice(device, options = {}) {
    if (CARDPUTER_SINGLE_TOPIC_MODE && this.primaryCardputerTopicForDevice(device)) {
      return false;
    }
    const now = Date.now();
    const minIntervalMs = Math.max(5000, Number(this.config.topicCatalogSyncMinIntervalMs) || 30000);
    if (now - this.lastSessionTopicSyncMs < minIntervalMs) {
      return false;
    }
    this.lastSessionTopicSyncMs = now;

    const knownTopics = this.store.listTopicsForDevice(device.device_id, {
      sortByActivity: false
    });
    const allowedChatIds = new Set(
      knownTopics
        .map((topic) => String(topic.chat_id || "").trim())
        .filter(Boolean)
    );
    if (!allowedChatIds.size) {
      return false;
    }

    let result;
    try {
      result = await this.upstream.rpc("sessions.list", {
        agentId: "main",
        activeMinutes: Math.max(60, Number(options.activeMinutes || 7 * 24 * 60)),
        includeDerivedTitles: true,
        includeLastMessage: false,
        limit: Math.max(20, Number(options.limit || 80))
      });
    } catch (error) {
      console.warn(`[topics] sessions.list failed: ${String(error.message || error)}`);
      return false;
    }

    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    let changed = false;
    for (const row of sessions) {
      const match = String(row?.key || "").match(/^agent:main:telegram:group:(-?\d+):topic:(\d+)$/u);
      if (!match) {
        continue;
      }
      const [, chatId, threadIdRaw] = match;
      if (!allowedChatIds.has(String(chatId))) {
        continue;
      }
      const threadId = Number(threadIdRaw);
      const existing = this.store.findTopicByTelegram(chatId, threadId);
      const topicKey = existing?.topic_key || topicKeyForTelegram(chatId, threadId);
      const existingTitle = normalizeTopicTitle(existing?.title || "");
      const title =
        existingTitle && !isGenericBridgeTopicTitle(existingTitle)
          ? existingTitle
          : candidateSessionTopicTitle(row, threadId) || existingTitle || `Topic ${threadId}`;
      const updatedAt =
        typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) && row.updatedAt > 0
          ? new Date(row.updatedAt).toISOString()
          : existing?.updated_at || null;
      const topic = this.store.upsertTopic({
        ...(existing || {}),
        topic_key: topicKey,
        session_key: existing?.session_key || sessionKeyForTelegram(chatId, threadId),
        title,
        display_title: title,
        short_title: existing?.short_title || shortTitleForTopic(title, threadId),
        emoji: existing?.emoji || existing?.icon || "💬",
        icon: existing?.icon || existing?.emoji || "💬",
        chat_id: chatId,
        thread_id: threadId,
        contour_id: existing?.contour_id || "root/main",
        updated_at: updatedAt,
        last_activity_at: updatedAt
      });
      if (topic) {
        this.registerRuntimeTopic(topic);
        changed = this.store.ensureDeviceTopic(device.device_id, topic.topic_key) || changed;
      }
    }
    if (changed) {
      await this.store.save();
    }
    return changed;
  }

  listTopicsForDevice(deviceId, options = {}) {
    const currentTopicKey = this.store.getCurrentTopicKey(deviceId);
    const rows = this.store.listTopicsForDevice(deviceId, options);
    const primaryTitle = normalizeTopicTitle(CARDPUTER_PRIMARY_TOPIC_TITLE);
    const primary = rows.find((topic) =>
      normalizeTopicTitle(topic.display_title || topic.title) === primaryTitle
    );
    const visibleRows = primary ? [primary] : rows.filter((topic) => !isCardputerInternalTopic(topic));
    return visibleRows
      .map((topic, index) => ({
        index: index + 1,
        current: topic.topic_key === currentTopicKey,
        ...topic
      }));
  }

  isVisibleTopicForDevice(device, topicKey) {
    const key = String(topicKey || "").trim();
    if (!key) {
      return false;
    }
    return this.listTopicsForDevice(device.device_id, { sortByActivity: false })
      .some((topic) => topic.topic_key === key);
  }

  primaryCardputerTopicForDevice(device) {
    const deviceId = typeof device === "string" ? device : device?.device_id;
    const rows = this.store.listTopicsForDevice(deviceId, { sortByActivity: false });
    const primaryTitle = normalizeTopicTitle(CARDPUTER_PRIMARY_TOPIC_TITLE);
    const primary = rows.find((topic) =>
      normalizeTopicTitle(topic.display_title || topic.title) === primaryTitle
    );
    const fallback =
      primary ||
      this.currentTopicForDevice(deviceId) ||
      this.store.getTopic(this.store.getDevice(deviceId)?.default_topic_key) ||
      rows[0] ||
      null;
    if (fallback?.topic_key) {
      this.store.setCurrentTopicKey(deviceId, fallback.topic_key);
    }
    return fallback;
  }

  async createDeviceTopic(device, rawTitle = "") {
    const current = this.currentTopicForDevice(device.device_id) ||
      this.store.getTopic(device.default_topic_key) ||
      this.store.listTopicsForDevice(device.device_id, { sortByActivity: false })[0];
    const chatId = current?.chat_id || this.config.topics?.[0]?.chat_id;
    if (!chatId) {
      throw new Error("telegram chat unavailable");
    }
    const title = normalizeTopicTitle(rawTitle) || `Cardputer ${nowIso().slice(0, 16).replace("T", " ")}`;
    const created = await createTelegramForumTopic(this.config, { chatId, title });
    const threadId = Number(created?.message_thread_id || 0);
    if (!threadId) {
      throw new Error("telegram did not return thread id");
    }
    const topicKey = topicKeyForTelegram(chatId, threadId);
    const topic = this.store.upsertTopic({
      topic_key: topicKey,
      session_key: sessionKeyForTelegram(chatId, threadId),
      title: normalizeTopicTitle(created?.name || title) || title,
      display_title: normalizeTopicTitle(created?.name || title) || title,
      short_title: "NEW",
      emoji: "🆕",
      icon: "🆕",
      chat_id: chatId,
      thread_id: threadId,
      contour_id: current?.contour_id || "root/main",
      updated_at: nowIso(),
      last_activity_at: nowIso()
    });
    this.store.ensureDeviceTopic(device.device_id, topic.topic_key);
    this.store.setCurrentTopicKey(device.device_id, topic.topic_key);
    this.registerRuntimeTopic(topic);
    await this.store.save();
    return {
      index: 1,
      current: true,
      ...topic
    };
  }

  async firmwareTopicForDevice(device) {
    const title = normalizeTopicTitle(CARDPUTER_FIRMWARE_TOPIC_TITLE);
    const currentTopicKey = this.store.getCurrentTopicKey(device.device_id);
    const existing = this.store
      .listTopicsForDevice(device.device_id, { sortByActivity: false })
      .find((topic) => normalizeTopicTitle(topic.display_title || topic.title) === title);
    if (existing) {
      await this.ensureUpstreamSessionForTopic(existing);
      this.registerRuntimeTopic(existing);
      return existing;
    }
    const topic = await this.createDeviceTopic(device, CARDPUTER_FIRMWARE_TOPIC_TITLE);
    if (currentTopicKey && currentTopicKey !== topic.topic_key) {
      this.store.setCurrentTopicKey(device.device_id, currentTopicKey);
      await this.store.save();
    }
    return this.store.getTopic(topic.topic_key) || topic;
  }

  async createFirmwareJobTopicForDevice(device, rawUserText = "") {
    const sourceTopic = this.primaryCardputerTopicForDevice(device);
    const iso = nowIso();
    const stampSlug = iso.replace(/\D/gu, "").slice(0, 14);
    const stamp = iso.slice(5, 16).replace("T", " ").replace("-", "/");
    const suffix = makeId("fw").replace(/^fw_/u, "").slice(0, 5);
    const language = languageNameForText(rawUserText);
    const title = `${CARDPUTER_FIRMWARE_JOB_TOPIC_PREFIX} ${stamp} ${suffix}`;
    const topic = this.store.upsertTopic({
      topic_key: `local:cardputer-firmware-job:${stampSlug}:${suffix}`,
      session_key: `agent:${agentIdForSession(sourceTopic?.session_key)}:cardputer-firmware-job-${stampSlug}-${suffix}`,
      title,
      display_title: title,
      short_title: "FW JOB",
      emoji: "🛠️",
      icon: "🛠️",
      contour_id: sourceTopic?.contour_id || "root/main",
      mirror_topic_key: sourceTopic?.topic_key || null,
      hidden: true,
      created_at: iso,
      updated_at: iso,
      last_activity_at: iso
    });
    await this.ensureUpstreamSessionForTopic(topic, { forceCreate: true });
    this.registerRuntimeTopic(topic);
    await this.store.save();
    const savedTopic = this.store.getTopic(topic.topic_key) || topic;
    return {
      ...savedTopic,
      job_language: language
    };
  }

  buildFirmwareJobUpstreamText({ device, sourceTopic, jobTopic, text, inputMode = "text", clientMsgId = "" }) {
    const workflow = this.firmwareWorkflowPaths();
    const language = languageNameForText(text);
    const immediateInstall = wantsImmediateFirmwareInstall(text);
    const firmware = this.buildFirmwarePromptContext();
    const source = sourceTopic
      ? {
          topic_key: sourceTopic.topic_key,
          session_key: sourceTopic.session_key,
          title: sourceTopic.title,
          thread_id: sourceTopic.thread_id
        }
      : null;
    const job = jobTopic
      ? {
          topic_key: jobTopic.topic_key,
          session_key: jobTopic.session_key,
          title: jobTopic.title,
          thread_id: jobTopic.thread_id
        }
      : null;
    const context = {
      client: "cardputer_adv",
      device_id: device?.device_id || null,
      user_id: device?.device_id || "cardputer",
      input_mode: inputMode,
      client_msg_id: clientMsgId,
      request_language: language,
      immediate_install_requested: immediateInstall,
      source_topic: source,
      firmware_job_topic: job,
      firmware,
      job_session_contract: {
        purpose: "Disposable short-lived firmware implementation session. Do not rely on older Cardputer Firmware topic history.",
        architecture:
          "Cardputer -> bridge firmware-route -> fresh OpenClaw job session -> firmware repo patch/build/commit/publish -> bridge OTA manifest -> device inbox event -> spoken reply -> ota.check/ota.apply.",
        repo: workflow.repoDir,
        branch: workflow.branch,
        push_remote: workflow.pushRemote,
        app_dir: path.join(workflow.repoDir, "bots/CardputerADV"),
        build_wrapper: workflow.build,
        publish_wrapper: workflow.publish,
        smoke_wrapper: workflow.smoke,
        safety_gate: {
          mode: "fail_closed",
          app_slot_limit_bytes: 3145728,
          required_before_publish: [
            "review git diff for unrelated or destructive changes",
            "verify APP_VERSION bump in platformio.ini and src/main_parts/001_main.cpp.inc",
            "successful build through the wrapper",
            "firmware.bin exists and is below the app slot limit with reasonable headroom",
            "publish wrapper succeeds",
            "smoke wrapper or equivalent manifest/file size/sha verification succeeds"
          ],
          high_risk_files_or_behaviors: [
            "partition table, bootloader, flash offsets, OTA slot layout, rollback/boot guard",
            "device token, Wi-Fi credentials, TLS/CA validation, auth headers",
            "factory reset, filesystem wipe, SD/LittleFS destructive migration",
            "boot-blocking network loops, watchdog-disabling loops, unbounded heap allocations"
          ]
        }
      }
    };
    const rules = [
      "You are the Cardputer firmware release agent for this one job only.",
      "This is server-owned OpenClaw firmware execution. Implement using the repository and wrappers below. No desktop Codex chat, chat binding, or desktop handoff is required. Historical holds for completed local jobs do not apply to this new job.",
      "Use the language of request_language for user-facing replies. English by default; Russian only when request_language is Russian.",
      "Implement the requested firmware change in the repo. Background-color requests are only smoke tests; the same route must handle real features such as calculator, alarm, stopwatch, Tamagotchi, or utility screens.",
      "Keep the implementation scoped and production-grade. Follow existing firmware UI/code patterns and avoid unrelated refactors.",
      "Before editing, inspect the relevant files. Use the server repo path from job_session_contract.repo.",
      "Fetch job_session_contract.push_remote and job_session_contract.branch, then fast-forward that exact clean checkout before editing. Stop if the checkout is on another branch; do not switch or reset it. Preserve dirty work and stop on conflicts. Never restore or merge legacy OmniBot firmware branches into the independent S1-ADV history.",
      "Bump APP_VERSION in both platformio.ini and src/main_parts/001_main.cpp.inc.",
      "SAFETY GATE: treat firmware publishing as fail-closed. If any required safety check is missing, ambiguous, or failed, stop and report the blocker; do not publish, do not append ota.apply, and do not claim success.",
      "Before build/publish, review git diff for unrelated changes, destructive storage operations, hardcoded secrets, disabled TLS/auth, bootloader/partition/OTA-slot changes, rollback/boot-guard changes, watchdog-disabling loops, boot-blocking network loops, or unbounded memory allocations.",
      "Do not modify partition tables, bootloader, OTA slot layout, rollback/boot guard, credential handling, TLS verification, or storage migration/wipe behavior unless the user explicitly requested that exact area and you can explain the safety impact.",
      "Verify the produced firmware.bin is below the app slot limit from job_session_contract.safety_gate.app_slot_limit_bytes with reasonable headroom. If the image is too large or close enough to threaten OTA reliability, stop and report it instead of publishing.",
      "After review, commit source locally BEFORE building, so the binary embeds the exact source SHA. Build that clean commit, then push it only after the build passes. Never publish an unpushed or changed candidate.",
      "Build exactly once at a time with job_session_contract.build_wrapper. Do not run parallel PlatformIO builds against the same .pio directory.",
      "Publish the OTA candidate with job_session_contract.publish_wrapper and verify it with job_session_contract.smoke_wrapper or an equivalent manifest/file sha smoke.",
      "When publishing succeeds, send one concise final assistant message in this job topic. It must be suitable for spoken playback on the device.",
      immediateInstall
        ? "Because immediate_install_requested is true, the final message must say that the firmware is ready and installation is starting now, then append exactly this machine marker: [[cardputer_actions:[{\"type\":\"settings.set_ota_min_battery\",\"value\":25},{\"type\":\"ota.check\"},{\"type\":\"ota.apply\"}]]]"
        : "Because immediate_install_requested is false, the final message must say that the firmware is ready to install, then append exactly this machine marker: [[cardputer_actions:[{\"type\":\"ota.check\"}]]]",
      "If the change adds a launchable app or screen, mention where it is in the menu and how to open it. Do not append a launch action after ota.apply unless that action is valid before reboot.",
      "If post-install launch or post-install speech is required, implement it in firmware as boot-time/new-version behavior rather than trying to run the new app before OTA reboot.",
      "If build or publish fails, do not fake success. Report the exact blocker briefly and do not append ota.apply."
    ];
    return [
      "Cardputer firmware job bootstrap:",
      "```json",
      JSON.stringify(context, null, 2),
      "```",
      "Rules:",
      ...rules.map((rule, index) => `${index + 1}. ${rule}`),
      "",
      "User firmware request:",
      text
    ].join("\n");
  }

  resolveTopicFromConversationKey(device, rawConversationKey = "") {
    const primary = this.primaryCardputerTopicForDevice(device);
    if (primary) {
      return primary;
    }
    const raw = String(rawConversationKey || "").trim();
    if (!raw) {
      return this.currentTopicForDevice(device.device_id);
    }
    const exact = this.store.getTopic(raw);
    if (exact && device.topics.includes(exact.topic_key)) {
      this.store.setCurrentTopicKey(device.device_id, exact.topic_key);
      return exact;
    }
    const match = raw.match(/^telegram:(-?\d+):topic:(\d+)$/u);
    if (!match) {
      return this.currentTopicForDevice(device.device_id);
    }
    const [, chatId, threadIdRaw] = match;
    const threadId = Number(threadIdRaw);
    const matched = this.listTopicsForDevice(device.device_id)
      .map((item) => this.store.getTopic(item.topic_key))
      .find((topic) => topic && String(topic.chat_id) === chatId && Number(topic.thread_id) === threadId);
    if (matched) {
      this.store.setCurrentTopicKey(device.device_id, matched.topic_key);
      return matched;
    }
    return this.currentTopicForDevice(device.device_id);
  }

  async listDeviceAssets(device, req) {
    const rootDir = this.assetsAudioRootDir();
    const files = await walkFiles(rootDir);
    const assetFiles = [];
    for (const filePath of files) {
      if(assetFiles.length>=this.config.assets.maxManifestFiles)break;
      if (!filePath.endsWith(".wav")) {
        continue;
      }
      const relativePath = path.relative(rootDir, filePath);
      const segments = sanitizeAssetSegments(relativePath.split(path.sep));
      if (!segments || segments.length < 2) {
        continue;
      }
      if (!this.canReadAsset(device, segments, filePath)) continue;
      if ((await stat(filePath)).size > this.config.assets.maxFileBytes) continue;
      const wavBytes = await readFile(filePath);
      const relativeUrlPath = segments.join("/");
      const filename = segments.at(-1);
      assetFiles.push({
        path: `${this.config.assets.audioPrefix}/${relativeUrlPath}`,
        category: segments[0],
        title: titleFromFilename(filename),
        language: inferAssetLanguage(filename),
        url: this.assetFileUrl(req, relativeUrlPath),
        sha256: sha256(wavBytes),
        size: wavBytes.length,
        duration_sec: readWavDurationSeconds(wavBytes)
      });
    }
    assetFiles.sort((left, right) => left.path.localeCompare(right.path));
    const limitedFiles = assetFiles.slice(0, this.config.assets.maxManifestFiles);
    const manifest = {
      device: this.config.assets.deviceClass,
      asset_version: nowIso().slice(0, 19).replace(/[T:]/gu, "-"),
      generated_at: nowIso(),
      files: limitedFiles
    };
    const serialized = Buffer.from(JSON.stringify(manifest, null, 2));
    if (serialized.length > this.config.assets.maxManifestBytes) {
      throw new Error("asset_manifest_too_large");
    }
    await writeBufferAtomic(this.assetsManifestPath(), serialized);
    return manifest;
  }

  resolveAssetDownload(device, relativeUrlPath) {
    const segments = sanitizeAssetSegments(String(relativeUrlPath || "").split("/"));
    if (!segments || segments.length < 2 || !segments.at(-1).endsWith(".wav")) {
      return null;
    }
    const filePath = path.join(this.assetsAudioRootDir(), ...segments);
    const relativeToRoot = path.relative(this.assetsAudioRootDir(), filePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      return null;
    }
    if (!this.canReadAsset(device, segments, filePath)) return null;
    return {
      filePath,
      relativeUrlPath: segments.join("/"),
      category: segments[0],
      filename: segments.at(-1)
    };
  }

  canReadAsset(device, segments, filePath) {
    if (segments[0] !== this.config.assets.replyCategory) return true;
    const owner = readJsonFileSyncSafe(`${filePath}.owner.json`, null);
    return !!owner?.session_key && !!device?.topics?.includes(owner.topic_key) &&
      this.store.getTopic(owner.topic_key)?.session_key === owner.session_key;
  }

  resolveFirmwareDownload(device, filename) {
    const segments = sanitizeAssetSegments([String(filename || "").trim()]);
    if (!segments || segments.length !== 1 || !segments[0].endsWith(".bin")) {
      return null;
    }
    const filePath = path.join(this.firmwareRootDir(), segments[0]);
    const relativeToRoot = path.relative(this.firmwareRootDir(), filePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      return null;
    }
    return {
      filePath,
      filename: segments[0]
    };
  }

  async readFirmwareManifest(device, req) {
    const manifest = await readJsonFile(this.firmwareManifestPath(), null);
    if (!manifest || typeof manifest !== "object") {
      return null;
    }
    const filename = String(manifest.filename || "").trim();
    const firmware = this.resolveFirmwareDownload(device, filename);
    if (!firmware) {
      throw new Error("firmware_manifest_invalid_filename");
    }
    const fileStat = await stat(firmware.filePath);
    if (fileStat.size > this.config.firmware.maxFileBytes) {
      throw new Error("firmware_too_large");
    }
    const digest = manifest.sha256 || sha256(await readFile(firmware.filePath));
    const firmwareUrl = this.firmwareFileUrl(req, firmware.filename);
    return {
      device: this.config.firmware.deviceClass,
      version: String(manifest.version || "").trim(),
      channel: String(manifest.channel || this.config.firmware.channel || "dev"),
      firmware_url: firmwareUrl,
      url: firmwareUrl,
      filename: firmware.filename,
      sha256: String(digest).toLowerCase(),
      size: Number(manifest.size || fileStat.size),
      min_battery: Number(manifest.min_battery ?? this.config.firmware.minBattery ?? 40),
      confirm_required: Boolean(manifest.confirm_required ?? this.config.firmware.confirmRequired),
      built_at: manifest.built_at || manifest.generated_at || null,
      build_git_sha: manifest.build_git_sha || null,
      notes: manifest.notes || ""
    };
  }

  async enqueueOtaInstall({ device, version, minimumBattery = 25 }) {
    const requestedVersion = String(version || "").trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u.test(requestedVersion)) {
      throw new Error("invalid_firmware_version");
    }
    const manifest = await readJsonFile(this.firmwareManifestPath(), null);
    if (!manifest || String(manifest.version || "").trim() !== requestedVersion) {
      const error = new Error("firmware_version_not_published");
      error.statusCode = 409;
      throw error;
    }
    const firmware = this.resolveFirmwareDownload(device, String(manifest.filename || "").trim());
    if (!firmware) {
      throw new Error("firmware_manifest_invalid_filename");
    }
    const fileStat = await stat(firmware.filePath);
    if (fileStat.size <= 0 || fileStat.size > this.config.firmware.maxFileBytes) {
      throw new Error("firmware_file_invalid");
    }

    const topicKey = this.store.getCurrentTopicKey(device.device_id);
    const topic = this.store.getTopic(topicKey);
    if (!topic) {
      throw new Error("device_has_no_current_topic");
    }
    const minBattery = Math.max(25, Math.min(100, Number(minimumBattery) || 25));
    const text = (
      `Realtime ${requestedVersion} готов. Запускаю OTA-установку сейчас.\n\n` +
      deviceActionMarker([
        { type: "settings.set_ota_min_battery", value: minBattery },
        { type: "ota.check" },
        { type: "ota.apply" }
      ])
    );
    const createdAt = nowIso();
    const unique = sha256(`${device.device_id}\n${requestedVersion}\n${createdAt}\n${makeId("ota")}`)
      .slice(0, 20);
    const eventId = `ota-install:${device.device_id}:${requestedVersion}:${unique}`;
    const message = this.store.appendMessage(topicKey, {
      id: `msg_ota_${unique}`,
      created_at: createdAt,
      updated_at: createdAt,
      client_msg_id: eventId,
      sender: {
        kind: "assistant",
        id: "openclaw:firmware-release",
        display_name: "OpenClaw"
      },
      source: {
        transport: "cardputer_ota_release"
      },
      content: {
        kind: "text",
        text
      }
    });
    const queued = this.store.enqueueDeviceEvent(device.device_id, {
      event_id: eventId,
      kind: "assistant_message",
      priority: "urgent",
      topic_key: topicKey,
      message_id: message.id,
      seq: message.seq,
      message
    });
    if (!queued) {
      throw new Error("ota_event_not_queued");
    }
    await this.store.save();
    this.broadcast(topicKey, {
      type: "new_message",
      topic_key: topicKey,
      session_key: topic.session_key,
      message
    });
    return {
      ok: true,
      device_id: device.device_id,
      topic_key: topicKey,
      version: requestedVersion,
      event_id: eventId,
      seq: message.seq,
      min_battery: minBattery
    };
  }

  async saveReplyAudioAsset(req, replyText, traceId, topic) {
    const cleaned = String(replyText || "").trim();
    if (!cleaned || !topic?.session_key || this.store.getTopic(topic.topic_key)?.session_key !== topic.session_key) {
      return null;
    }
    const startedAt = Date.now();
    const sourceSampleRate = 24000;
    const targetSampleRate = Math.max(8000, Number(this.config.assets.replySampleRate) || 8000);
    let wavBytes = null;
    let provider = "openai";
    if (openAiApiKey()) {
      try {
        const pcm = await synthesizeOpenAiTtsPcm({
          text: cleaned,
          model: this.config.omnibotShim.ttsModel,
          voice: this.config.omnibotShim.ttsVoice,
          timeoutMs: Math.max(1000, Number(this.config.omnibotShim.ttsTimeoutMs) || 8000)
        });
        const outputPcm = downsamplePcm16Mono(pcm, sourceSampleRate, targetSampleRate);
        wavBytes = Buffer.concat([createWavHeader(outputPcm.length, targetSampleRate), outputPcm]);
      } catch (error) {
        console.warn(`[tts] openai_failed trace=${traceId || "-"} err=${String(error.message || error).slice(0, 240)}`);
      }
    }
    if (!wavBytes && String(this.config.omnibotShim.ttsFallbackProvider || "").toLowerCase() === "espeak") {
      provider = "espeak";
      const voice = containsCyrillic(cleaned)
        ? this.config.omnibotShim.ttsFallbackVoiceRu
        : this.config.omnibotShim.ttsFallbackVoiceEn;
      try {
        wavBytes = await synthesizeEspeakTtsWav({
          text: cleaned,
          bin: this.config.omnibotShim.ttsFallbackBin || "espeak-ng",
          voice: voice || "en-us"
        });
      } catch (error) {
        console.warn(`[tts] espeak_failed trace=${traceId || "-"} err=${String(error.message || error).slice(0, 240)}`);
      }
    }
    if (!wavBytes?.length) {
      return null;
    }
    const baseSlug = safeSlug(cleaned, "reply", 31);
    const filename = `${baseSlug}-${makeId("audio").slice(-12)}.wav`;
    const relativeUrlPath = `${this.config.assets.replyCategory}/${filename}`;
    const filePath = path.join(this.assetsAudioRootDir(), this.config.assets.replyCategory, filename);
    await writeBufferAtomic(filePath, wavBytes);
    await writeJsonAtomic(`${filePath}.owner.json`, { topic_key:topic.topic_key, session_key:topic.session_key });
    const durationSec = readWavDurationSeconds(wavBytes);
    console.info(
      `[tts] reply_audio trace=${traceId || "-"} provider=${provider} model=${this.config.omnibotShim.ttsModel} ` +
      `ms=${Date.now() - startedAt} bytes=${wavBytes.length} duration=${durationSec || "-"}`
    );
    return {
      title: titleFromFilename(filename),
      category: this.config.assets.replyCategory,
      url: this.assetFileUrl(req, relativeUrlPath),
      sha256: sha256(wavBytes),
      size: wavBytes.length,
      duration_sec: durationSec
    };
  }

  shortReplyText(text) {
    const cleaned = stripMarkdownForDevice(text);
    if (!cleaned) {
      return "";
    }
    const maxWords = Math.max(4, Number(this.config.deviceTurnContext?.shortReplyWords) || 15);
    const words = cleaned.split(/\s+/u);
    if (words.length <= maxWords) {
      return cleaned;
    }
    return `${words.slice(0, maxWords).join(" ")}…`;
  }

  fastLaneEnabled(inputMode = "voice") {
    if (!this.config.fastLane?.enabled) {
      return false;
    }
    const provider = String(this.config.fastLane?.provider || "codex-oauth").trim().toLowerCase();
    if ((provider === "openai" || provider === "openai-api") && !openAiApiKey()) {
      return false;
    }
    if (inputMode === "voice") {
      return this.config.fastLane.voiceEnabled !== false;
    }
    if (inputMode === "text") {
      return this.config.fastLane.textEnabled === true;
    }
    return false;
  }

  fastLaneRecentHistory(topicKey) {
    const limit = Math.max(0, Number(this.config.fastLane?.historyLimit) || 0);
    if (!limit) {
      return [];
    }
    const textLimit = Math.max(40, Number(this.config.fastLane?.historyTextChars) || 120);
    return this.store.getHistory(topicKey, 0, 100000).items
      .filter((item) => item.content?.kind === "text" && isMeaningfulAssistantReplyText(item.content?.text))
      .slice(-limit)
      .map((item) => {
        const role = item.sender?.kind === "assistant" ? "assistant" : "user";
        const text = stripMarkdownForDevice(item.content?.text || "").replace(/\s+/gu, " ").slice(0, textLimit);
        return `${role}: ${text}`;
      });
  }

  trimFastLaneReply(text) {
    const cleaned = String(text || "").trim();
    return cleaned;
  }

  async generateFastLaneReply({ device, topic, transcript, inputMode = "voice" }) {
    const startedAt = Date.now();
    const topicTitle = String(topic?.display_title || topic?.title || "Current topic").trim();
    const topicIcon = String(topic?.emoji || topic?.icon || "").trim();
    const history = this.fastLaneRecentHistory(topic?.topic_key || "");
    const userText = String(transcript || "").trim();
    const commandReply = fastCommandReplyFromText(userText);
    if (commandReply) {
      console.info(
        `[fast-lane] command device=${device?.device_id || "-"} topic=${topic?.topic_key || "-"} ` +
        `mode=${inputMode} ms=${Date.now() - startedAt} chars=${commandReply.length}`
      );
      return {
        text: commandReply,
        model: "bridge-command-router",
        elapsedMs: Date.now() - startedAt
      };
    }
    const system = [
      "You are the low-latency OpenClaw voice bridge for a M5Stack Cardputer ADV.",
      "Answer as the same personal assistant, but optimize for immediate spoken interaction.",
      REPLY_LANGUAGE_POLICY,
      "For voice turns, answer in 1-2 short spoken sentences unless a command needs a terse confirmation.",
      "Do not do deep analysis, browsing, long planning, or broad memory search in this fast lane.",
      "If the user asks for a device/app action, include the required machine marker after the human sentence.",
      buildDeviceActionPolicyText(),
      buildFirmwareCapabilityPolicyText()
    ].join(" ");
    const user = JSON.stringify({
      device_id: device?.device_id || "cardputer",
      input_mode: inputMode,
      current_topic: {
        title: topicTitle,
        emoji: topicIcon
      },
      firmware: this.buildFirmwarePromptContext(),
      recent_history: history,
      transcript: userText
    });
    const models = Array.isArray(this.config.fastLane.models) && this.config.fastLane.models.length > 0
      ? this.config.fastLane.models
      : [this.config.fastLane.model];
    let result = null;
    let lastError = null;
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
    for (const model of models.map((value) => String(value || "").trim()).filter(Boolean)) {
      try {
        const provider = String(this.config.fastLane?.provider || "codex-oauth").trim().toLowerCase();
        if (provider === "codex-oauth" || provider === "openai-codex" || provider === "openclaw-codex") {
          result = await completeCodexOAuthResponses({
            model,
            timeoutMs: this.config.fastLane.timeoutMs,
            reasoningEffort: this.config.fastLane.reasoningEffort || "low",
            verbosity: this.config.fastLane.verbosity,
            authStorePath: this.config.fastLane.codexAuthStorePath,
            refreshSkewMs: this.config.fastLane.codexRefreshSkewMs,
            messages
          });
        } else {
          const useResponses = this.config.fastLane.api === "responses" || /^gpt-5(?:\.|$|-)/u.test(model);
          result = useResponses
            ? await completeOpenAiResponses({
              model,
              maxTokens: this.config.fastLane.maxTokens,
              timeoutMs: this.config.fastLane.timeoutMs,
              reasoningEffort: this.config.fastLane.reasoningEffort,
              verbosity: this.config.fastLane.verbosity,
              messages
              })
            : await completeOpenAiChat({
              model,
              maxTokens: this.config.fastLane.maxTokens,
              temperature: this.config.fastLane.temperature,
              timeoutMs: this.config.fastLane.timeoutMs,
              messages
              });
        }
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `[fast-lane] model_failed device=${device?.device_id || "-"} model=${model} ` +
          `err=${String(error.message || error)}`
        );
      }
    }
    if (!result) {
      throw lastError || new Error("fast_lane_no_model_available");
    }
    const text = this.trimFastLaneReply(result.text);
    if (!text) {
      throw new Error("fast_lane_empty_after_trim");
    }
    console.info(
      `[fast-lane] reply device=${device?.device_id || "-"} topic=${topic?.topic_key || "-"} ` +
      `mode=${inputMode} model=${result.model} ms=${Date.now() - startedAt} chars=${text.length}`
    );
    return {
      text,
      model: result.model,
      elapsedMs: Date.now() - startedAt
    };
  }

  async appendDeviceText({ device, topicKey, text, clientMsgId, source = "cardputer" }) {
    const topic = this.store.getTopic(topicKey);
    if (!topic) {
      throw new Error("unknown topic");
    }
    const message = this.store.appendMessage(topicKey, {
      id: makeId("msg"),
      created_at: nowIso(),
      updated_at: nowIso(),
      client_msg_id: clientMsgId,
      sender: {
        kind: "device",
        id: `cardputer:${device.device_id}`,
        display_name: "Cardputer"
      },
      source: {
        transport: source
      },
      content: {
        kind: "text",
        text
      }
    });
    await this.store.save();
    this.broadcast(topicKey, {
      type: "new_message",
      topic_key: topicKey,
      session_key: topic.session_key,
      message
    });
    return message;
  }

  async appendAssistantReply({
    topicKey,
    text,
    clientMsgId,
    source = "cardputer_fast_lane",
    queueDeviceEvent = true,
    upstreamRunId = null,
    terminalError = false
  }) {
    const topic = this.store.getTopic(topicKey);
    if (!topic) {
      throw new Error("unknown topic");
    }
    const message = this.store.appendMessage(topicKey, {
      id: makeId("msg"),
      created_at: nowIso(),
      updated_at: nowIso(),
      client_msg_id: clientMsgId ? `${clientMsgId}:reply` : undefined,
      sender: {
        kind: "assistant",
        id: "openclaw:fast-lane",
        display_name: "OpenClaw"
      },
      source: {
        transport: source,
        ...(upstreamRunId ? { upstream_run_id: upstreamRunId } : {}),
        ...(terminalError ? { terminal_error: true } : {})
      },
      content: {
        kind: "text",
        text
      }
    });
    if (queueDeviceEvent) {
      this.queueDeviceMessageEvent(topicKey, message);
    }
    await this.store.save();
    this.broadcast(topicKey, {
      type: "new_message",
      topic_key: topicKey,
      session_key: topic.session_key,
      message
    });
    return message;
  }

  queueDeviceMessageEvent(topicKey, message) {
    const topic = this.store.getTopic(topicKey);
    if (topic?.mirror_topic_key) {
      return 0;
    }
    if (message?.sender?.kind !== "assistant") {
      return 0;
    }
    const createdAtMs = Date.parse(message?.created_at || "");
    if (Number.isFinite(createdAtMs) && createdAtMs < this.startedAtMs - 60_000) {
      return 0;
    }
    if (!isMeaningfulAssistantReplyText(message?.content?.text || "")) {
      return 0;
    }
    const count = this.store.enqueueDeviceEventForTopic(topicKey, {
      event_id: `msg:${message.id}`,
      kind: "assistant_message",
      message_id: message.id,
      seq: message.seq,
      message
    });
    if (count > 0) {
      console.info(`[device-events] queued topic=${topicKey} seq=${message.seq || "-"} devices=${count}`);
    }
    return count;
  }

  async appendInjectedInboxMessage({ topicKey, text, senderKind = "human", senderName = "Serial smoke", source = "cardputer_inbox_inject" }) {
    const topic = this.store.getTopic(topicKey);
    if (!topic) {
      throw new Error("unknown topic");
    }
    const cleanedText = String(text || "").trim();
    if (!cleanedText) {
      throw new Error("text required");
    }
    const normalizedSenderKind = ["assistant", "human", "user", "operator"].includes(String(senderKind || ""))
      ? String(senderKind)
      : "human";
    const message = this.store.appendMessage(topicKey, {
      id: makeId("msg"),
      created_at: nowIso(),
      updated_at: nowIso(),
      sender: {
        kind: normalizedSenderKind,
        id: normalizedSenderKind === "assistant" ? "openclaw:inbox-inject" : "operator:inbox-inject",
        display_name: String(senderName || "").trim().slice(0, 80) || "Serial smoke"
      },
      source: {
        transport: String(source || "cardputer_inbox_inject").trim().slice(0, 80) || "cardputer_inbox_inject"
      },
      content: {
        kind: "text",
        text: cleanedText.slice(0, 8192)
      }
    });
    this.queueDeviceMessageEvent(topicKey, message);
    await this.store.save();
    this.broadcast(topicKey, {
      type: "new_message",
      topic_key: topicKey,
      session_key: topic.session_key,
      message
    });
    return message;
  }

  recordDeviceFirmware(device, params) {
    const version=String(params.get('firmware_version')||'');
    const git=String(params.get('firmware_git')||'');
    if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version) || !/^(?:[a-f0-9]{7,40}|local)$/u.test(git)) return;
    const previous=this.deviceFirmwareReports.get(device.device_id);
    const report={version,git,reported_at:new Date().toISOString()};
    this.deviceFirmwareReports.set(device.device_id,report);
    if(previous?.version!==version || previous?.git!==git)
      console.info(`[device] firmware device=${device.device_id} version=${version} git=${git}`);
  }

  firmwareClarificationTopic(topic, text) {
    if(!/^(?:yes|yep|yeah|ok|okay|sure|go ahead|please do|no|да|ага|верно|именно|делай|нет)(?:\s|[.!?,]|$)/iu.test(String(text||'').trim())) return null;
    const last=this.store.getHistory(topic.topic_key,0,12).items
      .filter(m=>m.sender?.kind==='assistant' && m.content?.text).at(-1);
    if(last?.source?.transport!=='cardputer_firmware_job_mirror' || !/[?？]/u.test(last.content.text)) return null;
    return Object.values(this.store.state.topics||{})
      .filter(t=>t.mirror_topic_key===topic.topic_key && t.topic_key.startsWith('local:cardputer-firmware-job:') &&
        Date.now()-Date.parse(t.updated_at||t.created_at||0)<30*60*1000)
      .sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)))
      .find(t=>this.store.getHistory(t.topic_key,0,5).items.some(m=>
        m.sender?.kind==='assistant' && m.content?.text===last.content.text)) || null;
  }

  async tryFastLaneTurn({ req, device, topic, clientMsgId, transcript, inputMode, wantsReplyAudio }) {
    const continuation=this.firmwareClarificationTopic(topic,transcript);
    if (wantsFirmwareWork(transcript) || continuation) {
      const capability = await firmwareCapability(this.config, {
        CARDPUTER_FIRMWARE_REPO, CARDPUTER_FIRMWARE_BUILD_BIN,
        CARDPUTER_FIRMWARE_PUBLISH_BIN, CARDPUTER_FIRMWARE_SMOKE_BIN
      });
      if (!capability.ready) {
        await this.appendDeviceText({ device, topicKey: topic.topic_key, text: transcript, clientMsgId });
        const replyMessage = await this.appendAssistantReply({ topicKey: topic.topic_key,
          text: capability.reason, clientMsgId, source: "cardputer_firmware_unavailable" });
        return { response: { ...await this.buildTurnResponse({ req, topic, transcript,
          replyText: capability.reason, replyMessage, includeAudio: false }),
          ok: false, status: "unavailable", pending: false } };
      }
      const dashboardTopic = this.primaryCardputerTopicForDevice(device) || await this.firmwareTopicForDevice(device);
      const routeTopic = continuation || await this.createFirmwareJobTopicForDevice(device, transcript);
      console.info(
        `[firmware-route] upstream device=${device?.device_id || "-"} ` +
        `job_topic=${routeTopic?.topic_key || "-"} dashboard=${dashboardTopic?.topic_key || "-"} ` +
        `from=${topic?.topic_key || "-"} mode=${inputMode}`
      );
      const ack = await this.sendText({
        device,
        topicKey: routeTopic.topic_key,
        clientMsgId,
        text: transcript,
        upstreamText: continuation
          ? `Authenticated Cardputer owner follow-up in this existing server firmware job. Continue the earlier request and preserve its installation choice. Do not create a competing job or require any desktop chat or binding.\n\nOwner reply:\n${transcript}`
          : this.buildFirmwareJobUpstreamText({
          device,
          sourceTopic: topic,
          jobTopic: routeTopic,
          text: transcript,
          inputMode,
          clientMsgId
        }),
        waitForUpstream: false
      });
      const replyText = languageNameForText(transcript) === "Russian"
        ? (
          `Задача принята. OpenClaw подготовит прошивку и пришлёт результат на устройство.`
        )
        : (
          `Request accepted. OpenClaw will prepare the firmware and send the result to your device.`
        );
      const replyMessage = await this.appendAssistantReply({
        topicKey: dashboardTopic.topic_key,
        text: replyText,
        clientMsgId,
        source: "cardputer_firmware_job_ack"
      });
      return {
        ack,
        response: { ...await this.buildTurnResponse({
          req,
          topic: dashboardTopic,
          transcript,
          replyText,
          replyMessage,
          includeAudio: false
        }), status: "accepted", pending: true, after_seq: replyMessage.seq,
        reply_seq: replyMessage.seq, job_topic_key: routeTopic.topic_key }
      };
    }
    // Ordinary voice keeps the existing conversation and tools, without a
    // second direct-model answer. Firmware work above has exactly one owner.
    if (inputMode === "voice") return null;
    if (!this.fastLaneEnabled(inputMode)) {
      return null;
    }
    const ack = await this.sendText({
      device,
      topicKey: topic.topic_key,
      clientMsgId,
      text: transcript,
      upstreamText: this.buildDeviceTurnUpstreamText({
        device,
        topicKey: topic.topic_key,
        text: transcript,
        inputMode
      }),
      waitForUpstream: false
    });
    try {
      const fastReply = await this.generateFastLaneReply({
        device,
        topic,
        transcript,
        inputMode
      });
      const replyMessage = await this.appendAssistantReply({
        topicKey: topic.topic_key,
        text: fastReply.text,
        clientMsgId,
        source: "cardputer_fast_lane"
      });
      return {
        ack,
        response: await this.buildTurnResponse({
          req,
          topic,
          transcript,
          replyText: fastReply.text,
          replyMessage,
          includeAudio: wantsReplyAudio
        })
      };
    } catch (error) {
      console.warn(
        `[fast-lane] failed device=${device?.device_id || "-"} topic=${topic?.topic_key || "-"} ` +
        `mode=${inputMode} err=${String(error.message || error)}`
      );
      return {
        ack,
        response: null,
        fallback: this.config.fastLane?.fallbackToOpenClaw === true,
        error
      };
    }
  }

  async runFirmwareWorkJob({ device, topic, transcript, clientMsgId }) {
    const topicKey = topic?.topic_key || "";
    const requestedVersion = requestedFirmwareVersion(transcript);
    const lockKey = topicKey && requestedVersion ? `${topicKey}:${requestedVersion}` : topicKey || "global";
    if (cardputerFirmwareJobs.has(lockKey)) {
      console.info(`[firmware-work] job duplicate ignored key=${lockKey}`);
      return;
    }
    cardputerFirmwareJobs.add(lockKey);
    const notify = async (text, source = "cardputer_firmware_job") => {
      await this.appendAssistantReply({
        topicKey,
        text,
        clientMsgId,
        source
      });
    };
    try {
      if (!requestedVersion && !/\b(bump|version|release|ota|firmware)\b|верс(?:ия|ию|ии)|прошивк/iu.test(transcript)) {
        await notify("Firmware job не запущен: не понял целевую версию или тип релиза.");
        return;
      }

      console.info(
        `[firmware-work] job start device=${device?.device_id || "-"} ` +
        `topic=${topicKey || "-"} requested=${requestedVersion || "auto"}`
      );
      await runCommand("git", ["fetch", "origin", "codex/cardputer-ota-baseline-0.2.53-clean"]);
      await runCommand("git", ["checkout", "codex/cardputer-ota-baseline-0.2.53-clean"]);
      await runCommand("git", ["pull", "--ff-only", "origin", "codex/cardputer-ota-baseline-0.2.53-clean"]);
      const beforeStatus = await runCommand("git", ["status", "--short"]);
      if (beforeStatus.trim()) {
        throw new Error(`firmware repo is dirty before job:\n${beforeStatus}`);
      }

      const platformioPath = path.join(CARDPUTER_FIRMWARE_APP_DIR, "platformio.ini");
      const mainVersionPath = path.join(CARDPUTER_FIRMWARE_APP_DIR, "src/main_parts/001_main.cpp.inc");
      const platformioText = await readFile(platformioPath, "utf8");
      const currentVersion = platformioText.match(/APP_VERSION=\\?"([^"\\]+)\\?"/u)?.[1] || "";
      const version = requestedVersion || nextDevFirmwareVersion(currentVersion);
      if (!version) {
        throw new Error(`cannot determine next firmware version from ${currentVersion || "empty"}`);
      }
      if (version === currentVersion) {
        await notify(`Firmware job: manifest/source already at ${version}; no bump needed.`);
        return;
      }

      await replaceFirmwareVersion(platformioPath, version);
      await replaceFirmwareVersion(mainVersionPath, version);
      await runCommand(CARDPUTER_FIRMWARE_BUILD_BIN, [], { timeoutMs: 15 * 60 * 1000 });
      await runCommand("git", ["add", "bots/CardputerADV/platformio.ini", "bots/CardputerADV/src/main_parts/001_main.cpp.inc"]);
      await runCommand("git", ["commit", "-m", `Bump Cardputer firmware to ${version}`]);
      await runCommand("git", ["push", "origin", "HEAD"]);
      const gitSha = (await runCommand("git", ["rev-parse", "--short", "HEAD"])).trim();
      await runCommand(CARDPUTER_FIRMWARE_PUBLISH_BIN, [version, `Cardputer firmware request from device ${device?.device_id || "unknown"}`]);
      const smoke = await runCommand(CARDPUTER_FIRMWARE_SMOKE_BIN, []);
      await notify(
        `OTA ${version} опубликована.\n` +
        `git: ${gitSha}\n` +
        `smoke: ${smoke.replace(/\s+/gu, " ").slice(0, 600)}`
      );
      console.info(`[firmware-work] job done version=${version} git=${gitSha}`);
    } catch (error) {
      await notify(`Firmware job failed: ${String(error.message || error).slice(0, 900)}`, "cardputer_firmware_job_error");
      throw error;
    } finally {
      cardputerFirmwareJobs.delete(lockKey);
    }
  }

  async buildPendingTurnResponse({ req, device, topic, transcript, ack }) {
    if (ack.upstream_terminal?.status === "error") {
      const failure = "The request failed on the server. Check Inbox for details before retrying.";
      return { ...await this.buildTurnResponse({ req, topic, transcript, replyText: failure, includeAudio: false }),
        ok: false, status: "failed", pending: false, client_msg_id: ack.client_msg_id,
        upstream_run_id: ack.upstream_run_id, upstream_terminal: ack.upstream_terminal,
        delivery_state: "terminal", status_text: failure, inbox_hint: true };
    }
    const confirmed = ack.upstream_accepted === true;
    const queued = ack.delivery_state === "queued";
    const receipt = queued ? "Request queued. The reply will arrive in Inbox."
      : (confirmed ? "Request accepted. The reply will arrive in Inbox."
        : "Request stored. Delivery confirmation is pending; check Inbox before retrying.");
    return {
      ...await this.buildTurnResponse({ req, device, topic, transcript, replyText: receipt, includeAudio: false }),
      status: "pending",
      pending: true,
      after_seq: ack.seq,
      client_msg_id: ack.client_msg_id,
      upstream_run_id: ack.upstream_run_id,
      upstream_accepted: confirmed,
      delivery_state: ack.delivery_state,
      reply_seq: 0,
      status_text: receipt,
      inbox_hint: true
    };
  }

  async buildTurnResponse({ req, topic, transcript = "", replyText = "", replyMessage = null, includeAudio = false }) {
    const extracted = extractDeviceActionsFromText(replyText);
    const actions = alignFocusActionMinutes(extracted.actions, extracted.visibleText, replyText, transcript);
    const markdownText = String(extracted.visibleText || "").trim();
    const fullText = stripMarkdownForDevice(markdownText);
    const traceId = replyMessage?.id || makeId("tr");
    const turnId = String(req?.headers?.["x-turn-id"] || req?.headers?.["x-client-msg-id"] || traceId).trim();
    const response = {
      ok: true,
      status: "success",
      trace_id: traceId,
      turn_id: turnId || traceId,
      topic_key: topic?.topic_key || null,
      transcript: String(transcript || "").trim(),
      short_text: this.shortReplyText(fullText),
      full_text: fullText,
      reply: fullText,
      reply_seq: replyMessage?.seq || 0,
      markdown_text: markdownText && markdownText !== fullText ? markdownText : undefined
    };
    if (replyMessage?.source?.terminal_error) {
      response.ok = false; response.status = "failed"; response.pending = false;
    }
    if (actions.length > 0) {
      response.device_actions = actions;
      console.log(
        `[actions] turn=${turnId || traceId} topic=${topic?.topic_key || "none"} ` +
        `types=${actions.map((action) => `${action.type}${action.minutes ? `:${action.minutes}m` : ""}`).join(",")}`
      );
    }
    if (includeAudio) {
      try {
        response.audio = await this.saveReplyAudioAsset(req, fullText, traceId, topic);
        response.audio_status = response.audio ? "ready" : "unavailable";
      } catch (error) {
        console.warn(`[tts] reply_audio_skipped trace=${traceId || "-"} err=${String(error.message || error).slice(0, 240)}`);
        response.audio = null;
        response.audio_status = "unavailable";
      }
    }
    response.telegram = {
      delivered: Boolean(replyMessage?.source?.upstream_message_id),
      conversation_key: topic?.chat_id && topic?.thread_id
        ? `telegram:${topic.chat_id}:topic:${topic.thread_id}`
        : null,
      message_id: replyMessage?.source?.upstream_message_id || null
    };
    return response;
  }

  async appendDeviceLogs(device, payload) {
    const deviceId = safeSlug(device?.device_id || "unknown-device", "unknown-device", 64);
    const logPath = path.join(this.config.assets.logsDir, `${deviceId}.jsonl`);
    const line=`${JSON.stringify({
      ...payload,
      device_id: deviceId,
      received_at: nowIso()
    })}\n`;
    const write=(this.deviceLogWrites||Promise.resolve()).then(async()=>{
      await ensureDir(path.dirname(logPath));
      let size=0;try{size=(await stat(logPath)).size;}catch(error){if(error.code!=="ENOENT")throw error;}
      if(size+Buffer.byteLength(line)>8*1024*1024)await rename(logPath,`${logPath}.previous`);
      await appendFile(logPath,line,{encoding:"utf8",mode:0o600});
      await chmod(logPath,0o600);
      return logPath;
    });
    this.deviceLogWrites=write.catch(()=>{});return write;
  }

  scheduleBootstrap() {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    this.bootstrapPromise = (async () => {
      try {
        for (const topic of this.config.topics) {
          await this.bootstrapTopic(topic);
        }
        await this.store.save();
      } finally {
        this.bootstrapPromise = null;
      }
    })().catch((error) => {
      this.upstream.emit("warning", { type: "bootstrap_failed", error });
    });
    return this.bootstrapPromise;
  }

  async bootstrapTopic(topic) {
    try {
      const session = await this.upstream.rpc("sessions.get", {
        key: topic.session_key
      });
      const resolvedTitle = extractTopicTitleFromSession(session, topic.title);
      if (resolvedTitle && resolvedTitle !== topic.title) {
        topic.title = resolvedTitle;
        this.store.setTopicTitle(topic.topic_key, resolvedTitle);
      }
    } catch (error) {
      this.upstream.emit("warning", {
        type: "topic_title_enrichment_failed",
        topicKey: topic.topic_key,
        error
      });
    }

    try {
      const history = await this.upstream.rpc("chat.history", {
        sessionKey: topic.session_key,
        limit: this.config.historyBootstrapLimit
      });
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      for (const raw of messages) {
        await this.ingestUpstreamMessage(topic, raw, {
          messageId: raw?.id || null
        });
      }
    } catch (error) {
      this.upstream.emit("warning", {
        type: "topic_history_bootstrap_failed",
        topicKey: topic.topic_key,
        error
      });
    }
  }

  normalizeGatewayMessage(topic, raw, meta = {}) {
    const role = raw?.role || meta.role || "user";
    const text = parseVisibleText(raw?.content);
    const metadata = extractMetadataBlock(text);
    const visibleText = stripTelegramEnvelope(role === "assistant" ? text : unwrapCardputerEnvelope(text));
    const isVoice = isTelegramVoiceTranscript(text);
    const senderKind = metadata.sender_id ? "human" : inferSenderKindFromRole(role);
    const senderId =
      metadata.sender_id
        ? `telegram:${metadata.sender_id}`
        : senderKind === "assistant"
          ? "openclaw:main"
          : "operator";
    const createdAt = normalizeTimestamp(raw?.timestamp || metadata.timestamp);
    const correlation = gatewayTurnCorrelation(raw, meta);
    const gatewayMessageId = meta.messageId || raw?.__openclaw?.id || raw?.id;
    const normalized = {
      id: meta.localId || makeId("msg"),
      created_at: createdAt,
      updated_at: createdAt,
      sender: {
        kind: senderKind,
        id: senderId,
        display_name:
          metadata.sender ||
          (senderKind === "assistant" ? "OpenClaw" : senderKind === "device" ? "Cardputer" : "User")
      },
      source:
        metadata.message_id || gatewayMessageId || correlation.upstream_run_id
          ? {
              transport: metadata.message_id ? "telegram" : "upstream",
              upstream_message_id: metadata.message_id || gatewayMessageId ? String(metadata.message_id || gatewayMessageId) : undefined,
              ...correlation
            }
          : undefined,
      reply_to_message_id: metadata.reply_to_id ? String(metadata.reply_to_id) : undefined,
      content: isVoice
        ? {
            kind: "voice",
            transcript: visibleText,
            voice: {
              media_id: null,
              duration_ms: 0,
              canonical_mime: "audio/ogg",
              canonical_codec: "opus",
              playback_ready: false
            }
          }
        : {
            kind: "text",
            text: visibleText
          }
    };
    return normalized;
  }

  async resolveInboundVoiceFile(topic, normalized) {
    const inboundDir = this.config.media.inboundDir;
    const entries = await readdir(inboundDir, { withFileTypes: true });
    const cursor = this.store.getTopicScanCursor(topic.topic_key);
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ogg")) {
        continue;
      }
      const filePath = path.join(inboundDir, entry.name);
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs < cursor) {
        continue;
      }
      candidates.push({
        filePath,
        mtimeMs: fileStat.mtimeMs
      });
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const picked = candidates.at(-1);
    if (!picked) {
      return null;
    }
    this.store.markTopicScanCursor(topic.topic_key, picked.mtimeMs);
    const mediaId = makeId("med");
    const canonicalPath = path.join(this.config.media.canonicalDir, `${mediaId}.ogg`);
    const playbackPath = path.join(this.config.media.playbackDir, `${mediaId}.wav`);
    await copyFile(picked.filePath, canonicalPath);
    await transcode({
      inputPath: canonicalPath,
      outputPath: playbackPath,
      args: ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]
    });
    const playbackBytes = await readFile(playbackPath);
    const canonicalBytes = await readFile(canonicalPath);
    const media = {
      media_id: mediaId,
      topic_key: topic.topic_key,
      message_id: normalized.id,
      canonical_path: canonicalPath,
      canonical_mime: "audio/ogg",
      canonical_codec: "opus",
      playback_path: playbackPath,
      playback_mime: "audio/wav",
      playback_codec: "pcm_s16le",
      duration_ms: 0,
      bytes: playbackBytes.length,
      sha256: sha256(playbackBytes)
    };
    this.store.putMedia(media);
    normalized.content.voice.media_id = mediaId;
    normalized.content.voice.playback_ready = true;
    return media;
  }

  async ingestUpstreamMessage(topic, raw, meta = {}) {
    const normalized = this.normalizeGatewayMessage(topic, raw, meta);
    // Older Codex-backed Gateways mirror an unbound transcript before emitting
    // the authoritative chat.final event. Do not publish that duplicate as a
    // separate reply or guess its owner from text/timestamps.
    if (normalized.sender?.kind === "assistant" &&
        raw?.__openclaw?.mirrorOrigin === "codex-app-server" &&
        !normalized.source?.upstream_run_id) return null;
    const upstreamMessageId = normalized.source?.upstream_message_id;
    if (upstreamMessageId && this.store.findMessageByUpstream(topic.topic_key, upstreamMessageId)) {
      return null;
    }
    const runId = normalized.source?.upstream_run_id;
    if (runId && assistantReplyMatchesTurn(normalized, { runId }) &&
        this.store.getHistory(topic.topic_key, 0, 100000).items.some(item =>
          assistantReplyMatchesTurn(item, { runId }) &&
          item.content.text === normalized.content.text)) return null;
    const normalizedTextFingerprint = this.makeMirrorFingerprint(normalized);
    if (
      normalized.sender?.kind === "human" &&
      normalized.sender?.id === "operator" &&
      normalized.content?.kind === "text" &&
      normalizedTextFingerprint
    ) {
      const recentDeviceText = normalizedTextFingerprint.slice("text:".length);
      const existingDevice = this.store.findRecentDeviceText(
        topic.topic_key,
        recentDeviceText,
        Date.now() - 5 * 60_000
      );
      if (existingDevice) {
        return null;
      }
    }
    const outboundEcho = ["human", "device"].includes(normalized.sender?.kind);
    if (outboundEcho && this.isSuppressedMirror(topic.topic_key, normalized, upstreamMessageId)) {
      return null;
    }
    if (outboundEcho && this.consumePendingMirror(topic.topic_key, normalized)) {
      await this.store.save();
      return null;
    }
    if (normalized.sender.kind === "human" && !upstreamMessageId) {
      const existing = this.store.findLikelyOutboundDuplicate(topic.topic_key, normalized);
      if (existing) {
        return null;
      }
    }
    const appended = this.store.appendMessage(topic.topic_key, normalized);
    let media = null;
    if (appended.content.kind === "voice") {
      try {
        media = await this.resolveInboundVoiceFile(topic, appended);
      } catch (error) {
        console.warn(
          `[voice] inbound_media_unavailable topic=${topic.topic_key} ` +
          `err=${String(error?.message || error).slice(0, 240)}`
        );
      }
    }
    this.queueDeviceMessageEvent(topic.topic_key, appended);
    await this.store.save();
    this.broadcast(topic.topic_key, {
      type: "new_message",
      topic_key: topic.topic_key,
      session_key: topic.session_key,
      message: appended
    });
    if (media) {
      this.broadcast(topic.topic_key, {
        type: "voice_message_ready",
        topic_key: topic.topic_key,
        message_id: appended.id,
        media_id: media.media_id,
        download: {
          url: `/api/cardputer/v1/media/${media.media_id}?format=${this.config.playbackFormat}`,
          mime: media.playback_mime,
          codec: media.playback_codec,
          sample_rate_hz: 16000,
          channels: 1,
          bytes: media.bytes,
          sha256: media.sha256
        }
      });
    }
    return appended;
  }

  async handleUpstreamEvent(frame) {
    const finalChat = frame.event === "chat" && frame.payload?.state === "final";
    if (frame.event !== "session.message" && !finalChat) {
      return;
    }
    const sessionKey = frame.payload?.sessionKey;
    const topic = this.topicBySessionKey.get(sessionKey);
    if (!topic) {
      return;
    }
    let raw = frame.payload?.message || {};
    let messageId = frame.payload?.messageId || null;
    const runId = gatewayTurnCorrelation({}, { runId:frame.payload?.runId }).upstream_run_id;
    if (finalChat) {
      if (!runId || raw.role !== "assistant") return;
      const rawRunId = gatewayTurnCorrelation(raw).upstream_run_id;
      if (rawRunId && rawRunId !== runId) return;
      const stopReason = frame.payload?.stopReason || raw.stopReason || "stop";
      if (!/^(stop|end_turn|completed)$/iu.test(stopReason)) return;
      raw = { ...raw, stopReason };
      messageId = `gateway-run:${runId}:final`;
    }
    const appended = await this.ingestUpstreamMessage(topic, raw, { messageId, runId });
    if (
      appended &&
      topic.mirror_topic_key &&
      appended.sender?.kind === "assistant" &&
      appended.content?.kind === "text"
    ) {
      const mirrorTopic = this.store.getTopic(topic.mirror_topic_key);
      const text = String(appended.content.text || "").trim();
      if (mirrorTopic && text) {
        await this.appendAssistantReply({
          topicKey: mirrorTopic.topic_key,
          text,
          clientMsgId: `mirror:${appended.id}`,
          source: "cardputer_firmware_job_mirror"
        });
        void maybeRelayTelegramText(this.config, mirrorTopic, text, "OpenClaw").catch((error) => {
          console.warn(
            `[telegram] firmware_job_mirror_failed topic=${mirrorTopic.topic_key} ` +
            `err=${String(error.message || error).slice(0, 240)}`
          );
        });
      }
    }
  }

  broadcast(topicKey, payload) {
    for (const ws of this.clients) {
      if (ws.readyState === 1 && ws.topicKey === topicKey) {
        if (ws.compatMode === "mininerva") {
          this.compatBridge?.forwardEvent(ws, payload);
          continue;
        }
        ws.send(JSON.stringify(payload));
      }
    }
  }

  validateDevice(deviceId, token, topicKey) {
    const device = this.store.findDeviceByToken(token);
    if (!device || device.device_id !== deviceId) {
      return null;
    }
    if (!device.topics.includes(topicKey)) {
      return null;
    }
    return device;
  }

  currentTopicForDevice(deviceId) {
    const topicKey = this.store.getCurrentTopicKey(deviceId);
    return topicKey ? this.store.getTopic(topicKey) : null;
  }

	  resolveTopicSelector(deviceId, selector = "") {
    const trimmed = String(selector || "").trim();
    const topics = this.listTopicsForDevice(deviceId);
    if (!topics.length) {
      return null;
    }
    if (!trimmed) {
      return this.currentTopicForDevice(deviceId) || this.store.getTopic(topics[0].topic_key);
    }
    const index = Number.parseInt(trimmed, 10);
    if (Number.isFinite(index) && index >= 1 && index <= topics.length) {
      return this.store.getTopic(topics[index - 1].topic_key);
    }
    return this.store.getTopic(trimmed);
  }

  async switchDeviceTopic(deviceId, selector = "") {
    const topic = this.resolveTopicSelector(deviceId, selector);
    if (!topic) {
      return null;
    }
    this.store.setCurrentTopicKey(deviceId, topic.topic_key);
    await this.store.save();
    return topic;
  }

  async cycleDeviceTopic(deviceId, delta) {
    const topics = this.listTopicsForDevice(deviceId);
    if (!topics.length) {
      return null;
    }
    const currentTopicKey = this.store.getCurrentTopicKey(deviceId);
    const currentIndex = Math.max(0, topics.findIndex((topic) => topic.topic_key === currentTopicKey));
    const nextIndex = (currentIndex + delta + topics.length) % topics.length;
    return this.switchDeviceTopic(deviceId, topics[nextIndex].topic_key);
  }

  formatDeviceTopicList(deviceId) {
    const topics = this.listTopicsForDevice(deviceId);
    if (!topics.length) {
      return "No topics available.";
    }
    return topics
      .map((topic) => `${topic.current ? "*" : " "} ${topic.index}. ${topic.title}`)
      .join("\n");
  }

  buildTopicCatalog(deviceId, currentTopicKey, limitOverride = null) {
    const rawLimit = limitOverride ?? this.config.deviceTurnContext?.topicCatalogLimit ?? 12;
    const limit = Math.max(0, Number(rawLimit) || 0);
    if (limit <= 0) {
      return [];
    }
    return this.listTopicsForDevice(deviceId)
      .slice(0, limit)
      .map((topic) => ({
        index: topic.index,
        thread_id: topic.thread_id || topic.topic_key.split(":").at(-1),
        topic_key: topic.topic_key,
        title: topic.title,
        display_title: topicDisplayTitle(topic),
        short_title: topic.short_title || topicDisplayTitle(topic).slice(0, 12),
        emoji: topic.emoji || topic.icon || null,
        current: topic.topic_key === currentTopicKey,
        unread_count: topic.unread_count,
        head_seq: topic.head_seq
      }));
  }

  buildPromptHistoryEntries(topicKey, options = {}) {
    const items = this.store.getHistory(topicKey, 0, 100000).items;
    const limit = Math.max(1, Number(options.limit) || 6);
    const textLimit = Math.max(40, Number(options.textLimit) || 180);
    const charBudget = Math.max(120, Number(options.charBudget) || 1600);
    const recent = [];
    let spent = 0;
    const seenFingerprints = new Set();
    for (const item of [...items].reverse()) {
      const rawText =
        item.content?.kind === "text"
          ? item.content?.text
          : item.content?.kind === "voice"
            ? item.content?.transcript || `[Voice ${Math.round(Number(item.content?.voice?.duration_ms || 0) / 1000)}s]`
            : "";
      const text = trimmedPromptText(rawText, textLimit);
      if (!text) {
        continue;
      }
      const role = promptSenderLabel(item);
      const userishRole = role === "assistant" ? role : "userish";
      const fingerprint = `${userishRole}:${text}`;
      if (seenFingerprints.has(fingerprint)) {
        continue;
      }
      const entry = {
        seq: item.seq,
        role,
        text
      };
      const cost = entry.text.length + 24;
      if (recent.length > 0 && spent + cost > charBudget) {
        break;
      }
      recent.unshift(entry);
      spent += cost;
      seenFingerprints.add(fingerprint);
      if (recent.length >= limit) {
        break;
      }
    }
    return recent;
  }

  buildRecentHistoryForPrompt(topicKey, overrides = {}) {
    return this.buildPromptHistoryEntries(topicKey, {
      limit: overrides.limit ?? this.config.deviceTurnContext?.recentHistoryLimit,
      textLimit: overrides.textLimit ?? this.config.deviceTurnContext?.recentTextChars,
      charBudget: overrides.charBudget ?? this.config.deviceTurnContext?.recentHistoryChars
    });
  }

  buildRecentTopicsOverview(deviceId, currentTopicKey, overrides = {}) {
    const rawLimit = overrides.limit ?? this.config.deviceTurnContext?.topicPreviewLimit ?? 3;
    const limit = Math.max(0, Number(rawLimit) || 0);
    if (limit <= 0) {
      return [];
    }
    const entryLimit = Math.max(1, Number(this.config.deviceTurnContext?.topicPreviewEntryLimit) || 2);
    const textLimit = Math.max(40, Number(this.config.deviceTurnContext?.topicPreviewTextChars) || 120);
    const charBudget = Math.max(400, Number(this.config.deviceTurnContext?.topicPreviewChars) || 1800);
    const topics = this.listTopicsForDevice(deviceId)
      .filter((topic) => Number(topic.head_seq || 0) > 0)
      .sort((left, right) => {
        const delta = Number(right.head_seq || 0) - Number(left.head_seq || 0);
        if (delta !== 0) {
          return delta;
        }
        return Number(left.index || 0) - Number(right.index || 0);
      });
    const overview = [];
    let spent = 0;
    for (const topic of topics) {
      const preview = this.buildPromptHistoryEntries(topic.topic_key, {
        limit: entryLimit,
        textLimit,
        charBudget: Math.max(120, entryLimit * (textLimit + 32))
      });
      const entry = {
        index: topic.index,
        thread_id: topic.thread_id || topic.topic_key.split(":").at(-1),
        topic_key: topic.topic_key,
        title: topic.title,
        emoji: topic.emoji || topic.icon || null,
        current: topic.topic_key === currentTopicKey,
        unread_count: topic.unread_count,
        head_seq: topic.head_seq,
        preview
      };
      const previewChars = preview.reduce((total, item) => total + item.text.length + item.role.length + 8, 0);
      const cost = topic.title.length + previewChars + 96;
      if (overview.length > 0 && spent + cost > charBudget) {
        break;
      }
      overview.push(entry);
      spent += cost;
      if (overview.length >= limit) {
        break;
      }
    }
    return overview;
  }

  buildDeviceTurnUpstreamText({ device, topicKey, text, inputMode = "text" }) {
    if (!this.config.deviceTurnContext?.enabled) {
      return text;
    }
    const voiceTurn = inputMode === "voice";
    const wantsTopicContext = wantsTopicContextForText(text);
    const topic = this.store.getTopic(topicKey);
    const currentTopicKey = this.store.getCurrentTopicKey(device.device_id) || topicKey;
    const currentTopic = this.store.getTopic(currentTopicKey) || topic;
    const topicCatalogLimit = voiceTurn
      ? (wantsTopicContext ? this.config.deviceTurnContext?.voiceTopicCatalogLimit : 0)
      : this.config.deviceTurnContext?.topicCatalogLimit;
    const topicPreviewLimit = voiceTurn
      ? (wantsTopicContext ? this.config.deviceTurnContext?.voiceTopicPreviewLimit : 0)
      : this.config.deviceTurnContext?.topicPreviewLimit;
    const recentHistoryOverrides = voiceTurn
      ? {
          limit: this.config.deviceTurnContext?.voiceRecentHistoryLimit,
          textLimit: this.config.deviceTurnContext?.voiceRecentTextChars,
          charBudget: this.config.deviceTurnContext?.voiceRecentHistoryChars
        }
      : {};
    const context = {
      client: "cardputer_adv",
      user_id: device?.device_id || "cardputer",
      input_mode: inputMode,
      fast_profile: voiceTurn ? "cardputer_voice_fast" : "cardputer_text_fast",
      topic_structure: "Telegram forum topic -> one OpenClaw session. Continue inside the current topic first.",
      current_topic: currentTopic
        ? {
            topic_key: currentTopic.topic_key,
            session_key: currentTopic.session_key,
            title: currentTopic.title,
            thread_id: currentTopic.thread_id,
            contour_id: currentTopic.contour_id
          }
        : null,
      available_topics: this.buildTopicCatalog(device.device_id, currentTopicKey, topicCatalogLimit),
      recent_topics_overview: this.buildRecentTopicsOverview(device.device_id, currentTopicKey, {
        limit: topicPreviewLimit
      }),
      recent_topic_history: this.buildRecentHistoryForPrompt(topicKey, recentHistoryOverrides),
      firmware: this.buildFirmwarePromptContext(),
      device_firmware: this.deviceFirmwareReports.get(device.device_id) || null
    };
    const shortReplyWords = Math.max(8, Number(this.config.deviceTurnContext?.shortReplyWords) || 15);
    const voiceReplyMaxSeconds = Math.max(5, Number(this.config.deviceTurnContext?.voiceReplyMaxSeconds) || 25);
    const policy = {
      server_owned_execution: "Explicit owner instruction: all authenticated Cardputer requests and firmware work run on this OpenClaw server and return through this bridge. A desktop Codex chat, chat URL, binding or handoff is never a prerequisite. Earlier chat-specific holds or requests for a Codex-chat link are superseded for Cardputer work. Use the server repo and build/publish wrappers from firmware context; ask only for missing feature requirements, never for a desktop chat.",
      continue_from_current_topic_history_first: true,
      latency_target: voiceTurn
        ? "Preserve the configured model and full context. Keep simple spoken answers concise; perform firmware/development work with normal rigor."
        : "Keep Cardputer replies compact and low-latency.",
      if_user_asks_about_previous_context: "Use the full persistent session and available memory. recent_topic_history is only a transport hint, never a context limit.",
      if_user_asks_about_recent_topics: "Use recent_topics_overview only when present; otherwise ask the user to open topics.",
      if_user_mentions_other_topic: "Use available memory/tools for earlier work; ask only when the intended topic is ambiguous.",
      reply_language: REPLY_LANGUAGE_POLICY,
      topic_switching: "Indexes in available_topics map to /topic <index> on the device.",
      text_reply_style: `For text turns, default visible reply is ${shortReplyWords} words or fewer.`,
      voice_mode: inputMode === "voice"
        ? `For voice turns, give the actual answer in 1-3 spoken sentences when possible. Keep the full session context and all tools. For firmware/features, perform the requested work with normal rigor, then report the result. Do not merely promise to send a request. Never reply NO_REPLY.`
        : "If a full answer would be long, keep the text short and front-load the key point.",
      firmware_capabilities: buildFirmwareCapabilityPolicyText(),
      device_actions: buildDeviceActionPolicyText()
    };
    return buildDeviceTurnEnvelope({ context, policy, text, inputMode, compact: voiceTurn });
  }

  async handleOmnibotCommand(device, rawText) {
    const text = String(rawText || "").trim();
    if (!text.startsWith("/")) {
      return null;
    }
    const lower = text.toLowerCase();
    if (lower === "/topics") {
      return {
        reply: this.formatDeviceTopicList(device.device_id)
      };
    }
    if (lower === "/topic current") {
      const current = this.currentTopicForDevice(device.device_id);
      return {
        reply: current ? `Current topic: ${current.title}` : "No topic selected."
      };
    }
    if (lower.startsWith("/topic ")) {
      const selector = text.slice("/topic ".length).trim();
      const topic = await this.switchDeviceTopic(device.device_id, selector);
      return {
        reply: topic ? `Switched to ${topic.title}` : `Unknown topic: ${selector}`
      };
    }
    if (lower === "/next") {
      const topic = await this.cycleDeviceTopic(device.device_id, 1);
      return {
        reply: topic ? `Switched to ${topic.title}` : "No topics available."
      };
    }
    if (lower === "/prev") {
      const topic = await this.cycleDeviceTopic(device.device_id, -1);
      return {
        reply: topic ? `Switched to ${topic.title}` : "No topics available."
      };
    }
    return null;
  }

  async waitForAssistantReply(topicKey, afterSeq, waitMs, pollMs, _replyStartedAtMs = 0, turnReceipt = null) {
    const timeoutMs = Math.max(1000, Number(waitMs) || this.config.omnibotShim.turnWaitMs);
    const intervalMs = Math.max(50, Number(pollMs) || this.config.omnibotShim.turnPollMs);
    const request = this.store.getHistory(topicKey, 0, 100000).items.find(item =>
      Number(item.seq) === Number(afterSeq) && item.sender?.kind === "device");
    const clientMsgId = turnReceipt?.client_msg_id || request?.client_msg_id;
    const deviceId = String(request?.sender?.id || "").startsWith("cardputer:")
      ? request.sender.id.slice("cardputer:".length) : null;
    const expectedRunId = deviceId && clientMsgId ? `cardputer:${deviceId}:${topicKey}:${clientMsgId}` : null;
    if (!turnReceipt?.upstream_run_id && !request?.source?.upstream_run_id && !clientMsgId) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // A retry can start waiting before the first dispatch receives an opaque
      // Gateway run ID. Follow its persisted receipt without changing ownership.
      const persistedReceipt = clientMsgId ? this.store.getIdempotent(topicKey, clientMsgId) : null;
      const runId = persistedReceipt?.upstream_run_id || request?.source?.upstream_run_id ||
        turnReceipt?.upstream_run_id || expectedRunId;
      const items = this.store.getHistory(topicKey, 0, 100000).items;
      const reply = items.find(item =>
        Number(item.seq || 0) > Number(afterSeq || 0) &&
        assistantReplyMatchesTurn(item, { runId, clientMsgId }) &&
        isMeaningfulAssistantReplyText(item.content?.text));
      if (reply) return reply;
      if (persistedReceipt?.upstream_terminal?.status === "error") {
        const entry = this.turnOutbox?.entries().find(item => item.topic_key === topicKey && item.client_msg_id === clientMsgId);
        const failure = entry && await this.recordOutboxFailure(entry);
        if (failure) return failure;
      }
      await sleep(intervalMs);
    }
    return null;
  }

  makeMirrorFingerprint(message) {
    if (message?.content?.kind === "voice") {
      const duration = Number(message.content?.voice?.duration_ms || 0);
      return `voice:${Math.round(duration / 1000)}`;
    }
    if (message?.content?.kind === "text") {
      return `text:${canonicalizeMirrorText(String(message.content.text || ""))}`;
    }
    return null;
  }

  rememberPendingMirror(topicKey, message, ttlMs = 120000) {
    const fingerprint = this.makeMirrorFingerprint(message);
    if (!fingerprint) {
      return;
    }
    const bucket = this.pendingMirrors.get(topicKey) || [];
    bucket.push({
      fingerprint,
      expiresAt: Date.now() + ttlMs
    });
    this.pendingMirrors.set(
      topicKey,
      bucket.filter((entry) => entry.expiresAt > Date.now())
    );
  }

  consumePendingMirror(topicKey, normalized) {
    const fingerprint = this.makeMirrorFingerprint(normalized);
    if (!fingerprint) {
      return false;
    }
    const now = Date.now();
    const bucket = (this.pendingMirrors.get(topicKey) || []).filter((entry) => entry.expiresAt > now);
    const index = bucket.findIndex((entry) => entry.fingerprint === fingerprint);
    if (index < 0) {
      this.pendingMirrors.set(topicKey, bucket);
      return false;
    }
    bucket.splice(index, 1);
    this.pendingMirrors.set(topicKey, bucket);
    const suppressions = (this.suppressedMirrors.get(topicKey) || []).filter((entry) => entry.expiresAt > now);
    suppressions.push({
      fingerprint,
      upstreamMessageId: normalized.source?.upstream_message_id || null,
      expiresAt: now + 120000
    });
    this.suppressedMirrors.set(topicKey, suppressions);
    return true;
  }

  isSuppressedMirror(topicKey, normalized, upstreamMessageId) {
    const fingerprint = this.makeMirrorFingerprint(normalized);
    const now = Date.now();
    const bucket = (this.suppressedMirrors.get(topicKey) || []).filter((entry) => entry.expiresAt > now);
    this.suppressedMirrors.set(topicKey, bucket);
    return bucket.some(
      (entry) =>
        (upstreamMessageId && entry.upstreamMessageId && upstreamMessageId === entry.upstreamMessageId) ||
        (fingerprint && entry.fingerprint === fingerprint)
    );
  }

  updateOutboxReceipt(entry) {
    const ack = this.store.getIdempotent(entry.topic_key, entry.client_msg_id) || entry.receipt;
    if (!ack) return;
    ack.upstream_run_id = entry.run_id;
    ack.upstream_accepted = entry.upstream_accepted === true;
    ack.delivery_state = entry.phase;
    if (entry.terminal) ack.upstream_terminal = entry.terminal;
    entry.receipt = { ...ack };
    this.store.setIdempotent(entry.topic_key, entry.client_msg_id, ack);
    const message = this.store.getHistory(entry.topic_key, 0, 100000).items.find(item => item.id === ack.message_id);
    if (message) message.source.upstream_run_id = entry.run_id;
  }

  async recordOutboxFailure(entry) {
    if (entry.terminal?.status !== "error" || entry.terminal.operator_audit) return null;
    const topic = this.store.getTopic(entry.topic_key);
    const device = this.store.state.devices[entry.device_id];
    if (topic?.session_key !== entry.session_key || !device || device.revoked_at || !device.topics?.includes(entry.topic_key)) return null;
    const history = this.store.getHistory(entry.topic_key, 0, 100000).items;
    const existing = history.find(message => assistantReplyMatchesTurn(message, { runId: entry.run_id,
      clientMsgId: entry.client_msg_id }) && isMeaningfulAssistantReplyText(message.content?.text));
    if (existing || entry.failure_message_id) return existing || null;
    const failure = await this.appendAssistantReply({ topicKey: entry.topic_key,
      text: "The request failed on the server. No completed answer was received. Check this request before submitting it again.",
      clientMsgId: entry.client_msg_id, source: "cardputer_turn_failed", upstreamRunId: entry.run_id, terminalError: true });
    entry.failure_message_id = failure.id;
    await this.store.save();
    return failure;
  }

  async dispatchOutboxTurn(entry) {
    const topic = this.store.getTopic(entry.topic_key);
    console.info(`[turn] dispatch topic=${entry.topic_key} client=${entry.client_msg_id} context=full`);
    try {
      return await this.upstream.rpc("sessions.send", entry.params);
    } catch (error) {
      if (!String(error.message || error).toLowerCase().includes("session not found")) throw error;
      await this.ensureUpstreamSessionForTopic(topic, { forceCreate: true });
      this.registerRuntimeTopic(topic);
      return await this.upstream.rpc("sessions.send", entry.params);
    }
  }

  async sendText({ device, topicKey, clientMsgId, text, upstreamText = null, waitForUpstream = false, inputMode = "text" }) {
    const topic = this.store.getTopic(topicKey);
    if (!topic) {
      throw new Error("unknown topic");
    }
    const existing = this.store.getIdempotent(topicKey, clientMsgId);
    if (existing) {
      return existing;
    }
    const expectedRunId = `cardputer:${device.device_id}:${topicKey}:${clientMsgId}`;
    const retained = this.turnOutbox.entries().find(entry => entry.id === expectedRunId);
    if (retained) {
      if (retained.device_id !== device.device_id || retained.session_key !== topic.session_key || retained.topic_key !== topicKey)
        throw new Error("Persisted turn owner changed; reconciliation is required before retrying.");
      this.updateOutboxReceipt(retained);
      const receipt = this.store.getIdempotent(topicKey, clientMsgId);
      if (!receipt) throw new Error("Persisted turn receipt requires reconciliation; the request will not be resent.");
      await this.store.save();
      return receipt;
    }
    const params = { key: topic.session_key, message: upstreamText || text, idempotencyKey: expectedRunId };
    const thinking = voiceThinking(text, inputMode);
    if (thinking) params.thinking = thinking;
    this.turnOutbox.assertCapacity(topic.session_key, params);
    const message = this.store.appendMessage(topicKey, {
      id: makeId("msg"),
      created_at: nowIso(),
      updated_at: nowIso(),
      client_msg_id: clientMsgId,
      sender: {
        kind: "device",
        id: `cardputer:${device.device_id}`,
        display_name: "Cardputer"
      },
      source: {
        transport: "cardputer",
        upstream_run_id: expectedRunId
      },
      content: {
        kind: "text",
        text
      }
    });
    const ack = {
      type: "ack",
      topic_key: topicKey,
      client_msg_id: clientMsgId,
      upstream_run_id: expectedRunId,
      upstream_accepted: false,
      message_id: message.id,
      seq: message.seq,
      accepted_at: nowIso()
    };
    this.store.setIdempotent(topicKey, clientMsgId, ack);
    this.rememberPendingMirror(topicKey, message);
    const ticket = await this.turnOutbox.enqueue({
      id: expectedRunId, run_id: expectedRunId, topic_key: topicKey,
      session_key: topic.session_key, device_id: device.device_id,
      client_msg_id: clientMsgId, params, receipt: { ...ack }
    });
    this.broadcast(topicKey, {
      type: "new_message", topic_key: topicKey, session_key: topic.session_key, message
    });

    const mirrorToTelegram = async () => {
      const mirroredMessageId = await maybeRelayTelegramText(this.config, topic, text);
      this.broadcast(topicKey, {
        type: "delivery_status",
        topic_key: topicKey,
        message_id: message.id,
        client_msg_id: clientMsgId,
        state: mirroredMessageId ? "mirrored" : "accepted",
        mirrored_to: mirroredMessageId
          ? {
              transport: "telegram",
              message_id: mirroredMessageId
            }
          : undefined,
        updated_at: nowIso()
      });
    };
    const failDelivery = (error) => {
      this.broadcast(topicKey, {
        type: "delivery_status",
        topic_key: topicKey,
        message_id: message.id,
        client_msg_id: clientMsgId,
        state: "failed",
        error: String(error.message || error),
        updated_at: nowIso()
      });
    };
    if (waitForUpstream) {
      try {
        if (ticket.dispatched) await ticket.dispatched;
        void mirrorToTelegram().catch((error) => failDelivery(error));
      } catch (error) {
        failDelivery(error);
        throw error;
      }
    } else {
      void (async () => {
        try {
          if (ticket.dispatched) await ticket.dispatched;
          await mirrorToTelegram();
        } catch (error) {
          failDelivery(error);
        }
      })();
    }
	    return ack;
	  }

  async sendVoice({ device, topicKey, clientMsgId, durationMs, uploadPath, originalFileName, mimeType, bytes }) {
    const topic = this.store.getTopic(topicKey);
    if (!topic) {
      throw new Error("unknown topic");
    }
    const existing = this.store.getIdempotent(topicKey, clientMsgId);
    if (existing) {
      return existing;
    }
    const mediaId = makeId("med");
    const canonicalPath = path.join(this.config.media.canonicalDir, `${mediaId}.ogg`);
    const playbackPath = path.join(this.config.media.playbackDir, `${mediaId}.wav`);
    await transcode({
      inputPath: uploadPath,
      outputPath: canonicalPath,
      args: ["-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k"]
    });
    await transcode({
      inputPath: uploadPath,
      outputPath: playbackPath,
      args: ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"]
    });
    const playbackBytes = await readFile(playbackPath);
    const media = {
      media_id: mediaId,
      topic_key: topicKey,
      message_id: null,
      canonical_path: canonicalPath,
      canonical_mime: "audio/ogg",
      canonical_codec: "opus",
      playback_path: playbackPath,
      playback_mime: "audio/wav",
      playback_codec: "pcm_s16le",
      duration_ms: durationMs,
      bytes: playbackBytes.length,
      sha256: sha256(playbackBytes)
    };
    const message = this.store.appendMessage(topicKey, {
      id: makeId("msg"),
      created_at: nowIso(),
      updated_at: nowIso(),
      client_msg_id: clientMsgId,
      sender: {
        kind: "device",
        id: `cardputer:${device.device_id}`,
        display_name: "Cardputer"
      },
      source: {
        transport: "cardputer"
      },
      content: {
        kind: "voice",
        voice: {
          media_id: mediaId,
          duration_ms: durationMs,
          canonical_mime: "audio/ogg",
          canonical_codec: "opus",
          playback_ready: true
        }
      }
    });
    media.message_id = message.id;
    this.store.putMedia(media);
    const ack = {
      type: "ack",
      topic_key: topicKey,
      client_msg_id: clientMsgId,
      message_id: message.id,
      seq: message.seq,
      accepted_at: nowIso(),
      upload: {
        file_name: originalFileName,
        mime: mimeType,
        bytes
      }
    };
    this.store.setIdempotent(topicKey, clientMsgId, ack);
    this.rememberPendingMirror(topicKey, message);
    await this.store.save();
    this.broadcast(topicKey, {
      type: "new_message",
      topic_key: topicKey,
      session_key: topic.session_key,
      message
    });
    this.broadcast(topicKey, {
      type: "voice_message_ready",
      topic_key: topicKey,
      message_id: message.id,
      media_id: mediaId,
      download: {
        url: `/api/cardputer/v1/media/${mediaId}?format=${this.config.playbackFormat}`,
        mime: media.playback_mime,
        codec: media.playback_codec,
        sample_rate_hz: 16000,
        channels: 1,
        bytes: media.bytes,
        sha256: media.sha256
      }
    });

    void (async () => {
      try {
        const transcription = await maybeTranscribeVoice(this.config, playbackPath).catch(() => "");
        const runId = `cardputer:${device.device_id}:${topicKey}:${clientMsgId}`;
        const ticket = await this.turnOutbox.enqueue({
          id: runId, run_id: runId, topic_key: topicKey, session_key: topic.session_key,
          device_id: device.device_id, client_msg_id: clientMsgId,
          params: { key: topic.session_key,
            message: transcription || `[Voice message from Cardputer, ${Math.round(durationMs / 1000)}s]`,
            idempotencyKey: runId }
        });
        if (ticket.dispatched) await ticket.dispatched;
        const mirroredMessageId = await maybeRelayTelegramVoice(this.config, topic, canonicalPath);
        this.broadcast(topicKey, {
          type: "delivery_status",
          topic_key: topicKey,
          message_id: message.id,
          client_msg_id: clientMsgId,
          state: mirroredMessageId ? "mirrored" : "accepted",
          mirrored_to: mirroredMessageId
            ? {
                transport: "telegram",
                message_id: mirroredMessageId
              }
            : undefined,
          updated_at: nowIso()
        });
      } catch (error) {
        this.broadcast(topicKey, {
          type: "delivery_status",
          topic_key: topicKey,
          message_id: message.id,
          client_msg_id: clientMsgId,
          state: "failed",
          error: String(error.message || error),
          updated_at: nowIso()
        });
      }
    })();
    return ack;
  }
}

async function main() {
  process.umask(0o077);
  const config = await loadConfig();
  const runtime = new BridgeRuntime(config);
  const realtimeAdmission = new RealtimeAdmissionController(config);
  const requestAdmission = new RealtimeAdmissionController({ realtimeVoice: {
    maxActivePerDevice: config.security.maxActiveRequestsPerDevice,
    maxActiveGlobal: config.security.maxActiveRequestsGlobal,
    startLimitPerDevice: config.security.requestStartLimitPerDevice
  } });
  const storageBudget = new PrivateStorageBudget(config);
  await runtime.start();
  if (config.mininervaCompat?.enabled === true)
    runtime.compatBridge = createMininervaCompatServer({ runtime, config, recordAuthFailure, clearAuthFailures, requestAdmission, storageBudget });

  const server = createServer((req, res) => {
    let releaseRequest = () => {};
    void (async () => {
      const url = parseRequestUrl(req);
      const token = parseOmnibotAuthToken(req);
      const device = runtime.store.findDeviceByToken(token);

      applyCors(req, res, config);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname.startsWith("/internal/")) {
        if (!hasInternalOtaAccess(req, config) ||
            req.method !== "POST" ||
            url.pathname !== "/internal/cardputer/ota-install") {
          json(res, 404, { error: "not_found" });
          return;
        }
        if (!device && isAuthRateLimited(req, config)) {
          json(res, 429, { error: "too_many_auth_failures", retryable: true });
          return;
        }
        if (!device) {
          if (token) {
            recordAuthFailure(req, config);
          }
          json(res, 401, authErrorPayload("device token missing or invalid"));
          return;
        }
        clearAuthFailures(req, config);
        const payload = await readJsonBody(req, config.security.maxJsonBytes);
        if (!payload || typeof payload !== "object") {
          requestError(res, 400, "invalid_json");
          return;
        }
        try {
          const result = await runtime.enqueueOtaInstall({
            device,
            version: payload.version,
            minimumBattery: payload.min_battery
          });
          json(res, 200, result);
        } catch (error) {
          requestError(res, Number(error?.statusCode) || 400, String(error.message || error));
        }
        return;
      }

    const protectedDevicePath =
      isOmnibotShimPath(url.pathname) || url.pathname.startsWith("/api/cardputer/");
    if (protectedDevicePath && !device && isAuthRateLimited(req, config)) {
      json(res, 429, { error: "too_many_auth_failures", retryable: true });
      return;
    }
    if (device) {
      clearAuthFailures(req, config);
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, device
        ? {
            ok: true,
            upstream_connected: runtime.upstream.connected,
            ...runtime.turnOutbox.diagnostics(),
            device_firmware: runtime.deviceFirmwareReports.get(device.device_id) || null,
            ...buildConnectPayload(config, req)
          }
        : { ok: true });
      return;
    }

    if (isOmnibotShimPath(url.pathname) && (!config.omnibotShim?.enabled || !device)) {
      if (!device && token) {
        recordAuthFailure(req, config);
      }
      json(res, 401, authErrorPayload("device token missing or invalid"));
      return;
    }

    if (url.pathname.startsWith("/api/cardputer/") && !device) {
      if (token) {
        recordAuthFailure(req, config);
      }
      json(res, 401, authErrorPayload("device token missing or invalid"));
      return;
    }

    const persistentRequest = req.method === "POST" &&
        (isOmnibotShimPath(url.pathname) || /\/(messages|voice|create|logs)$/.test(url.pathname));
    if (device && (persistentRequest || (req.method==="GET"&&url.pathname==="/api/cardputer/assets/manifest"))) {
      const lease = requestAdmission.acquire(device.device_id);
      if (!lease.ok) {
        json(res, 429, { error: "device_request_limit", retryable: true, retry_after_ms: lease.retryAfterMs });
        return;
      }
      releaseRequest = lease.release;
      if (persistentRequest) {
        const storage = await storageBudget.acquire();
        if (!storage.ok) {
          json(res, 507, { error:"bridge_storage_limit", detail:"Private storage is full or unavailable. Archive old bridge data or increase the reviewed storage budget before retrying." });
          return;
        }
        releaseRequest = () => { lease.release(); storage.release(); };
      }
    }

    if (req.method === "GET" && url.pathname === "/api/cardputer/device-actions") {
      json(res, 200, buildDeviceActionsPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/device-text-turn") {
      const payload = await readJsonBody(req, config.security.maxJsonBytes);
      if (!payload || typeof payload !== "object") {
        requestError(res, 400, "invalid_json");
        return;
      }
      const message = String(payload.message || "").trim();
      const wantsReplyAudio = isTruthyHeader(req.headers["x-reply-audio"]) || isTruthyHeader(payload.reply_audio);
      if (!message) {
        requestError(res, 400, "message cannot be empty");
        return;
      }

      try {
        const commandResult = await runtime.handleOmnibotCommand(device, message);
        if (commandResult) {
          json(res, 200, await runtime.buildTurnResponse({
            req,
            topic: runtime.currentTopicForDevice(device.device_id),
            transcript: message,
            replyText: commandResult.reply || "",
            includeAudio: wantsReplyAudio
          }));
          return;
        }

        const topic = runtime.resolveTopicFromConversationKey(device, req.headers["x-conversation-key"]);
        if (!topic) {
          requestError(res, 409, "no_topic_selected");
          return;
        }
        const clientMsgId = String(req.headers["x-client-msg-id"] || payload.client_msg_id || makeId("cli")).trim().slice(0, 96);
        const fastLane = await runtime.tryFastLaneTurn({
          req,
          device,
          topic,
          clientMsgId,
          transcript: message,
          inputMode: "text",
          wantsReplyAudio
        });
        if (fastLane?.response) {
          json(res, 200, fastLane.response);
          return;
        }
        if (fastLane && !fastLane.fallback) {
          requestError(res, 503, "fast lane unavailable", {
            detail: String(fastLane.error?.message || fastLane.error || "").slice(0, 240)
          });
          return;
        }
        const replyStartedAtMs = Date.now();
        const ack = fastLane?.ack || await runtime.sendText({
          device,
          topicKey: topic.topic_key,
          clientMsgId,
          text: message,
          upstreamText: runtime.buildDeviceTurnUpstreamText({
            device,
            topicKey: topic.topic_key,
            text: message,
            inputMode: "text"
          }),
          waitForUpstream: true
        });
        const reply = await runtime.waitForAssistantReply(
          topic.topic_key,
          ack.seq,
          config.omnibotShim.turnWaitMs,
          config.omnibotShim.turnPollMs,
          replyStartedAtMs,
          ack
        );
        if (!reply) {
          console.info(`[turn] assistant pending topic=${topic.topic_key} client=${clientMsgId} wait=${config.omnibotShim.turnWaitMs}`);
          const receipt = await runtime.buildPendingTurnResponse({ req, device, topic, transcript: message, ack });
          json(res, receipt.pending ? 202 : 200, receipt);
          return;
        }
        json(res, 200, await runtime.buildTurnResponse({
          req,
          topic,
          transcript: message,
          replyText: String(reply.content?.text || "").trim(),
          replyMessage: reply,
          includeAudio: wantsReplyAudio
        }));
      } catch (error) {
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/device-audio-turn") {
      const upload = await readMultipartUpload(req, config).catch((error) => ({ error }));

      if (upload?.error) {
        requestError(
          res,
          isRequestTooLarge(upload.error) ? 413 : 400,
          String(upload.error.message || upload.error)
        );
        return;
      }
      if (!upload.data?.length) {
        requestError(res, 400, "audio file cannot be empty");
        return;
      }
      const wantsReplyAudio = isTruthyHeader(req.headers["x-reply-audio"]) || isTruthyHeader(upload.fields.reply_audio);

      try {
        const transcript = await transcribeDeviceAudio(config, {
          audioBytes: upload.data,
          filename: upload.originalFileName || "cardputer.wav",
          mimeType: upload.mimeType || "audio/wav"
        });
        if (!transcript) {
          console.warn(`[voice] failed device=${device.device_id} stage=stt_empty`);
          requestError(res, 422, "could not transcribe speech");
          return;
        }
        const commandResult = await runtime.handleOmnibotCommand(device, transcript);
        if (commandResult) {
          json(res, 200, await runtime.buildTurnResponse({
            req,
            topic: runtime.currentTopicForDevice(device.device_id),
            transcript,
            replyText: commandResult.reply || "",
            includeAudio: wantsReplyAudio
          }));
          return;
        }
        const topic = runtime.resolveTopicFromConversationKey(device, req.headers["x-conversation-key"]);
        if (!topic) {
          requestError(res, 409, "no_topic_selected");
          return;
        }
        const clientMsgId = String(req.headers["x-client-msg-id"] || makeId("cli")).trim().slice(0, 96);
        const fastLane = await runtime.tryFastLaneTurn({
          req,
          device,
          topic,
          clientMsgId,
          transcript,
          inputMode: "voice",
          wantsReplyAudio
        });
        if (fastLane?.response) {
          json(res, 200, fastLane.response);
          return;
        }
        if (fastLane && !fastLane.fallback) {
          requestError(res, 503, "fast lane unavailable", {
            detail: String(fastLane.error?.message || fastLane.error || "").slice(0, 240)
          });
          return;
        }
        const replyStartedAtMs = Date.now();
        const ack = fastLane?.ack || await runtime.sendText({
          device,
          topicKey: topic.topic_key,
          clientMsgId,
          text: transcript,
          inputMode: "voice",
          upstreamText: runtime.buildDeviceTurnUpstreamText({
            device,
            topicKey: topic.topic_key,
            text: transcript,
            inputMode: "voice"
          }),
          waitForUpstream: true
        });
        const reply = await runtime.waitForAssistantReply(
          topic.topic_key,
          ack.seq,
          config.omnibotShim.turnWaitMs,
          config.omnibotShim.turnPollMs,
          replyStartedAtMs,
          ack
        );
        if (!reply) {
          console.info(`[turn] assistant pending topic=${topic.topic_key} client=${clientMsgId} wait=${config.omnibotShim.turnWaitMs}`);
          const receipt = await runtime.buildPendingTurnResponse({ req, device, topic, transcript: transcript, ack });
          json(res, receipt.pending ? 202 : 200, receipt);
          return;
        }
        json(res, 200, await runtime.buildTurnResponse({
          req,
          topic,
          transcript,
          replyText: String(reply.content?.text || "").trim(),
          replyMessage: reply,
          includeAudio: wantsReplyAudio
        }));
      } catch (error) {
        console.warn(
          `[voice] failed device=${device.device_id} ` +
          `stage=turn err=${String(error.message || error).slice(0, 240)}`
        );
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/device-audio-turn-raw") {
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const sampleRateRaw = String(req.headers["x-audio-sample-rate"] || "16000").trim();
      const sampleRate = Math.max(8000, Math.min(48000, Number.parseInt(sampleRateRaw, 10) || 16000));
      const wantsReplyAudio = isTruthyHeader(req.headers["x-reply-audio"]) || isTruthyHeader(req.headers["x-save-reply-audio"]);
      const turnId = String(req.headers["x-turn-id"] || req.headers["x-client-msg-id"] || "").trim().slice(0, 96);
      const rawUploadPath = path.join(config.media.tmpDir, `${makeId("device-raw")}.bin`);
      let uploadedBytes = 0;
      try {
        uploadedBytes = await streamRequestToFile(req, rawUploadPath, config.maxUploadBytes);
      } catch (error) {
        if (error?.code === "ECONNRESET" || String(error?.message || "").toLowerCase().includes("aborted")) {
          console.warn(`[voice-raw] aborted device=${device.device_id} turn=${turnId || "-"} err=${String(error?.message || error)}`);
          return;
        }
        if (isRequestTooLarge(error)) {
          console.warn(`[voice-raw] too_large device=${device.device_id} turn=${turnId || "-"} max=${config.maxUploadBytes}`);
          requestError(res, 413, String(error.message || "upload_too_large"));
          return;
        }
        throw error;
      }
      if (!uploadedBytes) {
        await rm(rawUploadPath,{force:true});
        requestError(res, 400, "audio body cannot be empty");
        return;
      }
      if (uploadedBytes > config.maxUploadBytes) {
        await rm(rawUploadPath,{force:true});
        requestError(res, 413, "upload_too_large");
        return;
      }
      console.info(`[voice-raw] uploaded device=${device.device_id} turn=${turnId || "-"} bytes=${uploadedBytes} sample=${sampleRate} type=${contentType || "-"} reply_audio=${wantsReplyAudio ? "1" : "0"}`);
      const audioBytesRaw = await readFile(rawUploadPath).finally(()=>rm(rawUploadPath,{force:true}));
      let audioBytes =
        contentType === "application/octet-stream" || contentType === "audio/pcm" || contentType === "audio/l16"
          ? Buffer.concat([createWavHeader(audioBytesRaw.length, sampleRate), audioBytesRaw])
          : audioBytesRaw;

      try {
        audioBytes = decodeVoiceUpload(audioBytes, config.maxUploadBytes);
        const transcript = await transcribeDeviceAudio(config, {
          audioBytes,
          filename: "cardputer.wav",
          mimeType: "audio/wav"
        });
        if (!transcript) {
          console.warn(`[voice-raw] failed device=${device.device_id} turn=${turnId || "-"} stage=stt_empty`);
          requestError(res, 422, "could not transcribe speech");
          return;
        }
        console.info(`[voice-raw] transcript device=${device.device_id} turn=${turnId || "-"} chars=${transcript.length}`);
        const commandResult = await runtime.handleOmnibotCommand(device, transcript);
        if (commandResult) {
          console.info(`[voice-raw] command device=${device.device_id} turn=${turnId || "-"}`);
          json(res, 200, await runtime.buildTurnResponse({
            req,
            topic: runtime.currentTopicForDevice(device.device_id),
            transcript,
            replyText: commandResult.reply || "",
            includeAudio: wantsReplyAudio
          }));
          return;
        }
        const topic = runtime.resolveTopicFromConversationKey(device, req.headers["x-conversation-key"]);
        if (!topic) {
          requestError(res, 409, "no_topic_selected");
          return;
        }
        const clientMsgId = String(req.headers["x-client-msg-id"] || makeId("cli")).trim().slice(0, 96);
        const fastLane = await runtime.tryFastLaneTurn({
          req,
          device,
          topic,
          clientMsgId,
          transcript,
          inputMode: "voice",
          wantsReplyAudio
        });
        if (fastLane?.response) {
          json(res, 200, fastLane.response);
          return;
        }
        if (fastLane && !fastLane.fallback) {
          requestError(res, 503, "fast lane unavailable", {
            detail: String(fastLane.error?.message || fastLane.error || "").slice(0, 240)
          });
          return;
        }
        const replyStartedAtMs = Date.now();
        const ack = fastLane?.ack || await runtime.sendText({
          device,
          topicKey: topic.topic_key,
          clientMsgId,
          text: transcript,
          inputMode: "voice",
          upstreamText: runtime.buildDeviceTurnUpstreamText({
            device,
            topicKey: topic.topic_key,
            text: transcript,
            inputMode: "voice"
          }),
          waitForUpstream: true
        });
        const voiceWaitMs = voiceReplyWaitMs(req.headers["x-voice-wait-ms"], config.omnibotShim.voiceTurnWaitMs || config.omnibotShim.turnWaitMs);
        const reply = await runtime.waitForAssistantReply(
          topic.topic_key,
          ack.seq,
          voiceWaitMs,
          config.omnibotShim.turnPollMs,
          replyStartedAtMs,
          ack
        );
        if (!reply) {
          console.info(`[turn] assistant pending topic=${topic.topic_key} client=${clientMsgId} wait=${voiceWaitMs}`);
          // Keep the existing raw-voice HTTP 200 transport contract.
          json(res, 200, await runtime.buildPendingTurnResponse({ req, device, topic, transcript, ack }));
          return;
        }
        console.info(`[voice-raw] reply device=${device.device_id} turn=${turnId || "-"} topic=${topic.topic_key} seq=${reply.seq}`);
        json(res, 200, await runtime.buildTurnResponse({
          req,
          topic,
          transcript,
          replyText: String(reply.content?.text || "").trim(),
          replyMessage: reply,
          includeAudio: wantsReplyAudio
        }));
      } catch (error) {
        console.warn(
          `[voice-raw] failed device=${device.device_id} turn=${turnId || "-"} ` +
          `stage=turn err=${String(error.message || error).slice(0, 240)}`
        );
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/device-tts") {
      const payload = await readJsonBody(req, config.security.maxJsonBytes);
      if (!payload || typeof payload !== "object") {
        requestError(res, 400, "invalid_json");
        return;
      }
      const text = String(payload.text || "").trim();
      if (!text) {
        requestError(res, 400, "text cannot be empty");
        return;
      }

	      try {
	        const sourceSampleRate = 24000;
	        let targetSampleRate = Math.max(8000, Number(config.omnibotShim.ttsSampleRate) || sourceSampleRate);
	        let outputPcm = null;
	        let provider = "openai";
	        if (openAiApiKey()) {
	          try {
	            const pcm = await synthesizeOpenAiTtsPcm({
	              text,
	              model: config.omnibotShim.ttsModel,
	              voice: config.omnibotShim.ttsVoice,
	              timeoutMs: Math.max(1000, Number(config.omnibotShim.ttsTimeoutMs) || 8000)
	            });
	            outputPcm = downsamplePcm16Mono(pcm, sourceSampleRate, targetSampleRate);
	          } catch (error) {
	            console.warn(`[tts] device_openai_failed err=${String(error.message || error).slice(0, 240)}`);
	          }
	        }
	        if (!outputPcm?.length && String(config.omnibotShim.ttsFallbackProvider || "").toLowerCase() === "espeak") {
	          provider = "espeak";
	          const voice = containsCyrillic(text)
	            ? config.omnibotShim.ttsFallbackVoiceRu
	            : config.omnibotShim.ttsFallbackVoiceEn;
	          try {
	            const wavBytes = await synthesizeEspeakTtsWav({
	              text,
	              bin: config.omnibotShim.ttsFallbackBin || "espeak-ng",
	              voice: voice || "en-us"
	            });
	            const wavPcm = extractWavPcm16Mono(wavBytes);
	            if (wavPcm?.pcm?.length) {
	              targetSampleRate = wavPcm.sampleRate;
	              outputPcm = wavPcm.pcm;
	            }
	          } catch (error) {
	            console.warn(`[tts] device_espeak_failed err=${String(error.message || error).slice(0, 240)}`);
	          }
	        }
	        if (!outputPcm?.length) {
	          res.writeHead(204);
	          res.end();
	          return;
	        }
	        console.info(`[tts] device_tts provider=${provider} bytes=${outputPcm.length} sample_rate=${targetSampleRate}`);
	        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(outputPcm.length),
          "X-Audio-Encoding": "pcm_s16le",
          "X-Audio-Channels": "1",
          "X-Audio-Sample-Rate": String(targetSampleRate)
        });
        res.end(outputPcm);
      } catch (error) {
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cardputer/assets/manifest") {
      try {
        const manifest = await runtime.listDeviceAssets(device, req);
        json(res, 200, manifest);
      } catch (error) {
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    const assetFileMatch = url.pathname.match(/^\/api\/cardputer\/assets\/file\/(.+)$/);
    if (req.method === "GET" && assetFileMatch) {
      const asset = runtime.resolveAssetDownload(device, decodeURIComponent(assetFileMatch[1]));
      if (!asset) {
        json(res, 404, { error: "not_found" });
        return;
      }
      let fileStat;
      try {
        fileStat = await stat(asset.filePath);
      } catch {
        json(res, 404, { error: "not_found" });
        return;
      }
      if (fileStat.size > config.assets.maxFileBytes) {
        requestError(res, 413, "asset_too_large");
        return;
      }
      let manifest = await readJsonFile(runtime.assetsManifestPath(), null);
      if (!manifest?.files) {
        manifest = await runtime.listDeviceAssets(device, req);
      }
      const manifestPath = `${config.assets.audioPrefix}/${asset.relativeUrlPath}`;
      const assetEntry = Array.isArray(manifest.files)
        ? manifest.files.find((item) => item.path === manifestPath)
        : null;
      const digest = assetEntry?.sha256 || "";
      res.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(fileStat.size),
        ...(digest ? { etag: `"sha256:${digest}"`, "x-content-sha256": digest } : {}),
        "cache-control": "private, max-age=3600"
      });
      createReadStream(asset.filePath).pipe(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cardputer/firmware/manifest") {
      try {
        const manifest = await runtime.readFirmwareManifest(device, req);
        if (!manifest) {
          json(res, 404, { error: "not_found" });
          return;
        }
        console.info(
          `[firmware] manifest device=${device.device_id} version=${manifest.version || "-"} ` +
          `file=${manifest.filename || "-"} size=${manifest.size || 0}`
        );
        json(res, 200, manifest);
      } catch (error) {
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    const firmwareFileMatch = url.pathname.match(/^\/api\/cardputer\/firmware\/file\/(.+)$/);
    if (req.method === "GET" && firmwareFileMatch) {
      const firmware = runtime.resolveFirmwareDownload(device, decodeURIComponent(firmwareFileMatch[1]));
      if (!firmware) {
        json(res, 404, { error: "not_found" });
        return;
      }
      let fileStat;
      try {
        fileStat = await stat(firmware.filePath);
      } catch {
        json(res, 404, { error: "not_found" });
        return;
      }
      if (fileStat.size > config.firmware.maxFileBytes) {
        requestError(res, 413, "firmware_too_large");
        return;
      }
      let digest = "";
      try {
        const manifest = await runtime.readFirmwareManifest(device, req);
        if (manifest?.filename === firmware.filename) {
          digest = manifest.sha256 || "";
        }
      } catch {}
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(fileStat.size),
        ...(digest ? { etag: `"sha256:${digest}"`, "x-content-sha256": digest } : {}),
        "cache-control": "private, max-age=3600"
      });
      console.info(
        `[firmware] download device=${device.device_id} file=${firmware.filename} ` +
        `bytes=${fileStat.size} sha=${digest || "-"}`
      );
      createReadStream(firmware.filePath).pipe(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cardputer/logs") {
      const payload = await readJsonBody(req, config.security.maxLogBytes);
      if (!payload || typeof payload !== "object") {
        requestError(res, 400, "invalid_json");
        return;
      }
      await runtime.appendDeviceLogs(device, payload);
      res.writeHead(204);
      res.end();
      return;
    }

	    if (req.method === "GET" && url.pathname === "/api/cardputer/v1/topics") {
      const recentDays = Math.max(1, Math.min(30, Number(url.searchParams.get("recent_days") || 7)));
      const limit = Math.max(3, Math.min(80, Number(url.searchParams.get("limit") || 32)));
      const sinceMs = Date.now() - recentDays * 24 * 60 * 60 * 1000;
      await runtime.syncRecentTelegramSessionsForDevice(device, {
        activeMinutes: recentDays * 24 * 60,
        limit: Math.max(limit, 48)
      });
	      json(res, 200, {
	        type: "topics_page",
        recent_days: recentDays,
	        items: runtime.listTopicsForDevice(device.device_id, {
          sinceMs,
          minRecent: 3,
          limit,
          sortByActivity: true
        })
	      });
	      return;
	    }

    if (req.method === "POST" && url.pathname === "/api/cardputer/v1/topics/create") {
      const payload = await readJsonBody(req, config.security.maxJsonBytes);
      if (!payload || typeof payload !== "object") {
        requestError(res, 400, "invalid_json");
        return;
      }
      try {
        const topic = await runtime.createDeviceTopic(device, payload.title || payload.name || "");
        json(res, 200, {
          type: "topic_created",
          topic_key: topic.topic_key,
          topic
        });
      } catch (error) {
        requestError(res, 503, String(error.message || error));
      }
      return;
    }

    const topicSelectMatch = url.pathname.match(/^\/api\/cardputer\/v1\/topics\/(.+)\/select$/);
    if (req.method === "POST" && topicSelectMatch) {
      const topicKey = decodeURIComponent(topicSelectMatch[1]);
	      if (!runtime.isVisibleTopicForDevice(device, topicKey)) {
	        json(res, 404, { error: "not_found" });
	        return;
	      }
      const ok = runtime.store.setCurrentTopicKey(device.device_id, topicKey);
      if (!ok) {
        requestError(res, 409, "topic_not_selectable");
        return;
      }
      await runtime.store.save();
      json(res, 200, {
        type: "topic_selected",
        topic_key: topicKey,
        current: true
      });
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/cardputer\/v1\/topics\/(.+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      const topicKey = decodeURIComponent(historyMatch[1]);
      if (!runtime.isVisibleTopicForDevice(device, topicKey)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const beforeSeq = Number(url.searchParams.get("before_seq") || 0);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 40)));
      const compactParam = url.searchParams.get("compact");
      const compact =
        compactParam === null
          ? true
          : compactParam !== "0" && compactParam !== "false" && compactParam !== "full";
      const requestedTextChars = Number(url.searchParams.get("text_chars") || 0);
      const maxTextChars = Number.isFinite(requestedTextChars)
        ? Math.max(0, Math.min(8192, requestedTextChars))
        : 0;
      const history = runtime.store.getHistory(topicKey, beforeSeq, limit);
      const items = compact
        ? history.items.map((item) => compactHistoryItem(item, maxTextChars)).filter(compactHistoryItemVisible)
        : history.items;
      const topic = runtime.store.getTopic(topicKey);
      json(res, 200, {
        ...history,
        items,
        topic: topic
          ? {
              topic_key: topic.topic_key,
              session_key: topic.session_key,
              title: topic.title,
              display_title: topicDisplayTitle(topic),
              short_title: topic.short_title || topicDisplayTitle(topic).slice(0, 12),
              emoji: topic.emoji || topic.icon || null,
              thread_id: topic.thread_id || null,
              head_seq: topic.head_seq || 0
            }
          : null
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cardputer/device-events/pending") {
      runtime.recordDeviceFirmware(device,url.searchParams);
      const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") || 5)));
      const requestedTopicKey = String(url.searchParams.get("topic_key") || "").trim();
      const primaryTopicKey = runtime.primaryCardputerTopicForDevice(device)?.topic_key || "";
      const topicKey = requestedTopicKey || primaryTopicKey;
      const senderKind = String(url.searchParams.get("sender_kind") || url.searchParams.get("sender") || "").trim();
      const requestedTextChars = Number(url.searchParams.get("text_chars") || 2048);
      const maxTextChars = Number.isFinite(requestedTextChars)
        ? Math.max(0, Math.min(8192, requestedTextChars))
        : 2048;
      if (topicKey && !runtime.isVisibleTopicForDevice(device, topicKey)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const items = runtime.store.listPendingDeviceEvents(device.device_id, {
        limit,
        topicKey,
        senderKind
      }).map((event) => ({
        ...event,
        message: trimDeviceEventMessage(event.message, maxTextChars)
      }));
      json(res, 200, {
        type: "device_events_pending",
        device_id: device.device_id,
        items
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cardputer/device-events/ack") {
      const payload = await readJsonBody(req, config.security.maxJsonBytes);
      const eventId = String(payload?.event_id || "").trim();
      if (!eventId) {
        requestError(res, 400, "event_id required");
        return;
      }
      const ok = runtime.store.ackDeviceEvent(device.device_id, eventId);
      if (ok) {
        await runtime.store.save();
      }
      json(res, 200, {
        type: "device_event_ack",
        event_id: eventId,
        acked: ok
      });
      return;
    }

    const inboxLatestMatch = url.pathname.match(/^\/api\/cardputer\/v1\/topics\/(.+)\/inbox\/latest$/);
    if (req.method === "GET" && inboxLatestMatch) {
      const topicKey = decodeURIComponent(inboxLatestMatch[1]);
      if (!runtime.isVisibleTopicForDevice(device, topicKey)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const afterSeq = Math.max(0, Number(url.searchParams.get("after_seq") || 0));
      const senderKind = String(url.searchParams.get("sender_kind") || url.searchParams.get("sender") || "").trim();
      const requestedTextChars = Number(url.searchParams.get("text_chars") || 2048);
      const maxTextChars = Number.isFinite(requestedTextChars)
        ? Math.max(0, Math.min(8192, requestedTextChars))
        : 2048;
      const history = runtime.store.getHistory(topicKey, 0, 100000).items;
      const latest = [...history]
        .reverse()
        .find((item) =>
          item?.sender?.kind !== "device" &&
          (!senderKind || item?.sender?.kind === senderKind) &&
          (!afterSeq || Number(item?.seq || 0) > afterSeq)
        );
      const topic = runtime.store.getTopic(topicKey);
      json(res, 200, {
        type: "inbox_latest",
        topic_key: topicKey,
        head_seq: topic?.head_seq || 0,
        item: latest ? compactHistoryItem(latest, maxTextChars) : null
      });
      return;
    }

    const messageMatch = url.pathname.match(/^\/api\/cardputer\/v1\/topics\/(.+)\/messages$/);
    if (req.method === "POST" && messageMatch) {
      const topicKey = decodeURIComponent(messageMatch[1]);
      if (!runtime.isVisibleTopicForDevice(device, topicKey)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, config.security.maxJsonBytes);
      } catch {
        requestError(res, 413, "request_too_large");
        return;
      }
      if (!payload || typeof payload !== "object") {
        requestError(res, 400, "invalid_json");
        return;
      }
      if (!payload.client_msg_id || !payload.text) {
        requestError(res, 400, "client_msg_id and text are required");
        return;
      }
      const ack = await runtime.sendText({
        device,
        topicKey,
        clientMsgId: payload.client_msg_id,
        text: payload.text
      });
      json(res, 200, ack);
      return;
    }

    const inboxInjectMatch = url.pathname.match(/^\/api\/cardputer\/v1\/topics\/(.+)\/inbox\/inject$/);
    if (req.method === "POST" && inboxInjectMatch) {
      if (config.security?.inboxInjectEnabled !== true) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const topicKey = decodeURIComponent(inboxInjectMatch[1]);
      if (!runtime.isVisibleTopicForDevice(device, topicKey)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      let payload;
      try {
        payload = await readJsonBody(req, config.security.maxJsonBytes);
      } catch {
        requestError(res, 413, "request_too_large");
        return;
      }
      if (!payload || typeof payload !== "object") {
        requestError(res, 400, "invalid_json");
        return;
      }
      try {
        const message = await runtime.appendInjectedInboxMessage({
          topicKey,
          text: payload.text || payload.message || "",
          senderKind: payload.sender_kind || payload.sender || "human",
          senderName: payload.sender_name || payload.display_name || "Serial smoke",
          source: payload.source || "cardputer_inbox_inject"
        });
        json(res, 200, {
          type: "inbox_injected",
          topic_key: topicKey,
          message_id: message.id,
          seq: message.seq,
          message
        });
      } catch (error) {
        requestError(res, 400, String(error.message || error));
      }
      return;
    }

    const voiceMatch = url.pathname.match(/^\/api\/cardputer\/v1\/topics\/(.+)\/voice$/);
    if (req.method === "POST" && voiceMatch) {
      const topicKey = decodeURIComponent(voiceMatch[1]);
      if (!device.topics.includes(topicKey)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      const uploadPath = path.join(config.media.tmpDir, `${makeId("upload")}.wav`);
      try {
      const upload = await readMultipartUpload(req, config, { toFilePath: uploadPath })
        .catch((error) => ({ error }));
      if (upload?.error) {
        requestError(
          res,
          isRequestTooLarge(upload.error) ? 413 : 400,
          String(upload.error.message || upload.error)
        );
        return;
      }
      if (!upload.fields.client_msg_id) {
        requestError(res, 400, "client_msg_id is required");
        return;
      }
      if (upload.bytes > config.maxUploadBytes) {
        requestError(res, 413, "upload_too_large");
        return;
      }
      const durationMs = Number(upload.fields.duration_ms || 0);
      if (durationMs > config.maxVoiceDurationMs) {
        requestError(res, 400, "duration_too_large");
        return;
      }
      const ack = await runtime.sendVoice({
        device,
        topicKey,
        clientMsgId: upload.fields.client_msg_id,
        durationMs,
        uploadPath: upload.uploadPath,
        originalFileName: upload.originalFileName,
        mimeType: upload.mimeType,
        bytes: upload.bytes
      });
      json(res, 200, ack);
      } finally {
        await rm(uploadPath, { force:true });
      }
      return;
    }

    const mediaMatch = url.pathname.match(/^\/api\/cardputer\/v1\/media\/([^/]+)$/);
    if (req.method === "GET" && mediaMatch) {
      const media = runtime.store.getMedia(mediaMatch[1]);
      if (!media || !device.topics.includes(media.topic_key)) {
        json(res, 404, { error: "not_found" });
        return;
      }
      let fileStat;
      try {
        fileStat = await stat(media.playback_path);
      } catch {
        json(res, 404, { error: "not_found" });
        return;
      }
      res.writeHead(200, {
        "content-type": media.playback_mime,
        "content-length": String(fileStat.size),
        "cache-control": "private, max-age=3600"
      });
      createReadStream(media.playback_path).pipe(res);
      return;
    }

      json(res, 404, { error: "not_found" });
    })().catch((error) => {
      const message = String(error?.message || error || "internal_error");
      if (error?.code === "ECONNRESET" || message.toLowerCase().includes("aborted")) {
        return;
      }
      if (isRequestTooLarge(error)) {
        requestError(res, 413, message);
        return;
      }
      console.error("bridge request failed", error);
      if (!res.headersSent) {
        requestError(res, 500, "internal_error");
        return;
      }
      try {
        res.end();
      } catch {}
    }).finally(() => releaseRequest());
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Number(config.security.maxWsPayloadBytes) || 64 * 1024
  });
  const realtimeWss = new WebSocketServer({
    noServer: true,
    maxPayload: Number(config.security.maxWsPayloadBytes) || 64 * 1024
  });
  wss.on("connection", (ws, req) => {
    runtime.clients.add(ws);
    let connected = false;
    const authTimer = setTimeout(() => {
      if (connected || ws.readyState !== 1) {
        return;
      }
      ws.send(JSON.stringify(authErrorPayload("connect frame timeout")));
      ws.close();
    }, Number(config.security.wsAuthTimeoutMs) || 5000);
    ws.on("message", (raw) => {
      if (connected) { ws.close(1008,"connect already completed"); return; }
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        ws.send(JSON.stringify({ type: "protocol_error", message: "invalid json" }));
        return;
      }
      if (!isRecord(payload) || payload.type !== "connect") {
        ws.send(JSON.stringify({ type: "protocol_error", message: "connect required" }));
        return;
      }
      const device = runtime.validateDevice(payload.device_id, payload.device_token, payload.topic_key);
      if (!device) {
        recordAuthFailure(req, config);
        ws.send(JSON.stringify(authErrorPayload("bad connect payload")));
        ws.close();
        return;
      }
      clearAuthFailures(req, config);
      connected = true;
      clearTimeout(authTimer);
      ws.topicKey = payload.topic_key;
      const headSeq = runtime.store.getTopic(payload.topic_key)?.head_seq || 0;
      ws.send(
        JSON.stringify({
          type: "connected",
          topic_key: payload.topic_key,
          head_seq: headSeq,
          protocol: "cardputer-feed.v1"
        })
      );
      const fromSeq = Number(payload.from_seq || 1);
      const history = runtime.store.getHistory(payload.topic_key, 0, 100000).items;
      if (fromSeq > 0) {
        if (fromSeq > headSeq + 1) {
          ws.send(
            JSON.stringify({
              type: "reconnect_required",
              reason: config.reconnectRequiredCode,
              expected_from_seq: headSeq + 1
            })
          );
          return;
        }
        const replay = history.filter((item) => item.seq >= fromSeq);
        const expectedOldest = replay[0]?.seq;
        if (history.length > 0 && fromSeq < history[0].seq) {
          ws.send(
            JSON.stringify({
              type: "reconnect_required",
              reason: config.reconnectRequiredCode,
              expected_from_seq: history[0].seq
            })
          );
          return;
        }
        if (expectedOldest && expectedOldest > fromSeq) {
          ws.send(
            JSON.stringify({
              type: "reconnect_required",
              reason: config.reconnectRequiredCode,
              expected_from_seq: expectedOldest
            })
          );
          return;
        }
        for (const item of replay) {
          ws.send(
            JSON.stringify({
              type: "new_message",
              topic_key: payload.topic_key,
              session_key: runtime.store.getTopic(payload.topic_key)?.session_key,
              message: item
            })
          );
        }
      }
    });
    ws.on("error", () => {
      clearTimeout(authTimer);
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      runtime.clients.delete(ws);
    });
  });

  realtimeWss.on("connection", (ws, req) => {
    const authAttempt = ws.realtimeAuthAttempt || makeId("rtauth");
    const authStartedAt = Date.now();
    let connected = false;
    let releaseAdmission = () => false;
    let preAuthSocketBytes = 0;
    const onPreAuthSocketData = (chunk) => {
      if (connected) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk || "");
      preAuthSocketBytes += bytes;
      console.info(
        `[realtime-auth] socket_data attempt=${authAttempt} bytes=${bytes} total=${preAuthSocketBytes}`
      );
    };
    ws._socket?.prependListener("data", onPreAuthSocketData);
    console.info(
      `[realtime-auth] upgrade attempt=${authAttempt} head_bytes=${Number(ws.realtimeUpgradeHeadBytes || 0)}`
    );
    const rejectConnect = (reason, payload, details = "") => {
      recordAuthFailure(req, config);
      console.warn(
        `[realtime-auth] reject attempt=${authAttempt} reason=${reason}${details ? ` ${details}` : ""}`
      );
      safeWsSendThenClose(ws, payload, 1008, "connect rejected");
    };
    if (config.realtimeVoice?.enabled === false) {
      rejectConnect("realtime_disabled", { type: "realtime.error", message: "realtime disabled" });
      return;
    }
    const authTimer = setTimeout(() => {
      if (connected || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      rejectConnect("connect_timeout", authErrorPayload("connect frame timeout"));
    }, Number(config.security.wsAuthTimeoutMs) || 5000);
    ws.once("message", (raw, isBinary) => {
      const frameBytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw || "");
      const frameTransport = isBinary ? "binary" : "text";
      console.info(
        `[realtime-auth] frame attempt=${authAttempt} transport=${frameTransport} bytes=${frameBytes}`
      );
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        rejectConnect(
          isBinary ? "binary_not_json" : "invalid_json",
          { type: "protocol_error", message: "invalid json" },
          `transport=${frameTransport} bytes=${frameBytes}`
        );
        return;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.type !== "connect") {
        rejectConnect(
          "connect_required",
          { type: "protocol_error", message: "connect required" },
          `transport=${frameTransport} bytes=${frameBytes}`
        );
        return;
      }
      const deviceId = typeof payload.device_id === "string" ? payload.device_id : "";
      const deviceToken = typeof payload.device_token === "string" ? payload.device_token : "";
      const topicKey = typeof payload.topic_key === "string" ? payload.topic_key : "";
      const firmwareVersion = String(payload.firmware_version || "unknown")
        .replace(/[^A-Za-z0-9._+-]/gu, "_")
        .slice(0, 48);
      const firmwareGit = String(payload.firmware_git || "")
        .replace(/[^A-Fa-f0-9]/gu, "")
        .slice(0, 12);
      const tokenDevice = runtime.store.findDeviceByToken(deviceToken);
      const authDetails =
        `transport=${frameTransport} bytes=${frameBytes} ` +
        `device_len=${deviceId.length} token_len=${deviceToken.length} topic_len=${topicKey.length}`;
      if (!tokenDevice) {
        rejectConnect("unknown_or_revoked_token", authErrorPayload("bad connect payload"), authDetails);
        return;
      }
      if (tokenDevice.device_id !== deviceId) {
        rejectConnect("device_id_mismatch", authErrorPayload("bad connect payload"), authDetails);
        return;
      }
      if (!Array.isArray(tokenDevice.topics) || !tokenDevice.topics.includes(topicKey)) {
        rejectConnect("topic_not_allowed", authErrorPayload("bad connect payload"), authDetails);
        return;
      }
      const device = tokenDevice;
      const topic = runtime.store.getTopic(topicKey);
      if (!topic) {
        rejectConnect(
          "topic_unavailable",
          { type: "realtime.error", message: "topic unavailable" },
          authDetails
        );
        return;
      }
      const admission = realtimeAdmission.acquire(device.device_id);
      if (!admission.ok) {
        console.warn(
          `[realtime-auth] resource_reject attempt=${authAttempt} reason=${admission.reason} ` +
          `device=${device.device_id} retry_after_ms=${admission.retryAfterMs}`
        );
        safeWsSendThenClose(
          ws,
          {
            type: "realtime.error",
            code: admission.reason,
            message: "realtime temporarily unavailable",
            retryable: true,
            retry_after_ms: admission.retryAfterMs
          },
          1013,
          "realtime capacity"
        );
        return;
      }
      releaseAdmission = admission.release;
      clearAuthFailures(req, config);
      connected = true;
      clearTimeout(authTimer);
      ws._socket?.removeListener("data", onPreAuthSocketData);
      const binaryAudio = payload.binary_audio === true &&
        config.realtimeVoice?.binaryAudioEnabled !== false;
      console.info(
        `[realtime-auth] accepted attempt=${authAttempt} transport=${frameTransport} ` +
        `binary_audio=${binaryAudio ? 1 : 0} bytes=${frameBytes} ` +
        `firmware=${firmwareVersion}${firmwareGit ? ` git=${firmwareGit}` : ""}`
      );
      safeWsSend(ws, {
        type: "connected",
        topic_key: topic.topic_key,
        protocol: "cardputer-realtime.v1",
        audio_transport: binaryAudio ? "binary-v1" : "json-base64-v1"
      });
      void wireRealtimeBridge({
        clientWs: ws,
        runtime,
        device,
        topic,
        config,
        binaryAudio,
        firmwareVersion
      })
        .catch((error) => {
          console.warn(
            `[realtime] bridge_setup_failed device=${device.device_id} ` +
            `err=${String(error.message || error).slice(0, 240)}`
          );
          safeWsSendThenClose(
            ws,
            { type: "realtime.error", message: String(error.message || error).slice(0, 240) },
            1011,
            "realtime setup failed"
          );
        });
    });
    ws.on("error", (error) => {
      clearTimeout(authTimer);
      if (!connected) {
        console.warn(
          `[realtime-auth] ws_error attempt=${authAttempt} ${wsErrorForLog(error)} ` +
          `socket_bytes=${preAuthSocketBytes} elapsed_ms=${Date.now() - authStartedAt}`
        );
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(authTimer);
      ws._socket?.removeListener("data", onPreAuthSocketData);
      releaseAdmission();
      if (!connected) {
        const reasonBytes = Buffer.isBuffer(reason) ? reason.length : Buffer.byteLength(reason || "");
        console.warn(
          `[realtime-auth] ws_close attempt=${authAttempt} code=${Number(code || 0)} ` +
          `reason_bytes=${reasonBytes} socket_bytes=${preAuthSocketBytes} ` +
          `elapsed_ms=${Date.now() - authStartedAt}`
        );
      }
    });
  });

  const wsConnections = new Map();
  let wsConnectionCount = 0;
  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = parseRequestUrl(req); } catch { socket.destroy(); return; }
    if (!websocketOriginAllowed(req, config)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (isAuthRateLimited(req, config)) { rejectRateLimitedUpgrade(socket); return; }
    const ip = requestClientIp(req, config);
    const perIp = wsConnections.get(ip) || 0;
    if (perIp >= (Number(config.security.maxWsConnectionsPerIp) || 32) ||
        wsConnectionCount >= (Number(config.security.maxWsConnectionsGlobal) || 128)) {
      rejectRateLimitedUpgrade(socket);
      return;
    }
    wsConnections.set(ip, perIp + 1);
    wsConnectionCount += 1;
    socket.once("close", () => {
      const count = (wsConnections.get(ip) || 1) - 1;
      if (count) wsConnections.set(ip, count); else wsConnections.delete(ip);
      wsConnectionCount -= 1;
    });
    if (runtime.compatBridge?.handleUpgrade(req, socket, head)) {
      return;
    }
    if ((url.pathname === "/api/cardputer/v1/realtime" ||
         url.pathname === "/api/cardputer/v1/stream") && isAuthRateLimited(req, config)) {
      rejectRateLimitedUpgrade(socket);
      return;
    }
    if (url.pathname === "/api/cardputer/v1/realtime") {
      const authAttempt = makeId("rtauth");
      console.info(`[realtime-auth] upgrade_request attempt=${authAttempt} head_bytes=${head.length}`);
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        ws.realtimeAuthAttempt = authAttempt;
        ws.realtimeUpgradeHeadBytes = head.length;
        realtimeWss.emit("connection", ws, req);
      });
      return;
    }
    if (url.pathname !== "/api/cardputer/v1/stream") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(config.server.port, config.server.host, () => {
    console.log(
      JSON.stringify(
        {
          host: config.server.host,
          port: config.server.port,
          stateDir: config.stateDir,
          upstream: config.upstream.url
        },
        null,
        2
      )
    );
  });
}

export { BridgeRuntime, wireRealtimeBridge, openRealtimeModelSocket, buildDeviceTurnEnvelope, loadConfig, transcode };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
