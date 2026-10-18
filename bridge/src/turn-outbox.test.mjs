import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('firmware status survives durable acceptance and only its owned reply updates it', async () => fixture(async f => {
  const key = 'local:cardputer-firmware-job:status-test';
  const topic = { ...f.runtime.store.getTopic(f.topicKey), topic_key:key,
    session_key:'agent:main:cardputer-firmware:status-test' };
  f.runtime.store.state.topics[key] = topic;
  f.runtime.store.state.devices[f.device.device_id].topics.push(key);
  f.runtime.config.firmware.rootDir = path.join(f.config.stateDir,'firmware');
  const ack = await f.send('status-request', f.runtime, key);
  assert.equal(f.runtime.firmwareJobStatusForDevice(f.device).state,'building');
  const persisted = JSON.parse(await readFile(path.join(f.config.stateDir,'state.json'),'utf8'));
  assert.equal(persisted.topics[key].firmware_job.request_id,'status-request');
  await f.runtime.ingestUpstreamMessage(topic,{role:'assistant',timestamp:Date.now(),
    content:[{type:'text',text:'Unrelated final answer'}],__openclaw:{id:'unrelated-status',runId:'another-run'}});
  assert.equal(f.runtime.firmwareJobStatusForDevice(f.device).state,'building');
  await f.runtime.ingestUpstreamMessage(topic,{role:'assistant',timestamp:Date.now(),
    stopReason:'stop',content:[{type:'text',text:'Please clarify the change.'}],
    __openclaw:{id:'owned-status',runId:ack.upstream_run_id}});
  assert.equal(f.runtime.firmwareJobStatusForDevice(f.device).state,'attention');
  assert.equal(f.runtime.turnOutbox.entries()[0].phase,'inflight', 'a status update is not terminal proof');
  assert.equal(f.runtime.firmwareJobStatusForDevice({device_id:'another-device'}).state,'idle');
  f.finish(ack);
}));

test('uncertain firmware dispatch remains visible and is never resent', async () => fixture(async f => {
  const key='local:cardputer-firmware-job:uncertain-status';
  const topic={...f.runtime.store.getTopic(f.topicKey),topic_key:key,session_key:'agent:main:firmware-uncertain'};
  f.runtime.store.state.topics[key]=topic;
  f.runtime.store.state.devices[f.device.device_id].topics.push(key);
  f.runtime.config.firmware.rootDir=path.join(f.config.stateDir,'firmware');
  f.setDispatch(async()=>{throw Error('RPC connection lost');});
  await assert.rejects(f.send('uncertain-status',f.runtime,key),/RPC connection lost/);
  await until(()=>f.runtime.firmwareJobStatusForDevice(f.device).state==='uncertain');
  await f.send('uncertain-status',f.runtime,key);
  assert.equal(f.sends.length,1);
}));

test('session label collision creates only the exact requested session and never masks other errors', async () => fixture(async f => {
  const topic = { ...f.runtime.store.getTopic(f.topicKey), session_key: 'agent:main:isolated-new-cardputer' };
  const calls=[];
  f.runtime.upstream.rpc=async(method,params)=>{
    calls.push({method,params});
    if(method==='sessions.get')throw Error('session not found');
    assert.equal(method,'sessions.create');
    if(params.label)throw Error('label already in use: Cardputer');
    return {key:params.key};
  };
  await f.runtime.ensureUpstreamSessionForTopic(topic);
  assert.deepEqual(calls.map(call=>call.method),['sessions.get','sessions.create','sessions.create']);
  for(const call of calls)assert.equal(call.params.key,topic.session_key);
  assert.equal(Object.hasOwn(calls.at(-1).params,'label'),false);
  assert.equal(f.sends.length,0);
  let denied=0;
  f.runtime.upstream.rpc=async()=>{denied++;throw Error('permission denied');};
  await assert.rejects(f.runtime.ensureUpstreamSessionForTopic(topic,{forceCreate:true}),/permission denied/);
  assert.equal(denied,1);
}));

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
  assert.equal(restarted.turnOutbox.diagnostics().delivery_ready,false);
  assert.equal(restarted.turnOutbox.diagnostics().delivery_hold.code,'legacy_receipts_require_audit');
  f.finish(first);await until(()=>f.sends.length===2);
  assert.equal(restarted.turnOutbox.diagnostics().delivery_ready,true);
}));

function seedLegacy(f, count) {
  delete f.runtime.store.state.turn_outbox;
  return Array.from({ length: count }, (_, i) => {
    const client = `old-${i}`, runId = `old-gateway-run-${i}`;
    const message = f.runtime.store.appendMessage(f.topicKey, { id:`old-message-${i}`,
      sender:{kind:'device',id:`cardputer:${f.device.device_id}`},source:{transport:'cardputer'},
      client_msg_id:client,content:{kind:'text',text:`Old request ${i}`} });
    const ack = {type:'ack',topic_key:f.topicKey,client_msg_id:client,message_id:message.id,seq:message.seq,
      upstream_run_id:runId,upstream_accepted:true,accepted_at:new Date().toISOString()};
    f.runtime.store.setIdempotent(f.topicKey, client, ack);
    return {id:`cardputer:${f.device.device_id}:${f.topicKey}:${client}`,run_id:runId,
      status:'ok',ended_at:Date.now(),evidence:`fixture exact terminal receipt ${i}`};
  });
}

test('legacy migration holds delivery without preventing startup or changing receipt history', async () => fixture(async f => {
  seedLegacy(f,33);await f.runtime.store.save();
  const restarted=await f.open();await restarted.turnOutbox.resume();
  assert.equal(restarted.turnOutbox.diagnostics().delivery_ready,false);
  assert.equal(restarted.turnOutbox.diagnostics().delivery_hold.code,'legacy_receipts_require_audit');
  const before=restarted.store.getTopic(f.topicKey).head_seq;
  await assert.rejects(f.send('blocked-by-migration',restarted),/Delivery held/);
  assert.equal(restarted.store.getTopic(f.topicKey).head_seq,before);
  assert.equal(Object.keys(restarted.store.state.idempotency).length,33);
  assert.equal(f.sends.length,0);
}));

test('an unsupported outbox remains untouched and exposes a delivery hold', async () => fixture(async f => {
  const unsupported={version:2,entries:{future:'schema'}};
  f.runtime.store.state.turn_outbox=unsupported;
  await f.runtime.turnOutbox.resume();
  assert.equal(f.runtime.turnOutbox.diagnostics().delivery_hold.code,'unsupported_outbox_state');
  assert.equal(f.runtime.turnOutbox.diagnostics().delivery_ready,false);
  assert.deepEqual(f.runtime.store.state.turn_outbox,unsupported);
  assert.equal(f.sends.length,0);
}));

test('quiescence alone cannot mark unknown legacy runs complete; an exact private terminal audit can', async () => fixture(async f => {
  const receipts=seedLegacy(f,33);await f.runtime.store.save();
  const restarted=await f.open(),auditPath=path.join(f.config.stateDir,'turn-outbox-cutover.json');
  const audit={version:1,audit_id:'fixture-cutover',audited_at:new Date().toISOString(),quiescent:true,receipts:[]};
  await writeFile(auditPath,JSON.stringify(audit),{mode:0o600});await restarted.turnOutbox.resume();
  assert.equal(restarted.turnOutbox.diagnostics().delivery_hold.code,'invalid_cutover_audit');
  assert.equal(restarted.store.getIdempotent(f.topicKey,'old-0').upstream_terminal,undefined);
  audit.receipts=receipts.map((receipt,i)=>i?receipt:{...receipt,run_id:'wrong-run'});
  await writeFile(auditPath,JSON.stringify(audit));await restarted.turnOutbox.resume();
  assert.equal(restarted.turnOutbox.diagnostics().delivery_ready,false);
  assert.equal(restarted.store.getIdempotent(f.topicKey,'old-1').upstream_terminal,undefined,'validation is atomic');
  audit.receipts=receipts;await writeFile(auditPath,JSON.stringify(audit));await restarted.turnOutbox.resume();
  assert.equal(restarted.turnOutbox.diagnostics().delivery_ready,true);
  assert.equal(restarted.store.getIdempotent(f.topicKey,'old-0').upstream_terminal.operator_audit.id,'fixture-cutover');
  assert.equal(restarted.store.getHistory(f.topicKey,0,100).items.length,33);
  assert.equal(f.sends.length,0,'auditing never resends an old request');
  await f.send('new-after-cutover',restarted);assert.equal(f.sends.length,1);
  restarted.turnOutbox.close();await restarted.store.save();
  const next=await f.open();await next.turnOutbox.resume();
  assert.notEqual(next.turnOutbox.entries().find(e=>e.client_msg_id==='new-after-cutover').phase,'terminal','consumed marker cannot complete a later run');
  assert.equal(f.sends.length,1);
}));

test('compaction pins pending ACKs and an independently retained outbox identity prevents duplicate retries', async () => fixture(async f => {
  f.config.state={maxIdempotencyEntries:100};
  const first=await f.send('pinned-pending');
  for(let i=0;i<100;i++)f.runtime.store.setIdempotent('other',`done-${i}`,{
    accepted_at:new Date(Date.now()+1000+i).toISOString(),upstream_terminal:{status:'ok'}});
  f.runtime.store.compact();
  assert.equal(f.runtime.store.getIdempotent(f.topicKey,'pinned-pending').message_id,first.message_id);
  delete f.runtime.store.state.idempotency[`${f.topicKey}::pinned-pending`];
  const retry=await f.send('pinned-pending');
  assert.equal(retry.message_id,first.message_id);assert.equal(retry.seq,first.seq);
  assert.equal(f.runtime.turnOutbox.entries().length,1);
  const record=f.runtime.turnOutbox.entries()[0];
  const duplicate=await f.runtime.turnOutbox.enqueue({...record,params:{...record.params,message:'must not replace original'}});
  assert.equal(duplicate.record,record);assert.equal(record.params.message,'Request pinned-pending');
  f.finish(first);await until(()=>record.phase==='terminal');await delay(30);
  assert.equal(f.sends.length,1);assert.equal(f.runtime.store.getTopic(f.topicKey).head_seq,1);
}));

test('transient observation errors retry proof without another kick or request resend', async () => fixture(async f => {
  const original=f.runtime.upstream.rpc;let failures=2,observations=0;
  f.runtime.upstream.rpc=async(method,params)=>{
    if(method==='agent.wait'){++observations;if(failures-->0)throw Error('temporary transport loss');}
    return original(method,params);
  };
  const first=await f.send('observe-a');await f.send('observe-b');
  await until(()=>observations>=2);assert.equal(f.sends.length,1);
  f.finish(first);await until(()=>f.sends.length===2);
  assert.equal(f.runtime.turnOutbox.entries()[0].phase,'terminal');
  assert.equal(f.sends.filter(p=>p.idempotencyKey===first.upstream_run_id).length,1);
}));

test('terminal errors produce one owned failure in Inbox and truthful idempotent responses after restart', async () => fixture(async f => {
  const first=await f.send('failed-final');
  f.terminals.set(first.upstream_run_id,{runId:first.upstream_run_id,status:'error',endedAt:Date.now()});
  await until(()=>f.runtime.store.getHistory(f.topicKey,0,100).items.some(m=>m.source?.terminal_error));
  const retry=await f.send('failed-final');
  const topic=f.runtime.store.getTopic(f.topicKey);
  const response=await f.runtime.buildPendingTurnResponse({req:{headers:{}},device:f.device,topic,transcript:'original',ack:retry});
  assert.equal(response.status,'failed');assert.equal(response.ok,false);assert.equal(response.pending,false);
  const reply=await f.runtime.waitForAssistantReply(f.topicKey,retry.seq,1000,50,0,retry);
  assert.equal(reply.source.upstream_run_id,first.upstream_run_id);assert.equal(reply.source.terminal_error,true);
  const answered=await f.runtime.buildTurnResponse({req:{headers:{}},topic,replyText:reply.content.text,replyMessage:reply});
  assert.equal(answered.status,'failed');assert.equal(answered.ok,false);
  f.runtime.turnOutbox.close();await f.runtime.store.save();
  const restarted=await f.open();await restarted.turnOutbox.resume();
  assert.equal(restarted.store.getHistory(f.topicKey,0,100).items.filter(m=>m.source?.terminal_error).length,1);
  assert.equal(f.sends.length,1);
}));

test('fixed pending and failed system receipts stay English for Russian input', async () => fixture(async f => {
  const topic=f.runtime.store.getTopic(f.topicKey);
  for(const state of [
    {delivery_state:'queued'}, {upstream_accepted:true}, {upstream_accepted:false},
    {upstream_terminal:{status:'error',run_id:'failed',ended_at:Date.now()}}
  ]){
    const response=await f.runtime.buildPendingTurnResponse({req:{headers:{}},device:f.device,topic,
      transcript:'Скажи, который час',ack:{seq:1,client_msg_id:'language',upstream_run_id:'run',...state}});
    assert.doesNotMatch(response.reply,/[А-Яа-яЁё]/u);
    assert.match(response.reply,/Request|request/);
    assert.equal(response.transcript,'Скажи, который час');
  }
}));
