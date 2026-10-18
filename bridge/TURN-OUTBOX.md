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

Host regressions cover terminal proof, the final-before-terminal gap, aliases,
different sessions, RPC uncertainty, restart/no duplicate dispatch, admission,
configuration changes, upgrade adoption and disk-before-RPC ordering. The HTTP
fixture rejects overlapping Gateway sends and verifies pending A, own B and an
idempotent retry of A. These are host/runtime checks. Qualification against the
installed Gateway and five physical Cardputer canaries remain separate gates.
External actors can still occupy a shared Gateway session; if that Gateway
remaps an accepted run without exposing its identity, delivery remains held.
