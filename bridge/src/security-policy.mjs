import { timingSafeEqual } from "node:crypto";

function normalizedAddress(value = "") {
  const address = String(value || "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) {
    return address.slice("::ffff:".length);
  }
  return address;
}

export function isLoopbackAddress(value = "") {
  const address = normalizedAddress(value);
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.");
}

export function requestClientIp(req, config = {}) {
  const peer = normalizedAddress(req?.socket?.remoteAddress || "unknown").slice(0, 96);
  const trustedProxyAddresses = new Set(
    (config.security?.trustedProxyAddresses || [])
      .map((item) => normalizedAddress(item))
      .filter(Boolean)
  );
  const trustForwarded = isLoopbackAddress(peer) || trustedProxyAddresses.has(peer);
  if (!trustForwarded) {
    return peer;
  }
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((item) => normalizedAddress(item))
    .filter(Boolean);
  return (forwarded.at(-1) || peer).slice(0, 96);
}

function positiveInt(value, fallback, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.floor(parsed));
}

export class RealtimeAdmissionController {
  constructor(config = {}, now = () => Date.now()) {
    this.now = now;
    this.activeGlobal = 0;
    this.activeByDevice = new Map();
    this.startsByDevice = new Map();
    this.settings = {
      maxActivePerDevice: positiveInt(config.realtimeVoice?.maxActivePerDevice, 2),
      maxActiveGlobal: positiveInt(config.realtimeVoice?.maxActiveGlobal, 8),
      startLimitPerDevice: positiveInt(config.realtimeVoice?.startLimitPerDevice, 30, 5),
      startWindowMs: positiveInt(config.realtimeVoice?.startWindowMs, 60_000, 10_000)
    };
  }

  acquire(deviceId, now = this.now()) {
    const id = String(deviceId || "").trim();
    if (!id) {
      return { ok: false, reason: "invalid_device", retryAfterMs: 0 };
    }
    const currentDevice = this.activeByDevice.get(id) || 0;
    if (currentDevice >= this.settings.maxActivePerDevice) {
      return { ok: false, reason: "device_session_limit", retryAfterMs: 1000 };
    }
    if (this.activeGlobal >= this.settings.maxActiveGlobal) {
      return { ok: false, reason: "global_session_limit", retryAfterMs: 1000 };
    }

    const windowStart = now - this.settings.startWindowMs;
    const recentStarts = (this.startsByDevice.get(id) || []).filter((item) => item > windowStart);
    if (recentStarts.length >= this.settings.startLimitPerDevice) {
      const retryAfterMs = Math.max(1, recentStarts[0] + this.settings.startWindowMs - now);
      this.startsByDevice.set(id, recentStarts);
      return { ok: false, reason: "session_start_rate_limit", retryAfterMs };
    }

    recentStarts.push(now);
    this.startsByDevice.set(id, recentStarts);
    this.activeByDevice.set(id, currentDevice + 1);
    this.activeGlobal += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) {
          return false;
        }
        released = true;
        const active = this.activeByDevice.get(id) || 0;
        if (active <= 1) {
          this.activeByDevice.delete(id);
        } else {
          this.activeByDevice.set(id, active - 1);
        }
        this.activeGlobal = Math.max(0, this.activeGlobal - 1);
        return true;
      }
    };
  }

  snapshot() {
    return {
      activeGlobal: this.activeGlobal,
      activeByDevice: Object.fromEntries(this.activeByDevice),
      startsByDevice: Object.fromEntries(
        [...this.startsByDevice].map(([deviceId, starts]) => [deviceId, starts.length])
      )
    };
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRequestUrl(req) {
  const target = req.url || "/";
  if (!target.startsWith("/") || target.startsWith("//")) throw new Error("invalid_request_target");
  // Routing must not parse the untrusted Host header as a URL authority.
  return new URL(target, "http://bridge.invalid");
}

export function websocketOriginAllowed(req, config) {
  const origin = String(req.headers?.origin || "");
  const allowed = config.security?.allowedOrigins || [];
  return !origin || allowed.includes(origin) || allowed.includes("*");
}

export function hasInternalOtaAccess(req, config) {
  if (config.security?.internalOtaEnabled !== true || !isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (Object.keys(req.headers || {}).some(key => key === "forwarded" || key.startsWith("x-forwarded-"))) return false;
  const expected = Buffer.from(String(config.security?.internalOtaToken || ""));
  const supplied = Buffer.from(String(req.headers?.["x-admin-token"] || ""));
  return expected.length >= 32 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function validateDeviceTokens(config) {
  if (!Array.isArray(config.devices) || config.devices.length !== 1)
    throw new Error("This bridge supports exactly one device identity. Use separate private bridge instances for different devices; audio and OTA storage are not multi-tenant.");
  const seen = new Set();
  for (const device of config.devices || []) {
    const token = device.device_token;
    if (typeof token !== "string" || token.length < 32 || /replace|example|changeme/i.test(token)) {
      throw new Error("each device requires a unique random token of at least 32 characters");
    }
    if (token === config.upstream?.token || seen.has(token)) throw new Error("device tokens must be distinct from gateway and other device tokens");
    seen.add(token);
  }
}

export function agentIdForSession(sessionKey) {
  const match = String(sessionKey || "").match(/^agent:([A-Za-z0-9_-]+):/);
  if (!match) throw new Error("topic session_key must identify an explicit agent");
  return match[1];
}

export function validateUpstreamTransport(config) {
  const url = new URL(config.upstream?.url);
  if (url.username || url.password || !["ws:", "wss:"].includes(url.protocol) ||
      (url.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("remote OpenClaw gateways require WSS; WS is allowed only on loopback");
  }
}
