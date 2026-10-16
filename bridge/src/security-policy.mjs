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
