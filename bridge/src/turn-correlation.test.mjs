import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
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
    if (method === 'agent.wait') return { runId:params.runId,status:'timeout' };
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
  finally { runtime.turnOutbox.close(); await new Promise(resolve => setImmediate(resolve)); await rm(dir, { recursive: true, force: true }); }
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
  runtime.upstream.rpc = async method => { if (method === 'agent.wait') return {status:'timeout'}; ++sends; throw Error('upstream timeout for sessions.send'); };
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
    runtime.upstream.rpc = (method,params) => method === 'agent.wait'
      ? Promise.resolve({runId:params.runId,status:'timeout'})
      : new Promise(complete => { ++sends; release = complete; resolve(); });
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

test('a final repeating the request is not swallowed by pending or suppressed outbound echoes', async () => withRuntime(async ({ runtime, topic, send, deliver, wait }) => {
  const first = await send('repeat-pending');
  await deliver(first,'Request repeat-pending');
  assert.equal((await wait(first)).content.text,'Request repeat-pending');
  const second = await send('repeat-suppressed');
  const echo = runtime.normalizeGatewayMessage(topic,{role:'user',content:[{type:'text',text:'Request repeat-suppressed'}]});
  assert.equal(runtime.consumePendingMirror(topic.topic_key,echo),true);
  await deliver(second,'Request repeat-suppressed');
  assert.equal((await wait(second)).content.text,'Request repeat-suppressed');
}));

test('each final may repeat the other overlapping request without being dropped', async () => withRuntime(async ({ send, deliver, wait }) => {
  const first = await send('cross-first'); const second = await send('cross-second');
  await deliver(first,'Request cross-second'); await deliver(second,'Request cross-first');
  assert.equal((await wait(first)).content.text,'Request cross-second');
  assert.equal((await wait(second)).content.text,'Request cross-first');
}));

async function availablePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('HTTP text timeout is pending and a late A cannot become the next B response', { timeout:15000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cardputer-pending-http-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const upstreamPort = await availablePort(); let bridgePort = await availablePort();
  while (bridgePort === upstreamPort) bridgePort = await availablePort();
  const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const token = 'test-device-token-correlation-00000000000000000000001';
  config.server = { host:'127.0.0.1',port:bridgePort }; config.stateDir = path.join(dir,'state');
  config.media = Object.fromEntries(['inboundDir','canonicalDir','playbackDir','tmpDir'].map(k=>[k,path.join(dir,k)]));
  config.assets.rootDir = path.join(dir,'assets');config.assets.logsDir = path.join(dir,'logs');
  config.firmware.rootDir = path.join(dir,'firmware');
  config.upstream.url = `ws://127.0.0.1:${upstreamPort}`;config.upstream.token = 'test-gateway-correlation-00000000000000000000001';
  config.topics = [{topic_key:'cardputer:main',session_key:'agent:main:telegram:group:-1001234567890:topic:323',title:'Correlation test',thread_id:323}];
  config.devices = [{...config.devices[0],device_token:token,topics:['cardputer:main'],default_topic_key:'cardputer:main'}];
  config.telegram = {enabled:false};config.fastLane = {enabled:false};config.deviceTurnContext = {enabled:false};
  config.omnibotShim = {...config.omnibotShim,enabled:true,turnWaitMs:2000,turnPollMs:50};
  const configPath = path.join(dir,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const children=[];let log='';
  const start = (file, extra) => {
    const child=spawn(process.execPath,[file],{cwd:root,env:{PATH:process.env.PATH,...extra},stdio:['ignore','pipe','pipe']});
    children.push(child);child.stdout.on('data',b=>{log=(log+b).slice(-12000);});child.stderr.on('data',b=>{log=(log+b).slice(-12000);});return child;
  };
  const base=`http://127.0.0.1:${bridgePort}`;const headers={Authorization:`Bearer ${token}`,'content-type':'application/json'};
  const post=(id,message,reply_audio=false)=>fetch(base+'/api/device-text-turn',{method:'POST',headers,body:JSON.stringify({client_msg_id:id,message,reply_audio})});
  try {
    start('src/mock-upstream.mjs',{MOCK_UPSTREAM_PORT:String(upstreamPort),MOCK_UPSTREAM_TOKEN:config.upstream.token,
      MOCK_UPSTREAM_REPLY_DELAYS:JSON.stringify({CORRELATION_ALPHA:2700,CORRELATION_BRAVO:100}),MOCK_UPSTREAM_REQUIRE_SERIAL:"1",MOCK_UPSTREAM_FAIL_MESSAGE:'CORRELATION_DISPATCH_FAIL'});
    start('src/server.mjs',{CARDPUTER_BRIDGE_CONFIG:configPath});
    let ready=false;
    for(let i=0;i<100;++i){
      if(children.some(p=>p.exitCode!==null))throw Error('fixture exited: '+log);
      try{const h=await(await fetch(base+'/healthz',{headers})).json();if(h.upstream_connected){ready=true;break;}}catch{}
      await delay(50);
    }
    assert(ready,'gateway fixture not ready: '+log);
    const pendingResponse=await post('http-alpha','CORRELATION_ALPHA',true);const pending=await pendingResponse.json();
    assert.equal(pendingResponse.status,202);assert.equal(pending.ok,true);assert.equal(pending.pending,true);
    assert.equal(pending.status,'pending');assert.equal(pending.upstream_accepted,true);assert.equal(pending.client_msg_id,'http-alpha');assert(pending.after_seq>0);
    assert.match(pending.reply,/accepted/i);assert.equal(pending.audio,undefined);
    const secondResponse=await post('http-bravo','CORRELATION_BRAVO');const second=await secondResponse.json();
    assert.equal(secondResponse.status,200);assert.equal(second.transcript,'CORRELATION_BRAVO');
    assert.equal(second.reply,'Echo: CORRELATION_BRAVO');
    const retryResponse=await post('http-alpha','CORRELATION_ALPHA');const retry=await retryResponse.json();
    assert.equal(retryResponse.status,200);assert.equal(retry.reply,'Echo: CORRELATION_ALPHA');assert.notEqual(retry.reply_seq,second.reply_seq);
    // A visible final can precede the Gateway terminal receipt. Do not use a
    // guessed time delay to make the next turn eligible for dispatch.
    let drained=false;
    for(let i=0;i<100;++i){
      const disk=JSON.parse(await readFile(path.join(config.stateDir,'state.json'),'utf8'));
      if(disk.turn_outbox.entries.find(e=>e.client_msg_id==='http-bravo')?.phase==='terminal'){drained=true;break;}
      await delay(30);
    }
    assert(drained,'BRAVO terminal receipt was not persisted');
    const failedResponse=await post('http-failed','CORRELATION_DISPATCH_FAIL');const failed=await failedResponse.json();
    assert.equal(failedResponse.status,503);assert.notEqual(failed.pending,true);assert.match(failed.error,/dispatch failure/);
  } finally {
    for(const child of children.reverse()){if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}}
    await rm(dir,{recursive:true,force:true});
  }
});
