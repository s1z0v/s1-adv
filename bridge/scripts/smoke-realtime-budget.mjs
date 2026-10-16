// Run on the Bridge host with its existing service environment. No credential output.
import { loadConfig, openRealtimeModelSocket } from "../src/server.mjs";
const config=await loadConfig();
config.realtimeVoice.s1ToolsEnabled=false;
const topic={title:"Audio budget smoke"}, device={device_id:"budget-smoke"};
for(const budget of [240,2048]) {
  await new Promise(async(resolve,reject)=>{
    const ws=await openRealtimeModelSocket(config,topic,device);
    let configured=false,requested=false,text="",bytes=0,started=0,first=0;
    const timeout=setTimeout(()=>{ws.close();reject(new Error("budget smoke timeout"));},60000);
    ws.on("error",reject);
    ws.on("message",raw=>{
      const e=JSON.parse(raw);
      if(e.type==="error") {clearTimeout(timeout);ws.close();reject(new Error(e.error?.message));return;}
      if(e.type==="session.updated"&&!configured) {
        configured=true;ws.send(JSON.stringify({type:"session.update",session:{type:"realtime",max_output_tokens:budget}}));return;
      }
      if(e.type==="session.updated"&&!requested) {
        requested=true;started=Date.now();
        ws.send(JSON.stringify({type:"conversation.item.create",item:{type:"message",role:"user",content:[{type:"input_text",text:"Посчитай от одного до двадцати медленно, до конца, без вступления."}]}}));
        ws.send(JSON.stringify({type:"response.create"}));return;
      }
      if(e.type==="response.output_audio.delta"||e.type==="response.audio.delta") {bytes+=Buffer.from(e.delta,"base64").length;first ||= Date.now();}
      if(e.type==="response.output_audio_transcript.delta"||e.type==="response.audio_transcript.delta") text+=e.delta;
      if(e.type==="response.done") {
        clearTimeout(timeout);
        console.log(JSON.stringify({budget,status:e.response.status,details:e.response.status_details,usage:e.response.usage,text,audio_seconds:bytes/48000,first_audio_ms:first-started,total_ms:Date.now()-started}));
        ws.close();resolve();
      }
    });
  });
}
