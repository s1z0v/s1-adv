// PCM16 mono credit measured against a monotonic clock. A 30/20 ms pacer can
// catch up after a scheduler pause, but must not run 1.5x ahead indefinitely:
// queued audio also delays WebSocket pong behind seconds of valid PCM.
export const REALTIME_MAX_AUDIO_LEAD_MS = 320;

export class RealtimePacingBudget {
  constructor(sampleRate, leadMs = REALTIME_MAX_AUDIO_LEAD_MS) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 ||
        !Number.isFinite(leadMs) || leadMs <= 0) throw new RangeError("invalid PCM pacing clock");
    this.bytesPerMs = sampleRate * 2 / 1000;
    this.capacity = Math.floor(this.bytesPerMs * leadMs / 2) * 2;
    this.credit = this.capacity;
    this.lastMs = null;
  }

  take(nowMs, queuedBytes, frameBytes) {
    if (!Number.isFinite(nowMs)) throw new RangeError("invalid PCM pacing time");
    if (this.lastMs !== null) {
      const elapsed = Math.max(0, nowMs - this.lastMs);
      this.credit = Math.min(this.capacity, this.credit + elapsed * this.bytesPerMs);
    }
    // Do not earn the same interval twice even if a test/injected clock rolls back.
    this.lastMs = Math.max(this.lastMs ?? nowMs, nowMs);
    const bytes = Math.floor(Math.max(0, Math.min(queuedBytes, frameBytes, this.credit)) / 2) * 2;
    this.credit -= bytes;
    return bytes;
  }
}
