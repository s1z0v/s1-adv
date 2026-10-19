import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeRuntime } from './server.mjs';
import { agentStatusCredential, hasAgentStatusAccess, createAgentStatusTool, publishedAfterTask } from './agent-status.mjs';

async function fixture(run) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'s1-agent-status-'));
 const config=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
 config.stateDir=dir;config.upstream.deviceIdentityPath=path.join(dir,'identity.json');
 config.upstream.token='fixture-gateway-token-with-more-than-32-characters';
 config.telegram={enabled:false};config.firmware.rootDir=path.join(dir,'firmware');
 const runtimes=[],sends=[],terminals=new Map();
 const open=async()=>{
  const runtime=new BridgeRuntime(config);runtimes.push(runtime);await runtime.store.load();runtime.turnOutbox.pollMs=5;
  runtime.upstream.rpc=async(method,params)=>method==='sessions.send'?(sends.push(params),{runId:params.idempotencyKey}):
    (terminals.get(params.runId)||{runId:params.runId,status:'timeout'});
  return runtime;
 };
 try {
  const runtime=await open(),device=config.devices[0],topicKey=device.default_topic_key;
  const session_key=runtime.store.getTopic(topicKey).session_key;
  const send=async id=>runtime.sendText({device,topicKey,clientMsgId:id,text:id,waitForUpstream:true});
  const finish=async ack=>{terminals.set(ack.upstream_run_id,{runId:ack.upstream_run_id,status:'ok',endedAt:Date.now()});
   for(let n=0;n<100;n++){if(runtime.turnOutbox.entries().find(e=>e.id===ack.upstream_run_id)?.phase==='terminal')return;await delay(5);}assert.fail('terminal not observed');};
  await run({runtime,config,dir,device,topicKey,session_key,send,finish,open,sends});
 } finally {runtimes.forEach(r=>r.turnOutbox.close());await delay(20);await rm(dir,{recursive:true,force:true});}
}

test('agent clarification survives restart; arbitrary G0/text follow-ups keep the same session and task',()=>fixture(async f=>{
 const ack=await f.send('ask-remote');
 await f.runtime.setAgentTaskStatus({session_key:f.session_key,request_id:'ask-remote',state:'awaiting_input',work_kind:'firmware',question:'Which TV model?'});
 const original=f.runtime.firmwareJobStatusForDevice(f.device);
 assert.equal(original.state,'awaiting_input');assert.equal(original.task_id,'ask-remote');
 const questions=f.runtime.store.getHistory(f.topicKey,0,100).items.filter(m=>m.source?.transport==='cardputer_agent_question');
 assert.equal(questions.length,1);assert.equal(questions[0].content.text,'Which TV model?');
 await f.runtime.setAgentTaskStatus({session_key:f.session_key,request_id:'ask-remote',state:'awaiting_input',work_kind:'firmware',question:'Which TV model?'});
 assert.equal(f.runtime.store.getHistory(f.topicKey,0,100).items.filter(m=>m.source?.transport==='cardputer_agent_question').length,1);
 await f.runtime.ingestUpstreamMessage(f.runtime.store.getTopic(f.topicKey),{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Which TV model?'}],__openclaw:{runId:ack.upstream_run_id}});
 assert.equal(f.runtime.store.getHistory(f.topicKey,0,100).items.filter(m=>m.content?.text==='Which TV model?').length,1);
 const reopened=await f.open();assert.equal(reopened.firmwareJobStatusForDevice(f.device).question,'Which TV model?');
 await f.finish(ack);
 const reply=await f.send('Samsung-UE55');
 await f.runtime.setAgentTaskStatus({session_key:f.session_key,request_id:'Samsung-UE55',task_id:'ask-remote',state:'working',work_kind:'firmware'});
 assert.equal(f.runtime.firmwareJobStatusForDevice(f.device).task_id,'ask-remote');
 assert.equal(f.sends.length,2);assert(f.sends.every(s=>s.key===f.session_key));
 const before=JSON.stringify(f.runtime.store.getTopic(f.topicKey).agent_task);
 await f.finish(reply);const weather=await f.send('weather');
 assert.equal(JSON.stringify(f.runtime.store.getTopic(f.topicKey).agent_task),before);
 const context=f.runtime.buildDeviceTurnUpstreamText({device:f.device,topicKey:f.topicKey,clientMsgId:'weather',text:'Weather?',inputMode:'voice'});
 assert.match(context,/"request_id":"weather"|"request_id": "weather"/);assert.match(context,/ask-remote/);
 await f.finish(weather);
}));

test('status cannot overwrite another task, use a foreign or finished turn, or claim an unpublished firmware',()=>fixture(async f=>{
 const ack=await f.send('one');
 const payload={session_key:f.session_key,request_id:'one',state:'awaiting_input',work_kind:'firmware',question:'Which model?'};
 await f.runtime.setAgentTaskStatus(payload);
 const before=JSON.stringify(f.runtime.store.state.turn_outbox);
 await assert.rejects(f.runtime.setAgentTaskStatus({...payload,session_key:'agent:other:session'}),/authorized/);
 await assert.rejects(f.runtime.setAgentTaskStatus({...payload,request_id:'missing'}),/owned turn/);
 await assert.rejects(f.runtime.setAgentTaskStatus({...payload,task_id:'stale'}),/identity/);
 await assert.rejects(f.runtime.setAgentTaskStatus({...payload,state:'building',work_kind:'task'}),/Only firmware/);
 await assert.rejects(f.runtime.setAgentTaskStatus({...payload,state:'completed'}),/verified new OTA/);
 await assert.rejects(f.runtime.setAgentTaskStatus({...payload,question:''}),/question/);
 assert.equal(JSON.stringify(f.runtime.store.state.turn_outbox),before);
 await f.finish(ack);
 await assert.rejects(f.runtime.setAgentTaskStatus(payload),/active owned/);
}));

test('status authentication is loopback-only, rejects proxy headers and never accepts device/Gateway credentials',()=>{
 const config={upstream:{token:'fixture-gateway-token-with-more-than-32-characters'}};
 const credential=agentStatusCredential(config);
 const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-s1-agent-status':credential}};
 assert(hasAgentStatusAccess(req,config));
 assert(!hasAgentStatusAccess({...req,socket:{remoteAddress:'198.51.100.10'}},config));
 assert(!hasAgentStatusAccess({...req,headers:{...req.headers,'x-forwarded-for':'127.0.0.1'}},config));
 assert(!hasAgentStatusAccess({...req,headers:{'x-s1-agent-status':config.upstream.token}},config));
 assert(!hasAgentStatusAccess(req,{upstream:{token:'short'}}));
});

test('declining a clarification closes it without publishing or changing the durable turn',()=>fixture(async f=>{
 const first=await f.send('ask');
 await f.runtime.setAgentTaskStatus({session_key:f.session_key,request_id:'ask',state:'awaiting_input',work_kind:'firmware',question:'Which TV?'});
 await f.finish(first);const second=await f.send('no');
 const before=JSON.stringify(f.runtime.store.state.turn_outbox);
 await f.runtime.setAgentTaskStatus({session_key:f.session_key,request_id:'no',task_id:'ask',state:'cancelled',work_kind:'firmware'});
 assert.equal(f.runtime.firmwareJobStatusForDevice(f.device).state,'cancelled');
 assert.equal(JSON.stringify(f.runtime.store.state.turn_outbox),before);
 await f.finish(second);
}));

test('native status tool is scoped to its trusted session and fixed private destination',()=>fixture(async f=>{
 const configPath=path.join(f.dir,'private.json');await writeFile(configPath,JSON.stringify(f.config),{mode:0o600});
 const calls=[];const deps={fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({ok:true})};}};
 assert.equal(createAgentStatusTool({sessionKey:'agent:other:session'},{configPath},deps),null);
 assert.equal(createAgentStatusTool({sessionKey:f.session_key,sandboxed:true},{configPath},deps),null);
 const tool=createAgentStatusTool({sessionKey:f.session_key},{configPath},deps);
 await tool.execute('call',{request_id:'one',state:'awaiting_input',work_kind:'firmware',question:'Which model?',session_key:'forged'});
 assert.equal(JSON.parse(calls[0].options.body).session_key,f.session_key);
 assert.equal(calls[0].options.redirect,'error');assert.match(calls[0].url,/^http:\/\/127\.0\.0\.1:/);
 assert.notEqual(calls[0].options.headers['x-s1-agent-status'],f.config.upstream.token);
 await chmod(configPath,0o644);assert.equal(createAgentStatusTool({sessionKey:f.session_key},{configPath},deps),null);
}));

test('firmware completion requires a new manifest tied to the task lifetime',()=>{
 const task={started_at:'2026-10-19T00:00:00Z',baseline_sha256:'a'.repeat(64)};
 const manifest={version:'0.2.175-dev',size:2000000,sha256:'b'.repeat(64),build_git_sha:'c'.repeat(40),built_at:'2026-10-19T00:01:00Z'};
 assert(publishedAfterTask(manifest,task));
 for(const change of [{sha256:task.baseline_sha256},{built_at:'2026-10-18T00:00:00Z'},{build_git_sha:'local'},{size:0}])
  assert(!publishedAfterTask({...manifest,...change},task));
});
