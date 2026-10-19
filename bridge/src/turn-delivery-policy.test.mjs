import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voiceReplyWaitMs, audioTerminalReady } from './turn-delivery-policy.mjs';
import { requestedReplyLanguage } from './reply-language.mjs';
import { RealtimePacingBudget } from './realtime-pacing-budget.mjs';

test('every text and voice turn stays in the persistent agent session without keyword routing',async()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/wantsFirmwareWork|CARDPUTER_FIRMWARE_WORK_RE|firmwareClarificationTopic/);
 const method=source.slice(source.indexOf('async tryFastLaneTurn('),source.indexOf('async runFirmwareWorkJob(')).trim();
 const route=new Function(`return async function ${method.slice(6)}`)();
 for(const inputMode of ['text','voice']) for(const transcript of ['Какая погода сегодня?','What firmware version is installed?','Add a TV remote','Samsung UE55','yes','нет','Build firmware'])
   assert.equal(await route({transcript,inputMode}),null);
});

test('actual STT form keeps multilingual input independent of English replies',async()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('async function transcribeOpenAiAudio('),source.indexOf('async function transcribeGeminiAudio('));
 const observed=[];
 const transcribe=new Function('fetch',`const OPENAI_API_BASE='https://example.invalid';const openAiApiKey=()=>'';const openAiHeaders=()=>({});const openAiError=()=>{throw Error('HTTP error')};${code};return transcribeOpenAiAudio;`)(async(_url,request)=>{
  observed.push(request.body);return {ok:true,json:async()=>({text:'Добавь батарею на главный экран.'})};});
 const text=await transcribe({audioBytes:Buffer.from('test'),model:'gpt-4o-mini-transcribe'});
 assert.match(text,/Добавь батарею/u);assert.equal(observed[0].get('language'),null);
 assert.match(observed[0].get('prompt'),/Cardputer ADV/);
 await transcribe({audioBytes:Buffer.from('test'),model:'gpt-4o-mini-transcribe',language:'ru'});
 assert.equal(observed[1].get('language'),'ru');
});

test('Cardputer execution context never needs a desktop chat or Mac checkout',()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 assert.match(source,/server_owned_execution:.*desktop Codex chat.*never a prerequisite/u);
 const capabilities=source.slice(source.indexOf('const CARDPUTER_FIRMWARE_CAPABILITIES'),source.indexOf('const DEVICE_ACTION_TYPES'));
 assert.match(capabilities,/firmware_repo: CARDPUTER_FIRMWARE_REPO/);
 assert.doesNotMatch(capabilities,/\/Users\//);
 assert.doesNotMatch(source,/existing OpenClaw\/Codex execution environment/);
});

test('authenticated runtime firmware reports distinguish a device boot from a published image',()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  recordDeviceFirmware('),source.indexOf('  async tryFastLaneTurn(')).trim();
 const record=new Function(`return function ${code}`)();
 const runtime={deviceFirmwareReports:new Map()},device={device_id:'test'};
 record.call(runtime,device,new URLSearchParams({firmware_version:'0.2.159-dev',firmware_git:'a'.repeat(40)}));
 assert.equal(runtime.deviceFirmwareReports.get('test').version,'0.2.159-dev');
 record.call(runtime,device,new URLSearchParams({firmware_version:'bad\nvalue',firmware_git:'secret'}));
 assert.equal(runtime.deviceFirmwareReports.size,1);assert.equal(runtime.deviceFirmwareReports.get('test').git,'a'.repeat(40));
});

test('voice upload can return a pending receipt without waiting for the full agent turn',()=>{
 assert.equal(voiceReplyWaitMs('1000',65000),1000);
 assert.equal(voiceReplyWaitMs(undefined,65000),10000);
 assert.equal(voiceReplyWaitMs('0',65000),250);
 assert.equal(voiceReplyWaitMs('99999999',65000),10000);
 assert.equal(voiceReplyWaitMs('-1',65000),10000);
 assert.equal(voiceReplyWaitMs('bad',800),800);
});

test('actual Realtime callback and pacer finish the device turn while history storage is blocked',async()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 const marker='modelWs.on("message", async (raw) => {';
 const callback=source.slice(source.indexOf(marker)+marker.length,source.indexOf('\n  modelWs.on("error"')).replace(/\n  \}\);\s*$/u,'');
 const pumpMarker='const pumpPacedAudio = () => {';
 const pump=source.slice(source.indexOf(pumpMarker)+pumpMarker.length,source.indexOf('\n  if (pacedBinaryAudio) {')).replace(/\n  \};\s*$/u,'');
 let releaseStore;const stored=[];const events=[];let now=0;
 const e={console:{info(){},warn(){}},realtimeFunctionCalls:()=>[],pendingToolResponseDone:0,s1ToolCallsInFlight:0,
  turnOpen:true,turnSequence:1,turnAudioBytes:96000,turnAudioTerminalSent:false,s1ToolUsedForTurn:false,
  responseText:'ready',inputTranscript:'hello',speechStoppedAt:0,firstAudioAt:0,sessionId:'test',
  extractDeviceActionsFromText:t=>({visibleText:t,actions:[]}),alignFocusActionMinutes:()=>[],stripMarkdownForDevice:t=>t,
  runtime:{appendDeviceText:()=>new Promise(r=>{releaseStore=r;}),appendAssistantReply:async v=>stored.push(v)},
  device:{device_id:'test'},topic:{topic_key:'test'},pacedBinaryAudio:true,pacedAudioDonePending:false,
  pacedResponseDonePending:null,pacedAudioBuffer:Buffer.alloc(48000),outputPacingBytes:1440,outputAudioSequence:0,
  audioTerminalReady,pacingBudget:new RealtimePacingBudget(24000),performance:{now:()=>now},closed:false,
  clientWs:{readyState:1},WebSocket:{OPEN:1},REALTIME_BINARY_OUTPUT_PCM:2,
  makeRealtimeBinaryFrame:(_type,_seq,chunk)=>chunk,safeWsSendBinary:()=>true,
  safeWsSend:(_ws,event)=>{events.push(event.type);return true;},stopAudioPacer:()=>{throw Error('unexpected stop');}}
 const receive=new Function('e',`with(e){return async(raw)=>{${callback}}}`)(e);
 const tick=new Function('e',`with(e){return ()=>{${pump}}}`)(e);
 const saving=receive(JSON.stringify({type:'response.done',response:{status:'completed'}}));
 assert.equal(typeof releaseStore,'function');
 assert.equal(e.pacedResponseDonePending.type,'response.done');
 assert.equal(e.pacedAudioDonePending,true);
 for(let i=0;i<200;++i){now+=20;tick();}
 assert.equal(e.pacedAudioBuffer.length,0);
 assert.deepEqual(events,['audio.done','response.done']);
 e.inputTranscript='next';e.responseText='next';e.turnSequence=2;releaseStore();await saving;
 assert.equal(stored[0].clientMsgId,'test:turn:1:assistant');
 assert.equal(stored[0].text,'ready');
});

// Keep durable queue regressions in the existing CI boundary suite.
import './turn-outbox.test.mjs';
