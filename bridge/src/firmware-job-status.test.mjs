import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state-store.mjs';
import { startFirmwareJob, updateFirmwareJob, publicFirmwareJob, firmwareJobDeliveryUncertain } from './firmware-job-status.mjs';
const time = Date.parse('2026-10-18T16:00:00Z');
const manifest = { version:'0.2.167-dev',sha256:'a'.repeat(64),build_git_sha:'f'.repeat(40),size:2000000,built_at:new Date(time+10000).toISOString() };
const final = {message:{role:'assistant',stopReason:'stop',timestamp:time+11000},text:'Published 0.2.167-dev. {"type":"ota.check"}',manifest,now:time+12000};

test('job survives the real state store restart; polling never consumes it', async () => {
 const dir=mkdtempSync(join(tmpdir(),'firmware-job-'));
 try {
  const config={stateDir:dir,devices:[],topics:[]};
  const first=new StateStore(config);await first.load();
  const job=startFirmwareJob('a','request-one',time);
  first.state.topics.one={topic_key:'one',session_key:'test-one',firmware_job:job};
  await first.save();
  const restarted=new StateStore(config);await restarted.load();
  const restored=restarted.getTopic('one').firmware_job;
  assert.deepEqual(publicFirmwareJob(restored,time+1000),publicFirmwareJob(job,time+1000));
  assert.equal(restored.state,'building');
  assert.equal(publicFirmwareJob(restored,time+16*60000).state,'stalled');
  assert.equal(restored.state,'building');
 } finally { rmSync(dir,{recursive:true}); }
});

test('a new published artifact and OTA marker are both required', () => {
 const job=startFirmwareJob('a','request-one',time,{sha256:'b'.repeat(64)});
 assert.equal(updateFirmwareJob(job,final).state,'ready');
 for(const m of [null,{...manifest,sha256:job.baseline_sha256},{...manifest,built_at:new Date(time-1).toISOString()},{...manifest,sha256:'invalid'},{...manifest,size:0},{...manifest,build_git_sha:''},{...manifest,version:'0.2.168-dev'}])
  assert.equal(updateFirmwareJob(job,{...final,manifest:m}).state,'attention');
 assert.equal(updateFirmwareJob(job,{...final,text:'Build completed'}).state,'attention');
});

test('tool progress, commentary and old history cannot finish a job', () => {
 const job=startFirmwareJob('a','request-two',time);
 for(const type of ['toolCall','tool_use','functionCall'])
  assert.equal(updateFirmwareJob(job,{...final,message:{role:'assistant',stopReason:'toolUse',content:[{type}]}}).state,'building');
 assert.equal(updateFirmwareJob(job,{...final,message:{role:'assistant',stopReason:'length'}}).state,'building');
 assert.equal(updateFirmwareJob(job,{...final,text:''}).state,'building');
 assert.equal(updateFirmwareJob(job,{...final,message:{role:'toolResult'}}).state,'building');
 assert.equal(updateFirmwareJob(job,{...final,message:{timestamp:time-1,role:'assistant'}}),job);
 assert.equal(updateFirmwareJob(job,{...final,message:{role:'assistant',stopReason:'error'}}).state,'failed');
});

test('uncertain RPC delivery avoids claiming failure; later actual progress recovers', () => {
 const job=firmwareJobDeliveryUncertain(startFirmwareJob('a','one',time),time+1000);
 assert.equal(publicFirmwareJob(job,time+2000).state,'uncertain');
 assert.equal(updateFirmwareJob(job,{message:{content:[{type:'toolCall'}]},now:time+3000}).state,'building');
 assert.equal(updateFirmwareJob(job,final).state,'ready');
});

test('actual runtime selects status per device; empty inbox and restarts expose it', () => {
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  firmwareJobStatusForDevice('),source.indexOf('  async tryFastLaneTurn(')).trim();
 const status=new Function('publicFirmwareJob',`return function ${code}`)(publicFirmwareJob);
 const topics={a:{firmware_job:startFirmwareJob('a','a-one',time)},b:{firmware_job:startFirmwareJob('b','b-one',time+1000)}};
 const restored={store:{state:JSON.parse(JSON.stringify({topics}))}};
 assert.equal(status.call(restored,{device_id:'a'}).request_id,'a-one');
 assert.equal(status.call(restored,{device_id:'b'}).request_id,'b-one');
 assert.equal(status.call(restored,{device_id:'c'}).state,'idle');
 assert.match(source,/firmware_job: runtime.firmwareJobStatusForDevice\(device\),\s*items/);
});

test('actual upstream dispatch separates optional Telegram failure from uncertain delivery', async () => {
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  async sendText({'),source.indexOf('  async sendVoice(')).trim();
 const construct=new Function('makeId','nowIso','voiceThinking','maybeRelayTelegramText','firmwareJobDeliveryUncertain',`return async function ${code.slice(6)}`);
 const send=construct(()=> 'message-one',()=>new Date(time).toISOString(),()=>null,
   async()=>{throw Error('Telegram mirror unavailable')},firmwareJobDeliveryUncertain);
 const topic={topic_key:'one',session_key:'session-one',firmware_job:startFirmwareJob('a','one',time)};
 const events=[];
 const runtime={config:{},store:{getTopic:()=>topic,getIdempotent:()=>null,appendMessage:(_k,m)=>({...m,seq:1}),setIdempotent(){},save:async()=>{}},
   rememberPendingMirror(){},broadcast:(_k,event)=>events.push(event),upstream:{rpc:async()=>({})}};
 // This extracted handler test isolates the optional mirror policy. Actual
 // durable queue/admission/dispatch behavior is exercised in turn-outbox.test.
 runtime.turnOutbox={assertCapacity(){},enqueue:async()=>({dispatched:runtime.upstream.rpc()})};
 await send.call(runtime,{device:{device_id:'a'},topicKey:'one',clientMsgId:'one',text:'Build firmware',waitForUpstream:true});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(topic.firmware_job.state,'building');assert(!events.some(e=>e.state==='failed'));
 runtime.upstream.rpc=async()=>{throw Error('upstream timeout for sessions.send')};
 await assert.rejects(send.call(runtime,{device:{device_id:'a'},topicKey:'one',clientMsgId:'two',text:'Build firmware',waitForUpstream:true}));
 assert.equal(topic.firmware_job.state,'uncertain');
});
