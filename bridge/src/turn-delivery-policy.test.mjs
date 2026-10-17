import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voiceReplyWaitMs, audioTerminalReady } from './turn-delivery-policy.mjs';
import { requestedReplyLanguage } from './reply-language.mjs';
import { RealtimePacingBudget } from './realtime-pacing-budget.mjs';

test('actual firmware routing owns voice UI changes once without a desktop chat dependency',async()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 const re=source.slice(source.indexOf('const CARDPUTER_FIRMWARE_WORK_RE ='),source.indexOf('const CARDPUTER_PRIMARY_TOPIC_TITLE'));
 const wants=source.slice(source.indexOf('function wantsFirmwareWork('),source.indexOf('function requestedFirmwareVersion('));
 const classifier=new Function(`${re}\n${wants}\nreturn wantsFirmwareWork;`)();
 assert(classifier('С главного экрана убери индикатор AMPM'));
 assert(classifier('Develop and publish new firmware'));
 assert(!classifier('Какая погода сегодня?'));
 const method=source.slice(source.indexOf('async tryFastLaneTurn('),source.indexOf('async runFirmwareWorkJob(')).trim();
 const route=new Function('wantsFirmwareWork','languageNameForText',`return async function ${method.slice(6)}`)(classifier,requestedReplyLanguage);
 let jobs=0,sends=0,replies=0;
 const runtime={primaryCardputerTopicForDevice:()=>({topic_key:'main'}),createFirmwareJobTopicForDevice:async()=>{++jobs;return {topic_key:'job'};},
  sendText:async v=>{++sends;assert.equal(v.topicKey,'job');assert.equal(v.waitForUpstream,false);return {seq:1};},
  buildFirmwareJobUpstreamText:()=>'',appendAssistantReply:async v=>{++replies;assert.doesNotMatch(v.text,/[А-Яа-яЁё]/u);return {};},buildTurnResponse:async()=>({ok:true})};
 const result=await route.call(runtime,{device:{device_id:'test'},topic:{topic_key:'main'},transcript:'убери индикатор с главного экрана',inputMode:'voice'});
 assert.equal(result.response.ok,true);assert.deepEqual([jobs,sends,replies],[1,1,1]);
 assert.equal(await route.call(runtime,{transcript:'hello',inputMode:'voice'}),null);
 assert.deepEqual([jobs,sends,replies],[1,1,1]);
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
