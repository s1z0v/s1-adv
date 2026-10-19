# Contextual chat, voice replies and task status

Text and ordinary G0 push-to-talk use the same configured persistent OpenClaw
session. Hold G0, speak, then release it to send. A voice follow-up has the same
conversation context as a typed reply. Realtime retains its separate audio UI;
its existing S1 tool uses the configured conversation too.

The bridge does not classify firmware intent from words such as `build`,
`version`, or `firmware`, and does not create a fresh session for each request.
The agent decides whether to answer, run an existing device action, ask a
question, continue earlier work, or implement an authorized change.

The native plugin provides `cardputer_status` only inside the configured
Cardputer session. Each call includes the exact current `request_id` from the
bridge context. A continuation also includes `active_task.task_id`:

| Agent state | Device badge | Meaning |
| --- | --- | --- |
| `awaiting_input` | NEEDS INPUT | Requirements are missing. Include the question in the visible chat reply. |
| `working` | WORKING | An accepted non-build task is running. |
| `building`, kind `firmware` | BUILDING | Authorized firmware implementation/build work has started. |
| `completed`, kind `firmware` | NEW UPDATE when a newer candidate exists | A new source-linked OTA manifest is required. Device download/hash/power/rollback checks still apply. |
| `completed`, other kinds | READY or NEW MESSAGE | The task finished. |
| `failed` | BUILD ERROR or TASK ERROR | The agent reports an actual failure. |
| `cancelled` | READY | The owner declined an unanswered clarification. This closes that pending request and does not stop a running operation. |

Normal weather/version questions require no status call. They do not clear an
unrelated pending question. Reading a question or pressing Esc does not cancel
it. Enter opens the same chat; the footer shows `Hold G0: reply` while input is
needed. The next utterance is interpreted by the agent using session context,
not a list of accepted yes/no words. Delivery receipts, missing receipts and
connection failures remain separate from agent task state. A transport timeout
never automatically resends the request.

The tool only sets status. It grants no filesystem, build, publish, installation
or cancellation permissions. Its endpoint is loopback-only, rejects forwarded
requests, uses a purpose-derived server credential, and validates the exact
configured session, active owned turn and task identity. It is blocked by the
public proxy. Other agents/sessions do not receive the tool.

For standalone installations, an agent already authorized to read the operator's
private mode-0600 configuration can use the equivalent helper:

```bash
node /ABSOLUTE/BRIDGE/scripts/agent-status.mjs \
  --config /ABSOLUTE/PRIVATE/config.json \
  --session-key YOUR_CONFIGURED_SESSION \
  --request-id CURRENT_REQUEST_ID \
  --state awaiting_input --work-kind firmware \
  --question 'Which TV model?'
```

Use the same helper with `--task-id ORIGINAL_TASK_ID` for a continuation. Do not
grant an agent new file/exec rights just to run this helper. In plugin mode the
native tool needs no shell permission.

On firmware 0.2.177 and newer, Home **Ctrl+U** checks the current manifest and
installs an eligible newer candidate in one operation, including a candidate
not yet cached when the key was pressed. No newer candidate returns to Home;
a failed check reports an error. Routine background checks never install on
their own.
