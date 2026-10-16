import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { wireRealtimeBridge, BridgeRuntime, buildDeviceTurnEnvelope } from "../src/server.mjs";
import { voiceThinking, unwrapCardputerEnvelope } from "../src/turn-delivery-policy.mjs";

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(data, options, callback) { this.sent.push(Buffer.isBuffer(data) ? data : JSON.parse(data)); const cb=callback || options; if(typeof cb==="function")cb(); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit("close", 1000, Buffer.alloc(0)); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let cases = 0;
for (const text of ["Какая погода на Пхукете?", "Привет!", "Сколько будет два плюс два?"]) {
  assert.equal(voiceThinking(text, "voice"), "low"); cases++;
}
for (const text of ["Добавь таймер в прошивку", "Продолжай", "Сделай это", "fix the firmware", "Подробно проанализируй проблему"]) {
  assert.equal(voiceThinking(text, "voice"), undefined); cases++;
}
const text = "Какая погода?";
const envelope = buildDeviceTurnEnvelope({context: {session: "same"}, policy: {full: true}, text, inputMode: "voice", compact: true});
assert.equal(unwrapCardputerEnvelope(envelope), text);
assert.equal(unwrapCardputerEnvelope('{"user":"my JSON"}'), '{"user":"my JSON"}');
assert.equal(await BridgeRuntime.prototype.tryFastLaneTurn.call({}, {inputMode:"voice",transcript:"Добавь фичу"}), null);
cases += 3;

for (const bytes of [0, 2, 1440, 48000]) {
  for (const audioDone of [false, true]) {
    const client = new Socket(), model = new Socket();
    await wireRealtimeBridge({clientWs:client, device:{device_id:"host-test"},topic:{topic_key:"test"},
      runtime:{appendAssistantReply:async()=>{},appendDeviceText:async()=>{}},
      config:{realtimeVoice:{sampleRate:24000,s1ToolsEnabled:false,maxSessionMs:30000}},
      binaryAudio:true,firmwareVersion:"0.2.145-dev",openModelSocket:async()=>model});
    if (bytes) model.emit("message", JSON.stringify({type:"response.output_audio.delta",delta:Buffer.alloc(bytes).toString("base64")}));
    if (audioDone) model.emit("message",JSON.stringify({type:"response.output_audio.done"}));
    model.emit("message",JSON.stringify({type:"response.done",response:{status:"completed"}}));
    await sleep(1);
    if (bytes) assert.equal(client.sent.some(e=>e.type==="response.done"),false,"must hold terminal behind PCM");
    await sleep(Math.ceil(bytes/960)*20+100);
    const terminal = client.sent.findIndex(e=>e.type==="response.done");
    assert.ok(terminal>=0);
    assert.equal(client.sent.filter(Buffer.isBuffer).reduce((sum,b)=>sum+b.length-8,0),bytes);
    assert.ok(client.sent.slice(terminal+1).every(e=>!Buffer.isBuffer(e)),"no PCM after terminal");
    if(audioDone) assert.ok(client.sent.findIndex(e=>e.type==="audio.done")<terminal);
    client.close(); cases++;
  }
}
// Disconnect/backpressure must discard pending terminals instead of replaying.
for(const fault of ["disconnect","backpressure"]) {
  const client = new Socket(), model = new Socket();
  await wireRealtimeBridge({clientWs:client,device:{device_id:"host-test"},topic:{topic_key:"test"},
    runtime:{appendAssistantReply:async()=>{}},config:{realtimeVoice:{s1ToolsEnabled:false}},
    binaryAudio:true,firmwareVersion:"0.2.145-dev",openModelSocket:async()=>model});
  model.emit("message",JSON.stringify({type:"response.output_audio.delta",delta:Buffer.alloc(8000).toString("base64")}));
  model.emit("message",JSON.stringify({type:"response.done",response:{status:"completed"}}));
  if(fault==="disconnect") client.close(); else client.bufferedAmount=600000;
  await sleep(70);
  assert.equal(client.sent.some(e=>e.type==="response.done"),false);
  client.close();cases++;
}
const source=readFileSync(new URL("../src/server.mjs",import.meta.url),"utf8");
assert.match(source,/max_output_tokens: 2048/);
assert.match(source,/if \(thinking\) params.thinking = thinking/);
assert.doesNotMatch(source,/Got it\. I will send the answer/);
assert.match(source,/replyText: "",\s+includeAudio: false/);
console.log(`PASS delivery integration (${cases+4} cases; actual wireRealtimeBridge)`);
