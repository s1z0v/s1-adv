import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { sleep } from "./utils.mjs";

const PROTOCOL_VERSION = 4;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function loadOrCreateDeviceIdentity(filePath) {
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (
        parsed &&
        parsed.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return parsed;
      }
    }
  } catch {
    // regenerate
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const record = {
    version: 1,
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now()
  };
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function buildDeviceAuthPayloadV3({
  deviceId,
  clientId,
  clientMode,
  role,
  scopes,
  signedAtMs,
  token,
  nonce,
  platform,
  deviceFamily
}) {
  return [
    "v3",
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(","),
    String(signedAtMs),
    token ?? "",
    nonce,
    platform ?? "",
    deviceFamily ?? ""
  ].join("|");
}

export class UpstreamGatewayClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ws = null;
    this.pending = new Map();
    this.connected = false;
    this.connecting = null;
    this.reconnectDelayMs = 1000;
    this.shouldRun = true;
    this.subscribedKeys = new Set();
    this.connectChallenge = null;
    this.connectChallengeWaiter = null;
    this.deviceIdentity = loadOrCreateDeviceIdentity(this.config.deviceIdentityPath);
  }

  async start() {
    while (this.shouldRun) {
      try {
        await this.connect();
        return;
      } catch (error) {
        this.emit("warning", { type: "upstream_connect_failed", error });
        await sleep(this.reconnectDelayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
      }
    }
  }

  async stop() {
    this.shouldRun = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async connect() {
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return await this.connecting;
    }
    this.connectChallenge = null;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.url);
      this.ws = ws;
      let settled = false;
      const deadline = setTimeout(() => fail(new Error("upstream handshake timed out")),
        Math.max(100, Number(this.config.handshakeTimeoutMs) || 12000));
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        this.connected = false;
        this.connectChallenge = null;
        // Resolve a challenge waiter so its bounded timer can be released.
        if (this.connectChallengeWaiter) this.connectChallengeWaiter(null);
        this.connectChallengeWaiter = null;
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
        ws.terminate();
        reject(error);
      };
      ws.on("message", (raw) => this.handleFrame(raw.toString("utf8")));
      ws.on("error", (error) => {
        if (!settled) fail(error);
        else this.emit("warning", { type: "upstream_error", error });
      });
      ws.on("close", () => {
        if (!settled) {
          fail(new Error("upstream closed during handshake"));
        } else if (this.connected) {
          this.handleClose();
        }
      });
      ws.on("open", async () => {
        try {
          const challenge = await this.waitForConnectChallenge();
          if (settled) return;
          const signedAt = Date.now();
          const scopes = Array.isArray(this.config.scopes) ? this.config.scopes : [];
          const payload = buildDeviceAuthPayloadV3({
            deviceId: this.deviceIdentity.deviceId,
            clientId: this.config.clientId,
            clientMode: this.config.mode,
            role: "operator", scopes, signedAtMs: signedAt,
            token: this.config.token, nonce: challenge?.nonce ?? "",
            platform: this.config.platform,
            deviceFamily: this.config.deviceFamily ?? "bridge"
          });
          const signature = base64UrlEncode(
            sign(null, Buffer.from(payload, "utf8"), createPrivateKey(this.deviceIdentity.privateKeyPem))
          );
          const hello = await this.sendRequest("connect", {
            minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
            client: {
              id: this.config.clientId,
              displayName: this.config.clientDisplayName ?? this.config.clientId,
              version: this.config.clientVersion, platform: this.config.platform,
              mode: this.config.mode, deviceFamily: this.config.deviceFamily ?? "bridge",
              instanceId: this.config.instanceId ?? this.deviceIdentity.deviceId.slice(0, 12)
            },
            locale: this.config.locale ?? "en-US",
            userAgent: this.config.userAgent ?? `${this.config.clientId}/${this.config.clientVersion}`,
            role: "operator", scopes, caps: [], auth: { token: this.config.token },
            device: {
              id: this.deviceIdentity.deviceId,
              publicKey: base64UrlEncode(derivePublicKeyRaw(this.deviceIdentity.publicKeyPem)),
              signature, signedAt, nonce: challenge?.nonce ?? ""
            }
          });
          if (settled) return;
          if (hello?.type !== "hello-ok") throw new Error("unexpected upstream hello payload");
          this.connected = true;
          this.reconnectDelayMs = 1000;
          for (const key of this.subscribedKeys) {
            await this.rpc("sessions.messages.subscribe", { key });
          }
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve();
        } catch (error) {
          fail(error);
        }
      });
    });

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async ensureConnected() {
    if (!this.connected) {
      await this.connect();
    }
  }

  async rpc(method, params = {}) {
    await this.ensureConnected();
    return await this.sendRequest(method, params);
  }

  async sendRequest(method, params = {}) {
    const id = randomUUID();
    const frame = {
      type: "req",
      id,
      method,
      params
    };
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`upstream timeout for ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    this.ws.send(JSON.stringify(frame));
    return await response;
  }

  async subscribeSessionMessages(key) {
    this.subscribedKeys.add(key);
    await this.rpc("sessions.messages.subscribe", { key });
  }

  handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === "res" && frame.id && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      if (frame.ok) {
        entry.resolve(frame.payload);
      } else {
        entry.reject(new Error(frame.error?.message || `upstream ${frame.id} failed`));
      }
      return;
    }
    if (frame.type === "event") {
      if (frame.event === "connect.challenge") {
        this.connectChallenge = frame.payload || null;
        if (this.connectChallengeWaiter) {
          this.connectChallengeWaiter(this.connectChallenge);
          this.connectChallengeWaiter = null;
        }
        return;
      }
      this.emit("event", frame);
    }
  }

  async waitForConnectChallenge() {
    if (this.connectChallenge) {
      return this.connectChallenge;
    }
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.connectChallengeWaiter = null;
        resolve(null);
      }, this.config.connectChallengeTimeoutMs ?? 750);
      this.connectChallengeWaiter = (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      };
    });
  }

  handleClose() {
    this.connected = false;
    this.connectChallenge = null;
    this.connectChallengeWaiter = null;
    for (const [id, entry] of this.pending.entries()) {
      entry.reject(new Error(`upstream connection closed before response ${id}`));
    }
    this.pending.clear();
    if (!this.shouldRun) {
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
    void (async () => {
      await sleep(delay);
      try {
        await this.connect();
        this.emit("reconnected");
      } catch (error) {
        this.emit("warning", { type: "upstream_reconnect_failed", error });
        this.handleClose();
      }
    })();
  }
}
