import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeRuntime } from './server.mjs';

async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(10); }
  assert.fail('expected outbox transition did not occur');
}

async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cardputer-outbox-'));
  const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  config.upstream.deviceIdentityPath = path.join(dir,'gateway-identity.json');
  config.stateDir = dir; config.devices = config.devices.slice(0, 1); config.telegram = { enabled:false };
  const runtimes = [], sends = [], terminals = new Map();
  let dispatch = async params => ({ runId:params.idempotencyKey });
  const open = async () => {
    const runtime = new BridgeRuntime(config); runtimes.push(runtime);
    await runtime.store.load(); runtime.turnOutbox.pollMs = 10;
    runtime.upstream.rpc = async (method, params) => {
      if (method === 'agent.wait') return terminals.get(params.runId) || { runId:params.runId,status:'timeout' };
      assert.equal(method, 'sessions.send'); sends.push(params); return dispatch(params, runtime);
    };
    return runtime;
  };
  const runtime = await open(), device = config.devices[0];
  const topicKey = device.default_topic_key || device.topics[0];
  const send = (id, runtimeOverride = runtime, topic = topicKey, text = `Request ${id}`) => runtimeOverride.sendText({
    device, topicKey:topic, clientMsgId:id, text, waitForUpstream:true
  });
  const finish = ack => terminals.set(ack.upstream_run_id, {runId:ack.upstream_run_id,status:'ok',endedAt:Date.now()});
  try { await run({runtime,config,device,topicKey,send,sends,terminals,finish,open,
    setDispatch: fn => { dispatch = fn; }}); }
  finally {
    runtimes.forEach(r => r.turnOutbox.close());
    await delay(30); await rm(dir,{recursive:true,force:true});
  }
}

test('actual runtime queues B durably until A has an exact terminal receipt, not just final text', async () => fixture(async f => {
  const first = await f.send('lane-a'); const second = await f.send('lane-b');
  assert.equal(f.sends.length,1); assert.equal(second.delivery_state,'queued');
  const disk = JSON.parse(await readFile(f.runtime.store.filePath,'utf8'));
  assert.equal(disk.turn_outbox.entries[1].params.message,'Request lane-b');
  await f.runtime.handleUpstreamEvent({event:'chat',payload:{sessionKey:f.sends[0].key,
    runId:first.upstream_run_id,state:'final',message:{role:'assistant',content:[{type:'text',text:'A completed text'}]}}});
  await delay(35); assert.equal(f.sends.length,1,'final text alone cannot drain the Gateway lane');
  f.finish(first); await until(() => f.sends.length === 2);
  assert.equal(f.sends[1].idempotencyKey,second.upstream_run_id);
}));

test('session aliases share one lane while a different session can dispatch independently', async () => fixture(async f => {
  const topic=f.runtime.store.getTopic(f.topicKey), device=f.runtime.store.state.devices[f.device.device_id];
  for (const [key, session] of [['alias',topic.session_key],['independent','agent:other:independent']]) {
    f.runtime.store.state.topics[key]={...topic,topic_key:key,session_key:session};
    f.runtime.store.state.messages[key]=[];device.topics.push(key);
  }
  const first=await f.send('alias-a');await f.send('alias-b',f.runtime,'alias');
  await f.send('independent-c',f.runtime,'independent');
  assert.equal(f.sends.length,2);assert.equal(f.sends[1].key,'agent:other:independent');
  f.finish(first);await until(()=>f.sends.length===3);assert.equal(f.sends[2].key,topic.session_key);
}));

test('restart observes accepted A without resending it and resumes the persisted B once', async () => fixture(async f => {
  const first=await f.send('restart-a');const second=await f.send('restart-b');
  f.runtime.turnOutbox.close();await f.runtime.store.save();
  const restarted=await f.open();await restarted.turnOutbox.resume();
  await delay(35);assert.equal(f.sends.length,1);
  f.finish(first);await until(()=>f.sends.length===2);
  const retry=await f.send('restart-b',restarted);assert.equal(retry.message_id,second.message_id);
  await delay(35);assert.equal(f.sends.length,2);
}));

test('crash after dispatch intent never resends, and missing or wrong terminal proof holds B', async () => fixture(async f => {
  const first=await f.send('uncertain-a');await f.send('uncertain-b');
  f.runtime.turnOutbox.close();
  const entry=f.runtime.turnOutbox.entries()[0];entry.phase='dispatching';entry.upstream_accepted=false;
  await f.runtime.store.save();const restarted=await f.open();await restarted.turnOutbox.resume();
  f.terminals.set(first.upstream_run_id,{runId:'unrelated-run',status:'ok',endedAt:Date.now()});
  await delay(35);assert.equal(f.sends.length,1);
  f.terminals.set(first.upstream_run_id,{runId:first.upstream_run_id,status:'timeout',endedAt:Date.now()});
  await delay(35);assert.equal(f.sends.length,1);
  f.finish(first);await until(()=>f.sends.length===2);
}));

test('RPC timeout preserves ownership and blocks B until the late exact terminal receipt', async () => fixture(async f => {
  f.setDispatch(async()=>{throw Error('upstream timeout for sessions.send');});
  await assert.rejects(f.send('rpc-a'),/upstream timeout/);
  const first=f.runtime.store.getIdempotent(f.topicKey,'rpc-a');
  assert.equal(first.delivery_state,'uncertain');await f.send('rpc-b');
  await delay(35);assert.equal(f.sends.length,1);
  f.setDispatch(async p=>({runId:p.idempotencyKey}));f.finish(first);
  await until(()=>f.sends.length===2);
}));

test('capacity rejection occurs before acceptance/history mutation and retries consume no slot', async () => fixture(async f => {
  const first=await f.send('capacity-0');
  for(let i=1;i<8;++i)await f.send(`capacity-${i}`);
  const seq=f.runtime.store.getTopic(f.topicKey).head_seq;
  await assert.rejects(f.send('capacity-8'),/queue is full/);
  assert.equal(f.runtime.store.getTopic(f.topicKey).head_seq,seq);
  assert.equal(f.runtime.store.getIdempotent(f.topicKey,'capacity-8'),null);
  assert.equal((await f.send('capacity-0')).message_id,first.message_id);
  assert.equal(f.runtime.turnOutbox.entries().length,8);
}));

test('oversized persisted payload is rejected before a device receipt is created', async () => fixture(async f => {
  await assert.rejects(f.send('too-large',f.runtime,f.topicKey,'x'.repeat(65536)),/queue is full/);
  assert.equal(f.runtime.store.getIdempotent(f.topicKey,'too-large'),null);assert.equal(f.sends.length,0);
}));

test('exact terminal error drains a completed run but does not return its text to another turn', async () => fixture(async f => {
  const first=await f.send('error-a');const second=await f.send('error-b');
  f.terminals.set(first.upstream_run_id,{runId:first.upstream_run_id,status:'error',endedAt:Date.now()});
  await until(()=>f.sends.length===2);
  assert.equal(second.upstream_run_id,f.sends[1].idempotencyKey);
}));

test('configuration remap or revoked device holds queued work without dispatching it', async () => fixture(async f => {
  const first=await f.send('remap-a');await f.send('remap-b');
  f.runtime.store.getTopic(f.topicKey).session_key='agent:changed:private';f.finish(first);
  await until(()=>f.runtime.turnOutbox.entries()[1].phase==='held');assert.equal(f.sends.length,1);
  assert.match(f.runtime.turnOutbox.entries()[1].hold_reason,/authorization or session changed/);
}));

test('dispatch intent and full payload are on disk before the first upstream call', async () => fixture(async f => {
  f.setDispatch(async(params,runtime)=>{
    const disk=JSON.parse(await readFile(runtime.store.filePath,'utf8'));
    const entry=disk.turn_outbox.entries.find(e=>e.id===params.idempotencyKey);
    assert.equal(entry.phase,'dispatching');assert.deepEqual(entry.params,params);
    assert(disk.idempotency[`${f.topicKey}::durable-first`]);
    return {runId:'opaque-durable-run'};
  });
  const receipt=await f.send('durable-first');assert.equal(receipt.upstream_run_id,'opaque-durable-run');
}));

test('upgrade adopts a known pre-outbox receipt without resending or bypassing it', async () => fixture(async f => {
  const first=await f.send('legacy-a');f.runtime.turnOutbox.close();
  delete f.runtime.store.state.turn_outbox;await f.runtime.store.save();
  const restarted=await f.open();await restarted.turnOutbox.resume();await f.send('legacy-b',restarted);
  await delay(35);assert.equal(f.sends.length,1);
  f.finish(first);await until(()=>f.sends.length===2);
}));
