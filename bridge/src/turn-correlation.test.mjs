import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeRuntime } from './server.mjs';

async function withRuntime(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cardputer-turn-correlation-'));
  const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  config.stateDir = dir;
  config.upstream.deviceIdentityPath = path.join(dir, "test-gateway-identity.json");
  config.devices = config.devices.slice(0, 1);
  config.telegram = { enabled: false };
  const runtime = new BridgeRuntime(config);
  await runtime.store.load();
  const requests = [];
  runtime.upstream.rpc = async (method, params) => {
    assert.equal(method, 'sessions.send'); requests.push(params);
    return { runId: params.idempotencyKey };
  };
  const device = config.devices[0];
  const topic = runtime.store.getTopic(device.default_topic_key || device.topics[0]);
  const send = id => runtime.sendText({ device, topicKey: topic.topic_key, clientMsgId: id, text: `Request ${id}`, waitForUpstream: true });
  let messageId = 0;
  const deliver = (ack, text, extra = {}) => {
    const runId = `cardputer:${device.device_id}:${topic.topic_key}:${ack.client_msg_id}`;
    return runtime.ingestUpstreamMessage(topic, {
      role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(), stopReason: 'stop',
      __openclaw: { runId, id: `test-message-${++messageId}` }, ...extra
    });
  };
  const wait = (ack, started = Date.now()) => runtime.waitForAssistantReply(topic.topic_key, ack.seq, 1000, 50, started, ack);
  try { await run({ runtime, config, requests, device, topic, send, deliver, wait }); }
  finally { await new Promise(resolve => setImmediate(resolve)); await rm(dir, { recursive: true, force: true }); }
}

test('overlapping turns in one session return their own actual gateway run reply', async () => withRuntime(async ({ send, deliver, wait }) => {
  const first = await send('first'); const second = await send('second');
  const waitingFirst = wait(first); const waitingSecond = wait(second);
  await deliver(first, 'First answer');
  await delay(80);
  await deliver(second, 'Second answer');
  assert.equal((await waitingFirst).content.text, 'First answer');
  assert.equal((await waitingSecond).content.text, 'Second answer');
}));

test('late reply after HTTP pending/timeout cannot be consumed by the next request', async () => withRuntime(async ({ send, deliver, wait }) => {
  const first = await send('late-first');
  assert.equal(await wait(first), null);
  const second = await send('after-timeout'); const waitingSecond = wait(second);
  await deliver(first, 'Late first answer');
  await delay(80); await deliver(second, 'Answer after timeout');
  assert.equal((await waitingSecond).content.text, 'Answer after timeout');
  // An idempotent retry owns its historical answer, even after a new HTTP start.
  const retry = await send('late-first');
  assert.equal(retry.seq, first.seq);
  assert.equal((await wait(retry, Date.now() + 60000)).content.text, 'Late first answer');
}));

test('unbound messages and tool commentary are never returned as a final turn reply', async () => withRuntime(async ({ send, deliver, wait }) => {
  const ack = await send('final-only'); const waiting = wait(ack);
  await deliver(ack, 'Unrelated unbound text', { __openclaw: { id: 'unbound' } });
  await deliver(ack, 'Working on tools', { stopReason: 'toolUse', content: [{ type: 'text', text: 'Working on tools' }, { type: 'toolCall', name: 'exec' }] });
  await delay(80); await deliver(ack, 'Actual final answer');
  assert.equal((await waiting).content.text, 'Actual final answer');
}));

test('persisted run ownership survives restart and an idempotent retry sends no duplicate', async () => withRuntime(async ({ runtime, config, requests, send, deliver, topic }) => {
  const ack = await send('restart'); const message = await deliver(ack, 'Persisted final answer');
  await runtime.store.save();
  const restarted = new BridgeRuntime(config); await restarted.store.load();
  restarted.upstream.rpc = async () => { throw Error('must not dispatch an idempotent retry'); };
  const retry = await restarted.sendText({ device: config.devices[0], topicKey: topic.topic_key, clientMsgId: 'restart', text: 'Request restart', waitForUpstream: true });
  const reply = await restarted.waitForAssistantReply(topic.topic_key, retry.seq, 1000, 50, Date.now() + 60000, retry);
  assert.equal(reply?.id, message.id); assert.equal(reply?.content.text, 'Persisted final answer');
  assert.equal(requests.length, 1);
}));

test('actual opaque gateway receipt run ID is persisted and matched', async () => withRuntime(async ({ runtime, send, deliver, wait }) => {
  runtime.upstream.rpc = async () => ({ runId: 'opaque-gateway-run' });
  const ack = await send('opaque');
  assert.equal(ack.upstream_run_id, 'opaque-gateway-run');
  const reply = await deliver(ack, 'Opaque run answer', { __openclaw: { id: 'opaque-message', runId: 'opaque-gateway-run' } });
  assert.equal(reply.source.upstream_run_id, 'opaque-gateway-run');
  assert.equal((await wait(ack)).id, reply.id);
}));

test('RPC timeout retains request ownership for a late reply and idempotent retry', async () => withRuntime(async ({ runtime, send, deliver, wait, topic }) => {
  let sends = 0;
  runtime.upstream.rpc = async () => { ++sends; throw Error('upstream timeout for sessions.send'); };
  await assert.rejects(send('rpc-timeout'), /upstream timeout/);
  const ack = runtime.store.getIdempotent(topic.topic_key, 'rpc-timeout');
  await deliver(ack, 'Actually executed after RPC timeout');
  const retry = await send('rpc-timeout');
  assert.equal((await wait(retry, Date.now() + 60000)).content.text, 'Actually executed after RPC timeout');
  assert.equal(sends, 1);
}));

test('gateway history message ID fallback deduplicates a restart replay', async () => withRuntime(async ({ runtime, send, topic }) => {
  const ack = await send('history-id');
  const raw = { role:'assistant',content:[{type:'text',text:'History answer'}],timestamp:Date.now(),stopReason:'stop',
    __openclaw:{runId:ack.upstream_run_id,id:'stable-history-message'} };
  const first = await runtime.ingestUpstreamMessage(topic, raw);
  assert.equal(first.source.upstream_message_id, 'stable-history-message');
  assert.equal(await runtime.ingestUpstreamMessage(topic, raw), null);
}));

test('an in-flight idempotent retry follows the eventual opaque gateway receipt', async () => withRuntime(async ({ runtime, send, deliver, wait }) => {
  let release; let sends = 0;
  const dispatched = new Promise(resolve => {
    runtime.upstream.rpc = () => new Promise(complete => {
      ++sends; release = complete; resolve();
    });
  });
  const sending = send('pending-opaque');
  await dispatched;
  const retry = await send('pending-opaque');
  assert.notEqual(retry.upstream_run_id, 'eventual-opaque-run');
  const waiting = wait(retry);
  release({ runId:'eventual-opaque-run' });
  const receipt = await sending;
  await deliver(receipt, 'The retry owns this answer', {
    __openclaw:{ id:'eventual-opaque-message',runId:'eventual-opaque-run' }
  });
  assert.equal((await waiting)?.content.text, 'The retry owns this answer');
  assert.equal(sends, 1);
}));

test('legacy Gateway final chat events return each overlapping turn without mirrored duplicates', async () => withRuntime(async ({ runtime, topic, send, wait }) => {
  const first = await send('legacy-first'); const second = await send('legacy-second');
  const waitingFirst = wait(first); const waitingSecond = wait(second);
  const final = (ack,text) => ({event:'chat',payload:{sessionKey:topic.session_key,
    runId:ack.upstream_run_id,state:'final',message:{role:'assistant',content:[{type:'text',text}],timestamp:Date.now()}}});
  const mirror = text => ({event:'session.message',payload:{sessionKey:topic.session_key,
    messageId:`mirror-${text}`,message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop',
      __openclaw:{mirrorOrigin:'codex-app-server',id:`mirror-${text}`}}}});
  await runtime.handleUpstreamEvent(mirror('Second legacy answer'));
  await runtime.handleUpstreamEvent(final(second,'Second legacy answer'));
  await runtime.handleUpstreamEvent(final(first,'First legacy answer'));
  await runtime.handleUpstreamEvent(mirror('First legacy answer'));
  await runtime.handleUpstreamEvent(final(second,'Second legacy answer'));
  assert.equal((await waitingFirst).content.text,'First legacy answer');
  assert.equal((await waitingSecond).content.text,'Second legacy answer');
  assert.equal(runtime.store.getHistory(topic.topic_key,0,100).items.filter(x=>x.sender.kind==='assistant').length,2);
}));

test('final chat adapter ignores deltas, unrelated sessions, aborted and conflicting runs', async () => withRuntime(async ({ runtime, topic, send, wait }) => {
  const ack = await send('strict-final');
  const base = {event:'chat',payload:{sessionKey:topic.session_key,runId:ack.upstream_run_id,
    state:'final',message:{role:'assistant',content:[{type:'text',text:'Correct final'}]}}};
  for (const payload of [
    {...base.payload,state:'delta'}, {...base.payload,sessionKey:'agent:other:private'},
    {...base.payload,stopReason:'aborted'}, {...base.payload,runId:undefined},
    {...base.payload,message:{...base.payload.message,__openclaw:{runId:'different-run'}}}
  ]) await runtime.handleUpstreamEvent({event:'chat',payload});
  assert.equal(runtime.store.getHistory(topic.topic_key,0,100).items.length,1);
  await runtime.handleUpstreamEvent(base);
  assert.equal((await wait(ack)).content.text,'Correct final');
}));

test('session-message and final-chat transports publish a completed run only once', async () => withRuntime(async ({ runtime, topic, send, deliver }) => {
  const ack = await send('dual-transport');
  await deliver(ack,'One final answer');
  await runtime.handleUpstreamEvent({event:'chat',payload:{sessionKey:topic.session_key,runId:ack.upstream_run_id,
    state:'final',message:{role:'assistant',content:[{type:'text',text:'One final answer'}]}}});
  assert.equal(runtime.store.getHistory(topic.topic_key,0,100).items.filter(x=>x.sender.kind==='assistant').length,1);
}));
