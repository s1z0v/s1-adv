import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './utils.mjs';
import { FRONT_POLICY } from './semantic-front.mjs';

// This is a model-completion boundary, never an agent/tool executor. The HTTP
// worker keeps its existing Gateway scopes and cannot choose models or auth.
export function registerNativeFront(api) {
  if(!api.registerGatewayMethod || !api.runtime?.llm?.complete) return false;
  const cache=new Map();let active=0;
  api.registerGatewayMethod('s1-adv.front',async({params,client,respond})=>{
    try {
      const configPath=api.pluginConfig?.configPath;
      if(!configPath || !path.isAbsolute(configPath)) throw Error('Fast completion is not configured.');
      const config=JSON.parse(await readFile(configPath,'utf8')),roles=config.modelRouting;
      if(!roles?.enabled || roles.fast?.execution!=='isolated-agent-runtime') throw Error('Fast completion is disabled.');
      const identityPath=path.resolve(path.dirname(configPath),config.upstream?.deviceIdentityPath || path.join(config.stateDir,'upstream-device.json'));
      const identity=JSON.parse(await readFile(identityPath,'utf8'));
      if(!identity.deviceId || client?.connect?.device?.id!==identity.deviceId) throw Error('This caller does not own the bridge identity.');
      if(Object.keys(params).some(k=>!['run_id','prompt'].includes(k)) ||
          !/^cardputer-fast:[a-f0-9]{64}$/.test(params.run_id || '') ||
          typeof params.prompt!=='string' || !params.prompt.trim() || Buffer.byteLength(params.prompt)>24000)
        throw Error('Invalid bounded completion request.');
      const hash=sha256(params.prompt),key=params.run_id;
      // Only bounded in-process reuse. The bridge's durable pending record is
      // the restart fence: an uncertain completion is escalated, never resent.
      for(const [id,row] of cache) if(row.done && Date.now()-row.created>900000) cache.delete(id);
      const old=cache.get(key);
      if(old && old.hash!==hash) throw Error('Completion identity belongs to a different prompt.');
      if(old) {respond(true,await old.promise);return;}
      if(active>=2 || cache.size>=256) throw Error('Fast completion is busy.');
      const row={hash,created:Date.now(),done:false};active++;
      row.promise=(async()=>{
        try {
          const result=await api.runtime.llm.complete({agentId:roles.fast.agentId,model:roles.fast.model,
            reasoning:roles.fast.thinking,maxTokens:180,purpose:'S1-ADV bounded first response',
            systemPrompt:FRONT_POLICY,
            messages:[{role:'user',content:params.prompt}],
            execution:{mode:'isolated-agent-runtime',timeoutMs:Math.min(10000,roles.deadlineMs)}});
          if(result.agentId!==roles.fast.agentId || `${result.provider}/${result.model}`!==roles.fast.model || result.execution?.mode!=='isolated-agent-runtime' ||
              typeof result.text!=='string' || result.text.length>8192) throw Error('Unexpected completion owner or output.');
          return {runId:key,status:'ok',endedAt:Date.now(),text:result.text,model:roles.fast.model,tools_allowed:false};
        } finally {active--;row.done=true;}
      })();cache.set(key,row);
      respond(true,await row.promise);
    } catch {respond(false,undefined,{code:'UNAVAILABLE',message:'Fast completion unavailable; continue through the primary agent.'});}
  },{scope:'operator.write'});
  return true;
}
