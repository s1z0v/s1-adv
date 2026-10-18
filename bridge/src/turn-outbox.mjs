// A Gateway may give queued follow-ups a different, unreported agent run ID.
// Keep only one bridge dispatch per exact session, with durable ownership.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export class DurableTurnOutbox {
  constructor({ store, dispatch, wait, valid, changed = () => {}, terminal = async () => {}, pollMs = 1000 }) {
    Object.assign(this, { store, dispatch, wait, valid, changed, terminal, pollMs });
    this.launches = new Map();
    this.monitors = new Set();
    this.sleepers = new Set();
    this.closed = false;
    this.deliveryHold = null;
  }

  entries() {
    const state = this.store.state;
    state.turn_outbox ||= { version: 1, entries: [] };
    if (state.turn_outbox.version !== 1 || !Array.isArray(state.turn_outbox.entries) ||
        state.turn_outbox.entries.some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string')) {
      throw new Error('unsupported turn outbox state; delivery held');
    }
    return state.turn_outbox.entries;
  }

  assertCapacity(sessionKey, params) {
    if (this.deliveryHold) throw new Error(this.deliveryHold.message);
    const pending = this.entries().filter(e => e.phase !== 'terminal');
    const bytes = Buffer.byteLength(JSON.stringify(params));
    if (pending.length >= 32 || pending.filter(e => e.session_key === sessionKey).length >= 8 ||
        bytes > 65536 || pending.reduce((n,e) => n + Number(e.payload_bytes || 0), 0) + bytes > 1048576) {
      throw new Error('turn queue is full; wait for the existing delivery before retrying');
    }
  }

  async enqueue(entry) {
    const existing = this.entries().find(item => item.id === entry.id);
    if (existing) {
      if (existing.device_id !== entry.device_id || existing.topic_key !== entry.topic_key ||
          existing.session_key !== entry.session_key || existing.client_msg_id !== entry.client_msg_id)
        throw new Error('turn identity conflicts with its persisted owner; delivery held');
      return { record: existing, dispatched: this.launches.get(existing.id) || null };
    }
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
    this.deliveryHold = null;
    let entries;
    try { entries = this.entries(); }
    catch {
      this.deliveryHold = { code: 'unsupported_outbox_state', message: 'Delivery held: unsupported outbox state requires operator reconciliation.' };
      return;
    }
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
      legacy.push({ id, run_id: ack.upstream_run_id, topic_key: ack.topic_key, receipt: { ...ack },
        session_key: topic?.session_key, device_id: deviceId, client_msg_id: ack.client_msg_id,
        phase: 'recovering', legacy_receipt: true, upstream_accepted: ack.upstream_accepted === true, payload_bytes: 0 });
    }
    const unresolved = [...entries.filter(e => e.phase !== 'terminal' && e.phase !== 'queued'), ...legacy];
    try { await this.applyAuditedCutover(unresolved); }
    catch {
      this.deliveryHold = { code: 'invalid_cutover_audit', message: 'Delivery held: the private turn-outbox-cutover.json audit is invalid or incomplete.' };
      return;
    }
    const activeLegacy = legacy.filter(e => e.phase !== 'terminal');
    if (entries.filter(e => e.phase !== 'terminal').length + activeLegacy.length > 32) {
      this.deliveryHold = { code: 'legacy_receipts_require_audit', legacy_receipts: activeLegacy.length,
        message: 'Delivery held: legacy run receipts require an exact terminal audit or an isolated fresh-state cutover. See TURN-OUTBOX.md.' };
      return;
    }
    // Pre-existing accepted requests precede new durable queue entries.
    entries.unshift(...activeLegacy);
    // Dispatching/accepted/uncertain records are observed, never resent.
    for (const entry of this.entries()) {
      if (entry.phase !== 'queued' && entry.phase !== 'terminal') entry.phase = 'recovering';
    }
    await this.store.save();
    for (const entry of entries.filter(e => e.phase === 'terminal')) await this.terminal(entry);
    this.kick();
  }

  diagnostics() {
    const records = this.store.state.turn_outbox?.entries;
    const legacy = Array.isArray(records) ? records.filter(entry => entry?.legacy_receipt && entry.phase !== 'terminal').length : 0;
    const held = Array.isArray(records) && records.some(entry => entry?.phase === 'held' || entry?.observation_unavailable);
    const hold = this.deliveryHold || (legacy ? { code: 'legacy_receipts_require_audit', legacy_receipts: legacy,
      message: 'Legacy run ownership remains unresolved. Exact terminal proof or an audited isolated cutover is required; no old request is resent.' }
      : held ? { code: 'turn_delivery_held',
        message: 'A persisted turn is held or its terminal observation is temporarily unavailable; no uncertain request is resent.' } : null);
    return { delivery_ready: !hold, delivery_hold: hold };
  }

  async applyAuditedCutover(unresolved) {
    if (!this.store.filePath || unresolved.length === 0) return;
    const auditPath = path.join(path.dirname(this.store.filePath), 'turn-outbox-cutover.json');
    let file;
    try { file = await stat(auditPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!file.isFile() || file.size > 1024 * 1024 || (process.platform !== 'win32' &&
        ((file.mode & 0o077) || (process.getuid && file.uid !== process.getuid())))) throw new Error('private audit required');
    const audit = JSON.parse(await readFile(auditPath, 'utf8'));
    if (audit.version !== 1 || audit.quiescent !== true || typeof audit.audit_id !== 'string' ||
        !audit.audit_id.trim() || audit.audit_id.length > 200 || !Number.isFinite(Date.parse(audit.audited_at)) ||
        !Array.isArray(audit.receipts)) throw new Error('invalid audit');
    // A consumed marker is historical evidence, never authority over later runs.
    if (this.store.state.turn_outbox.applied_audit_id === audit.audit_id) return;
    const proofs = new Map(audit.receipts.map(proof => [proof.id, proof]));
    if (proofs.size !== audit.receipts.length || proofs.size !== unresolved.length) throw new Error('exact audit coverage required');
    for (const entry of unresolved) {
      const proof = proofs.get(entry.id);
      if (proof?.run_id !== entry.run_id || !/^(ok|error)$/.test(proof.status || '') ||
          !Number.isFinite(proof.ended_at) || proof.ended_at <= 0 || typeof proof.evidence !== 'string' ||
          !proof.evidence.trim() || proof.evidence.length > 4096) throw new Error('authoritative terminal evidence required');
    }
    for (const entry of unresolved) {
      const proof = proofs.get(entry.id);
      entry.phase = 'terminal';
      entry.terminal = { run_id: proof.run_id, status: proof.status, ended_at: proof.ended_at,
        operator_audit: { id: audit.audit_id, audited_at: audit.audited_at, evidence: proof.evidence } };
      delete entry.params; delete entry.hold_reason; entry.payload_bytes = 0;
      this.changed(entry);
    }
    this.store.state.turn_outbox.applied_audit_id = audit.audit_id;
  }

  kick() {
    if (this.closed || this.deliveryHold) return;
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

  async pause(delayMs = this.pollMs) {
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.sleepers.delete(finish); resolve(); };
      const timer = setTimeout(finish, delayMs); timer.unref();
      this.sleepers.add(finish);
    });
  }

  async monitor(entry) {
    let failures = 0;
    while (!this.closed) {
      let receipt;
      try {
        receipt = await this.wait(entry.run_id); failures = 0;
        if (entry.observation_unavailable) {
          delete entry.observation_unavailable; delete entry.hold_reason;
          entry.phase = entry.upstream_accepted ? 'inflight' : 'recovering';
          this.changed(entry); await this.store.save();
        }
      }
      catch (error) {
        if (this.closed) return;
        entry.phase = 'recovering';
        entry.observation_unavailable = true;
        entry.hold_reason = 'Terminal observation temporarily unavailable; no request is resent.';
        this.changed(entry);
        await this.store.save().catch(() => {});
        await this.pause(Math.min(30000, this.pollMs * 2 ** Math.min(failures++, 6)));
        continue;
      }
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
        await this.terminal(entry);
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
