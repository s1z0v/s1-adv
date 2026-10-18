# Per-session turn delivery

The bridge stores accepted text and transcribed voice dispatches in `state.json`
before calling `sessions.send`. The exact Gateway session key owns the lane, so
two topic aliases cannot overlap in the same session. Different sessions remain
independent. A queued HTTP request can return a pending receipt while its answer
continues through Inbox.

The next dispatch requires `agent.wait` to return the same run ID, terminal
`ok` or `error`, and a numeric positive `endedAt`. Visible final text, timeout,
HTTP completion and elapsed time do not release the lane. A missing, unsupported
or uncertain terminal receipt holds the lane. The bridge never guesses a remapped
run from answer text or timestamps and never impersonates a UI client.

On restart, queued payloads resume. Records whose RPC may have started are only
observed and never resent. Known pre-outbox run receipts are adopted in the same
way. Existing deployments without run identity require a quiescent cutover audit;
this source change cannot establish the outcome of their earlier requests.
Revoked devices and changed session mappings hold their queued work.

Admission is bounded to 8 outstanding turns per session, 32 globally, 64 KiB per
payload and 1 MiB of queued payloads. Rejection happens before text receipt/history
creation; content is preserved in full or rejected. Completed queue receipts are
bounded to 64; request idempotency remains in the regular state store. Legacy WS
voice retains its media acceptance contract and joins this same lane after STT.
State saves run in order so an older write cannot replace a newer queue snapshot.

Outstanding outbox records pin their original ACKs and request messages during
compaction. A retained outbox ID independently identifies retries even when an
older receipt map was truncated. A retry reuses that original receipt; it does
not append another message or dispatch payload. Terminal-observation transport
errors retry `agent.wait` with bounded backoff, never `sessions.send`. A proved
terminal error produces one correlated failure in Inbox and a failed response,
instead of promising a reply that is still pending.

## Existing installation preflight

Authenticated `/healthz` adds `delivery_ready` and `delivery_hold`. A hold is an
object with `code` and `message`; legacy migration also reports
`legacy_receipts`. Public unauthenticated health remains `{ "ok": true }`.
If more than 32 old receipts require reconciliation, HTTP stays available but
new delivery is held. Unknown outbox state also holds delivery. Preserve the
state and read the diagnostic before replacing an existing service.
Smaller adopted legacy backlogs are also reported as not delivery-ready until
their exact terminal receipts are observed or audited. A timeout does not clear
this diagnostic; the old session's lane remains fenced without resending.

For old runs, a final answer or a quiet session does not prove the Gateway run
ended. Audit exact run IDs using authoritative Gateway terminal receipts. If
those receipts are still available, stop the bridge, ensure the old listener is
stopped and the affected sessions are quiescent, back up the private state, and
create `turn-outbox-cutover.json` next to `state.json`, owned by the bridge user
and mode 0600. The file must cover every unresolved non-queued outbox or legacy
receipt exactly once. Use its original deterministic ID and actual run ID:

```json
{
  "version": 1,
  "audit_id": "operator-terminal-audit-unique-id",
  "audited_at": "2026-10-19T00:00:00Z",
  "quiescent": true,
  "receipts": [
    {
      "id": "cardputer:DEVICE_ID:TOPIC_KEY:CLIENT_MSG_ID",
      "run_id": "EXACT_GATEWAY_RUN_ID",
      "status": "ok",
      "ended_at": 1792368000000,
      "evidence": "Private reference to the authoritative terminal receipt"
    }
  ]
}
```

Replace every example value with audited evidence. `status` must be `ok` or
`error` and `ended_at` the positive numeric Gateway timestamp. Quiescence alone
does not authorize completion. Missing, duplicate, mismatched or incomplete
proof holds delivery without annotating any receipts. Restart after review;
the bridge records the audit on those ACKs, preserves their history, and never
resends them. A consumed audit ID cannot complete later runs. Keep the marker
and original state backup private as operator evidence; do not reuse an audit ID.

If an old Gateway no longer retains exact terminal proof, do not invent it or
mark the run complete. Safe alternative: stop the old bridge and listener,
preserve/archive all old private state and directories intact, and start the
reviewed bridge with new private state/media/assets/firmware directories and a
**distinct dedicated Gateway session**. Record unknown old delivery as an
operator disposition requiring review, not as an upstream terminal receipt.
Do not retry the old actions automatically in the new session. Follow the
normal text/voice/firmware acceptance checks before enabling device traffic.

Host regressions cover terminal proof, the final-before-terminal gap, aliases,
different sessions, RPC uncertainty, restart/no duplicate dispatch, admission,
configuration changes, upgrade adoption and disk-before-RPC ordering. The HTTP
fixture rejects overlapping Gateway sends and verifies pending A, own B and an
idempotent retry of A. These are host/runtime checks. Qualification against the
installed Gateway and five physical Cardputer canaries remain separate gates.
External actors can still occupy a shared Gateway session; if that Gateway
remaps an accepted run without exposing its identity, delivery remains held.
