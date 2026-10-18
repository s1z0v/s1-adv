// A Gateway may give queued follow-ups a different, unreported agent run ID.
// Keep only one bridge dispatch per exact session, with durable ownership.
export class DurableTurnOutbox {
  constructor({ store, dispatch, wait, valid, changed = () => {}, pollMs = 1000 }) {
    Object.assign(this, { store, dispatch, wait, valid, changed, pollMs });
    this.launches = new Map();
    this.monitors = new Set();
    this.sleepers = new Set();
    this.closed = false;
  }

  entries() {
    const state = this.store.state;
    state.turn_outbox ||= { version: 1, entries: [] };
    if (state.turn_outbox.version !== 1 || !Array.isArray(state.turn_outbox.entries)) {
      throw new Error('unsupported turn outbox state; delivery held');
    }
    return state.turn_outbox.entries;
  }

  assertCapacity(sessionKey, params) {
    const pending = this.entries().filter(e => e.phase !== 'terminal');
    const bytes = Buffer.byteLength(JSON.stringify(params));
    if (pending.length >= 32 || pending.filter(e => e.session_key === sessionKey).length >= 8 ||
        bytes > 65536 || pending.reduce((n,e) => n + Number(e.payload_bytes || 0), 0) + bytes > 1048576) {
      throw new Error('turn queue is full; wait for the existing delivery before retrying');
    }
  }

  async enqueue(entry) {
    this.assertCapacity(entry.session_key, entry.params);
    const record = { ...entry, phase: 'queued', payload_bytes: Buffer.byteLength(JSON.stringify(entry.params)) };
    this.entries().push(record);
    this.changed(record);
    // Acceptance and the exact dispatch payload must reach disk before RPC.
    await this.store.save();
    this.kick();
    return { record, dispatched: this.launches.get(record.id) || null };
  }

  async resume() {
    const entries = this.entries();
    const known = new Set(entries.map(e => e.id));
    const legacy = [];
    for (const ack of Object.values(this.store.state.idempotency || {})) {
      if (!ack.upstream_run_id || ack.upstream_terminal) continue;
      const topic = this.store.getTopic(ack.topic_key);
      const message = this.store.getHistory(ack.topic_key, 0, 100000).items.find(m => m.id === ack.message_id);
      const deviceId = message?.sender?.id?.startsWith('cardputer:')
        ? message.sender.id.slice('cardputer:'.length) : null;
      const id = `cardputer:${deviceId}:${ack.topic_key}:${ack.client_msg_id}`;
      if (known.has(id)) continue;
      known.add(id);
      legacy.push({ id, run_id: ack.upstream_run_id, topic_key: ack.topic_key,
        session_key: topic?.session_key, device_id: deviceId, client_msg_id: ack.client_msg_id,
        phase: 'recovering', upstream_accepted: ack.upstream_accepted === true, payload_bytes: 0 });
    }
    if (entries.filter(e => e.phase !== 'terminal').length + legacy.length > 32) {
      throw new Error('legacy turn receipts require reconciliation before outbox migration');
    }
    // Pre-existing accepted requests precede new durable queue entries.
    entries.unshift(...legacy);
    // Dispatching/accepted/uncertain records are observed, never resent.
    for (const entry of this.entries()) {
      if (entry.phase !== 'queued' && entry.phase !== 'terminal') entry.phase = 'recovering';
    }
    await this.store.save();
    this.kick();
  }

  kick() {
    if (this.closed) return;
    const heads = new Map();
    for (const entry of this.entries()) {
      if (entry.phase !== 'terminal' && !heads.has(entry.session_key)) heads.set(entry.session_key, entry);
    }
    for (const entry of heads.values()) {
      if (!this.valid(entry)) {
        if (entry.phase !== 'held' || entry.hold_reason !== 'authorization or session changed') {
          entry.phase = 'held'; entry.hold_reason = 'authorization or session changed';
          this.changed(entry);
          void this.store.save().catch(() => {});
        }
        continue;
      }
      if (entry.phase === 'queued' && !this.launches.has(entry.id)) {
        const promise = this.launch(entry);
        this.launches.set(entry.id, promise);
        // Background/device-WS calls have no HTTP waiter to catch this error.
        void promise.catch(() => {}).finally(() => this.launches.delete(entry.id));
      } else if (entry.phase !== 'queued' && !this.launches.has(entry.id)) {
        this.observe(entry);
      }
    }
  }

  async launch(entry) {
    entry.phase = 'dispatching'; this.changed(entry);
    await this.store.save();
    if (this.closed) return;
    if (!this.valid(entry)) {
      entry.phase = 'held'; entry.hold_reason = 'authorization or session changed';
      this.changed(entry); await this.store.save();
      throw new Error(entry.hold_reason);
    }
    try {
      const sent = await this.dispatch(entry);
      if (typeof sent?.runId !== 'string' || !sent.runId || sent.runId.length > 1024) {
        throw new Error('Gateway did not return a valid run receipt');
      }
      entry.run_id = sent.runId;
      entry.upstream_accepted = true;
      entry.phase = 'inflight';
      this.changed(entry);
      await this.store.save();
    } catch (error) {
      entry.phase = 'uncertain';
      entry.hold_reason = String(error.message || error).slice(0, 240);
      this.changed(entry);
      await this.store.save();
      this.observe(entry);
      throw error;
    }
    this.observe(entry);
  }

  observe(entry) {
    if (this.closed || this.monitors.has(entry.id)) return;
    this.monitors.add(entry.id);
    void this.monitor(entry).catch(async error => {
      if (this.closed) return;
      entry.phase = 'held'; entry.hold_reason = String(error.message || error).slice(0, 240);
      this.changed(entry);
      await this.store.save();
    }).catch(() => {}).finally(() => this.monitors.delete(entry.id));
  }

  async pause() {
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.sleepers.delete(finish); resolve(); };
      const timer = setTimeout(finish, this.pollMs); timer.unref();
      this.sleepers.add(finish);
    });
  }

  async monitor(entry) {
    while (!this.closed) {
      const receipt = await this.wait(entry.run_id);
      if (this.closed) return;
      // A timeout, absent/wrong run ID, final text, or HTTP wait expiration
      // cannot release the lane. Require the Gateway's terminal run receipt.
      if (receipt?.runId === entry.run_id && /^(ok|error)$/u.test(receipt.status || '') &&
          Number.isFinite(receipt.endedAt) && receipt.endedAt > 0) {
        entry.phase = 'terminal';
        entry.terminal = { run_id: receipt.runId, status: receipt.status, ended_at: receipt.endedAt };
        delete entry.params; delete entry.hold_reason;
        entry.payload_bytes = 0;
        this.changed(entry);
        // Retain bounded audit receipts; request idempotency lives in StateStore.
        const completed = this.entries().filter(e => e.phase === 'terminal');
        if (completed.length > 64) {
          const remove = new Set(completed.slice(0, completed.length - 64));
          this.store.state.turn_outbox.entries = this.entries().filter(e => !remove.has(e));
        }
        await this.store.save();
        this.kick();
        return;
      }
      await this.pause();
    }
  }

  close() {
    this.closed = true;
    for (const finish of this.sleepers) finish();
  }
}
