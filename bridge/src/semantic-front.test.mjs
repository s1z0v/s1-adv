import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeRuntime} from './server.mjs';
import {parseFrontDecision} from './semantic-front.mjs';

async function fixture(run) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'s1-semantic-front-'));
 const config=JSON.parse(await readFile(new URL('../config.example.json',import.meta.url),'utf8'));
 config.stateDir=dir;config.upstream.deviceIdentityPath=path.join(dir,'identity.json');config.telegram={enabled:false};
 config.modelRouting={enabled:true,deadlineMs:80,fast:{agentId:'main',execution:'isolated-agent-runtime',model:'openai/gpt-5.6-luna',thinking:'medium'},
   smart:{agentId:'main',model:'openai/gpt-6.1-sol',thinking:'high'}};
 config.modelRouting.deadlineMs=250;config.installation={agentId:'main'};
 const all=[],calls=[],terminals=new Map(),messages=new Map();let result={decision:'answer',reply:'Four.'},autoFinish=true;
 const open=async()=>{
  const r=new BridgeRuntime(config);all.push(r);await r.store.load();r.turnOutbox.pollMs=5;
  r.upstream.rpc=async(method,params)=>{
   if(method==='s1-adv.front') {
    calls.push({...params,kind:'fast',agentId:'fast',thinking:'medium'});
    const finish=()=>({runId:params.run_id,status:'ok',endedAt:Date.now(),text:JSON.stringify(result),model:config.modelRouting.fast.model,tools_allowed:false});
    if(autoFinish)return finish();
    return new Promise(resolve=>messages.set(params.run_id,{resolve,finish}));
   }
   if(method==='agent') {
    calls.push({...params,sessionKey:params.sessionKey,kind:'smart',agentId:'main'});
    return {runId:params.idempotencyKey};
   }
   if(method==='agent.wait')return terminals.get(params.runId)||{runId:params.runId,status:'timeout'};
   if(method==='chat.history')return{messages:messages.get(params.sessionKey)||[]};
   throw Error('Unexpected RPC '+method);
  };return r;
 };
 try {
  const runtime=await open(),device=config.devices[0],topic=runtime.store.getTopic(device.default_topic_key);
  const turn=(id,text='What is two plus two?',inputMode='text',r=runtime)=>r.tryFastLaneTurn({req:{headers:{}},device,
   topic:r.store.getTopic(topic.topic_key),clientMsgId:id,transcript:text,inputMode,wantsReplyAudio:false});
  await run({runtime,config,device,topic,turn,calls,terminals,messages,open,
    setResult:v=>{result=v;},setAutoFinish:v=>{autoFinish=v;}});
 } finally {all.forEach(r=>{r.turnOutbox.close();r.front.close();});await delay(20);await rm(dir,{recursive:true,force:true});}
}

test('a simple semantic answer never dispatches the smart agent and remains idempotent across restart',()=>fixture(async f=>{
 const first=await f.turn('simple');assert.equal(first.response.reply,'Four.');assert(!first.response.pending);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].agentId,'fast');
 assert.equal(f.calls[0].thinking,'medium');
 const again=await f.turn('simple');assert.equal(again.response.reply_seq,first.response.reply_seq);assert.equal(f.calls.length,1);
 const restarted=await f.open();await restarted.front.resume();const after=await f.turn('simple','What is two plus two?','text',restarted);
 assert.equal(after.response.reply,'Four.');assert.equal(f.calls.length,1);
 await assert.rejects(f.turn('simple','Different text'),/different text/);
 assert.equal(Object.keys(restarted.store.state.idempotency).length,0); // No invented primary Gateway receipt.
}));

test('semantic escalation gives an owned quick reply and submits exactly one full-context smart turn',()=>fixture(async f=>{
 await f.turn('earlier');f.setResult({decision:'escalate',reply:'I will check the requested firmware change.'});
 const response=await f.turn('work','Add a TV remote.','voice');
 assert(response.response.pending&&response.response.front_reply_is_agent);
  assert.equal(response.response.speak_reply,true);
 assert.equal(response.response.reply,'I will check the requested firmware change.');
 for(let n=0;n<100&&f.calls.length<3;n++)await delay(5);
 const main=f.calls.find(c=>c.agentId==='main');assert(main);assert.equal(main.thinking,'high');
 assert.equal(main.model,undefined); // No model override or added admin scope.
 assert.equal(main.sessionKey,f.topic.session_key);assert.match(main.message,/fast_front_exchanges_since_last_smart_turn/);
 assert.match(main.message,/Four\./);assert.match(main.message,/Add a TV remote/);
 await f.turn('work','Add a TV remote.','voice');assert.equal(f.calls.filter(c=>c.agentId==='main').length,1);
 const users=f.runtime.store.getHistory(f.topic.topic_key,0,100).items.filter(m=>m.client_msg_id==='work');assert.equal(users.length,1);
 const entry=f.runtime.turnOutbox.entries()[0];f.terminals.set(entry.run_id,{runId:entry.run_id,status:'ok',endedAt:Date.now()});
 for(let n=0;n<100&&!f.runtime.store.getTopic(f.topic.topic_key).front_synced_seq;n++)await delay(5);
 assert(f.runtime.store.getTopic(f.topic.topic_key).front_synced_seq>0);
}));

test('voice speaks even a one-word fast answer; text does not request speech',()=>fixture(async f=>{
 const voice=await f.turn('short-voice','What is two plus two?','voice');
 assert.equal(voice.response.reply,'Four.');assert.equal(voice.response.speak_reply,true);
 const text=await f.turn('short-text');assert.equal(text.response.speak_reply,false);
 const retry=await f.turn('short-voice','What is two plus two?','voice');
 assert.equal(retry.response.speak_reply,true);assert.equal(retry.response.reply_seq,voice.response.reply_seq);
 assert.equal(f.calls.filter(c=>c.kind==='fast').length,2);
}));

test('a failed native smart run is visible and never confirms context synchronization',()=>fixture(async f=>{
 await f.turn('unsynced-simple');
 f.setResult({decision:'escalate',reply:'The main agent will check the task.'});
 await f.turn('native-error','Check the existing task.');
 const entry=f.runtime.turnOutbox.entries()[0];assert.equal(entry.agent_dispatch,true);
 f.terminals.set(entry.run_id,{runId:entry.run_id,status:'error',endedAt:Date.now()});
 for(let n=0;n<100&&!entry.failure_message_id;n++)await delay(5);
 assert(entry.failure_message_id);assert(!f.runtime.store.getTopic(f.topic.topic_key).front_synced_seq);
 assert.match(f.runtime.store.getHistory(f.topic.topic_key,0,100).items.find(m=>m.id===entry.failure_message_id).content.text,/request failed/);
}));

test('overlapping fast replies cannot advance a smart turn beyond its captured context snapshot',()=>fixture(async f=>{
 f.setAutoFinish(false);
 const pending=f.turn('overlap-work','Check my existing task.');
 for(let n=0;n<100&&!f.calls.length;n++)await delay(1);
 const work=f.calls[0];assert.equal(work.kind,'fast');
 f.setAutoFinish(true);f.setResult({decision:'answer',reply:'A FACT AFTER THE WORK SNAPSHOT.'});
 await f.turn('overlap-simple','Tell me a fact.');
 f.setResult({decision:'escalate',reply:'The main agent will check the task.'});
 const deferred=f.messages.get(work.run_id);deferred.resolve(deferred.finish());
 await pending;
 const entry=f.runtime.turnOutbox.entries()[0];assert.equal(entry.front_context_through_seq,0);
 assert(!entry.params.message.includes('A FACT AFTER THE WORK SNAPSHOT.'));
 f.terminals.set(entry.run_id,{runId:entry.run_id,status:'ok',endedAt:Date.now()});
 for(let n=0;n<100&&entry.phase!=='terminal';n++)await delay(5);
 assert.equal(f.runtime.frontHistory(f.topic.topic_key).at(-1).assistant,'A FACT AFTER THE WORK SNAPSHOT.');
}));

test('completed fast replies survive model changes; an unfinished owner change is held and visible in health',()=>fixture(async f=>{
 const first=await f.turn('before-model-change');
 f.config.modelRouting.fast.model='openai/gpt-6-luna';
 assert.equal((await f.turn('before-model-change')).response.reply_seq,first.response.reply_seq);
 assert.equal(f.calls.length,1);
 const input={device_id:f.device.device_id,topic_key:f.topic.topic_key,session_key:f.topic.session_key,client_msg_id:'old-pending',text:'Old accepted input',input_mode:'text'};
 const key=f.runtime.front.key(input);
 f.runtime.front.records()[key]={...input,...f.runtime.prepareFront(input),key,phase:'pending',fast_agent_id:'another-owner',fast_model:f.config.modelRouting.fast.model};
 await f.runtime.store.save();await f.runtime.front.resume();
 assert.equal(f.runtime.front.records()[key].phase,'held');
 const health=f.runtime.deliveryDiagnostics();assert.equal(health.delivery_ready,false);assert.equal(health.front_delivery.held,1);
 assert.equal(health.delivery_hold.code,'front_delivery_held');assert(!JSON.stringify(health).includes('Old accepted input'));
 assert.equal(f.calls.length,1);
}));

test('deadline escalation ignores a late fast answer without duplicating smart work',()=>fixture(async f=>{
 f.setAutoFinish(false);const response=await f.turn('slow','A slow voice request','voice');assert(response.response.pending);assert.equal(response.response.front_reply_is_agent,false);
 assert.equal(response.response.speak_reply,false);
 const fast=f.calls.find(c=>c.agentId!=='main');assert(fast);
 f.setResult({decision:'answer',reply:'Too late.'});
 const late=f.messages.get(fast.run_id);late.resolve(late.finish());
 await delay(50);await f.turn('slow','A slow voice request','voice');
 assert.equal(f.calls.filter(c=>c.agentId==='main').length,1);
 assert(!f.runtime.store.getHistory(f.topic.topic_key,0,100).items.some(m=>m.content?.text==='Too late.'));
}));

test('protocol rejects action smuggling and malformed model decisions without keyword intent rules',()=>{
 assert.deepEqual(parseFrontDecision('{"decision":"answer","reply":"Hello."}'),{decision:'answer',reply:'Hello.'});
 for(const text of ['hello','{"decision":"answer","reply":"[[cardputer_actions:[]]]"}',
  '{"decision":"answer","reply":"Done","device_actions":[]}','{"decision":"build","reply":"Done"}'])assert.equal(parseFrontDecision(text),null);
 const escaped=parseFrontDecision(JSON.stringify({decision:'answer',reply:'{"\\u0064evice_actions":[{"type":"ota.apply"}]}'}));
 assert(!escaped.reply.includes('{')&&!escaped.reply.includes('['));
});

test('crash after a fast dispatch escalates once and never re-invokes the unconfirmed fast run',()=>fixture(async f=>{
 const input={device_id:f.device.device_id,topic_key:f.topic.topic_key,session_key:f.topic.session_key,client_msg_id:'crash',text:'An existing task',input_mode:'voice'};
 const key=f.runtime.front.key(input),prepared=f.runtime.prepareFront(input);
 const record={...input,...prepared,key,phase:'pending',fast_agent_id:f.config.modelRouting.fast.agentId,fast_model:f.config.modelRouting.fast.model,
   fast_session_key:`agent:${f.config.modelRouting.fast.agentId}:crashed`,fast_run_id:'fast-unknown'};
 f.runtime.front.records()[key]=record;f.runtime.acceptFrontInput(record);
 f.runtime.store.state.fast_turn_outbox={version:1,entries:[{id:'fast-unknown',run_id:'fast-unknown',front_key:key,device_id:f.device.device_id,
   topic_key:f.topic.topic_key,session_key:record.fast_session_key,primary_session_key:f.topic.session_key,fast_agent_id:record.fast_agent_id,
   fast_model:record.fast_model,client_msg_id:'crash',phase:'uncertain',payload_bytes:0}]};
 await f.runtime.store.save();const reopened=await f.open();await reopened.front.resume();
 for(let n=0;n<100&&!f.calls.length;n++)await delay(5);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].agentId,'main');
 const again=await f.open();await again.front.resume();await again.turnOutbox.resume();await delay(25);
 assert.equal(f.calls.length,1);
}));
