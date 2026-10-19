import { readFile, writeFile, mkdir, chmod, stat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import JSON5 from 'json5';
import { sha256, writeJsonAtomic } from './utils.mjs';

// Preferences, not claims of account access. Installation validates the host's
// own advertised catalog before enabling either role.
export const MODEL_PRESETS = {
  codex: { fast: 'openai/gpt-5.6-luna', fastThinking: 'medium', smart: 'openai/gpt-6.1-sol', smartThinking: 'high' },
  claude: { fast: 'anthropic/claude-haiku-5-5', fastThinking: 'medium', smart: 'anthropic/claude-opus-5-5', smartThinking: 'high' }
};

async function pendingWork(config) {
  if(!config.stateDir) throw Error('Configure private stateDir before changing models.');
  let state;try{state=JSON.parse(await readFile(path.join(config.stateDir,'state.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return {primary:0,front:0};throw Error('Cannot audit accepted work before model configuration.');}
  const session=config.topics?.find(t=>t.topic_key===config.devices?.[0]?.default_topic_key)?.session_key || config.topics?.[0]?.session_key;
  const queue=state.turn_outbox?.entries || [],front=state.front_turns?.entries || {};
  if(state.turn_outbox&&state.turn_outbox.version!==1 || state.front_turns&&state.front_turns.version!==1 ||
      !Array.isArray(queue) || !front || typeof front!=='object' || Array.isArray(front))throw Error('Unsupported delivery state; preserve it for review.');
  const known=new Set(queue.map(e=>e.id));
  const legacy=Object.values(state.idempotency || {}).filter(ack=>{
    if(!ack?.upstream_run_id || ack.upstream_terminal ||
        state.topics?.[ack.topic_key]?.session_key!==session ||
        !config.topics?.some(t=>t.topic_key===ack.topic_key&&t.session_key===session))return false;
    const message=state.messages?.[ack.topic_key]?.find(m=>m.id===ack.message_id);
    const device=config.devices.find(d=>message?.sender?.id===`cardputer:${d.device_id}`&&d.topics?.includes(ack.topic_key));
    return !!device&&!known.has(`cardputer:${device.device_id}:${ack.topic_key}:${ack.client_msg_id}`);
  }).length;
  return {primary:legacy+queue.filter(e=>e.session_key===session&&e.phase!=='terminal').length,
    front:Object.values(front).filter(e=>e.session_key===session&&
      (e.phase==='pending'||e.phase==='held'||e.phase==='escalated'&&!e.main_enqueued)).length};
}

async function assertQuiescent(config) {
  const host=config.server?.host,port=config.server?.port;
  if(!['127.0.0.1','::1','localhost'].includes(host)||!Number.isInteger(port)||port<1||port>65535)
    throw Error('Model setup requires the intended loopback bridge address.');
  for(const address of host==='localhost'?['127.0.0.1','::1']:[host])await new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:address,port});
    const finish=error=>{socket.destroy();error?reject(error):resolve();};
    socket.once('connect',()=>finish(Error('Stop the intended bridge before applying model roles. No configuration changed.')));
    socket.once('error',error=>finish(error.code==='ECONNREFUSED'?null:Error('Cannot verify that the intended bridge is stopped.')));
    socket.setTimeout(500,()=>finish(Error('Cannot verify that the intended bridge is stopped.')));
  });
  const pending=await pendingWork(config);
  if(pending.primary || pending.front)throw Error('Accepted work is unfinished or held in this session. Complete or audit it before changing models.');
}

export function readModelCatalog(command = ['openclaw']) {
  const result=spawnSync(command[0],[...command.slice(1),'models','list','--all','--json'],{encoding:'utf8',timeout:30000});
  if(result.status!==0) throw new Error('Cannot read the intended OpenClaw model catalog. Run models list on that host.');
  let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw new Error('OpenClaw did not return a model catalog.');}
  if(!Array.isArray(parsed.models)) throw new Error('Unsupported OpenClaw model catalog.');
  return parsed.models;
}

export async function planModelRoles(configPath, options={}, { catalog, openclawCommand=['openclaw'] }={}) {
  const absolute=await realpath(path.resolve(configPath)), text=await readFile(absolute,'utf8'), config=JSON.parse(text);
  const auditConfig={...config,stateDir:config.stateDir?path.resolve(path.dirname(absolute),config.stateDir):null};
  const gatewayPath=await realpath(path.resolve(options.gatewayConfig || config.installation?.gatewayConfigPath || ''));
  if(gatewayPath===absolute) throw new Error('Bridge and Gateway configuration must be distinct files.');
  if(!config.installation?.gatewayConfigPath && !options.gatewayConfig) throw new Error('Choose the intended Gateway config explicitly.');
  const gatewayText=await readFile(gatewayPath,'utf8'),gateway=JSON5.parse(gatewayText);
  const profile=options.modelProfile || config.modelRouting?.profile || 'codex', preset=MODEL_PRESETS[profile];
  if(!preset) throw new Error('Model profile must be codex or claude.');
  const smartAgent=config.installation?.agentId || config.topics?.[0]?.session_key?.split(':')[1];
  if(!smartAgent || config.devices?.length!==1) throw new Error('Configure one device and its existing primary agent first.');
  const primary=gateway.agents?.entries?.[smartAgent] || (gateway.agents?.list || []).find(a=>a.id===smartAgent);
  if(!primary && !(smartAgent==='main' && gateway.agents?.ownership!=='explicit'))
    throw new Error('The configured primary agent does not exist.');
  const currentModel=typeof primary?.model==='string' ? primary.model : primary?.model?.primary;
  const defaults=typeof gateway.agents?.defaults?.model==='string' ? gateway.agents.defaults.model : gateway.agents?.defaults?.model?.primary;
  const retained=config.modelRouting?.profile===profile ? config.modelRouting : null;
  const fastModel=options.fastModel || retained?.fast?.model || preset.fast;
  const smartModel=options.smartModel || retained?.smart?.model || (profile==='codex' ? currentModel || defaults : null) || preset.smart;
  const models=catalog || readModelCatalog(openclawCommand);
  const available=model=>models.some(m=>(m.key || m.id)===model && m.available===true);
  const unavailable=[fastModel,smartModel].filter(model=>!available(model));
  const deadlineMs=Number(options.fastDeadlineMs || config.modelRouting?.deadlineMs || 8000);
  if(!Number.isInteger(deadlineMs) || deadlineMs<250 || deadlineMs>10000) throw new Error('Fast deadline must be 250..10000 milliseconds.');
  const routing={enabled:true,profile,deadlineMs,maxEntries:2048,
    fast:{agentId:smartAgent,execution:'isolated-agent-runtime',model:fastModel,thinking:options.fastThinking || retained?.fast?.thinking || preset.fastThinking},
    smart:{agentId:smartAgent,model:smartModel,thinking:options.smartThinking || retained?.smart?.thinking || primary?.thinkingDefault || gateway.agents?.defaults?.thinkingDefault || preset.smartThinking}};
  for(const role of [routing.fast,routing.smart])
    if(!['off','minimal','low','medium','high','xhigh'].includes(role.thinking)) throw new Error('Unsupported thinking level.');
  const updated=structuredClone(gateway);
  // Keep the roster, ownership and all permissions intact. The host's isolated
  // completion API provides a fresh literal-zero-tool runtime, not a new agent.
  const selected=updated.agents?.entries?.[smartAgent] || updated.agents?.list?.find(a=>a.id===smartAgent);
  if(!selected) throw new Error('Create an explicit primary agent entry in OpenClaw before configuring model roles.');
  const primaryModelChanged=smartModel!==(currentModel || defaults);
  if(primaryModelChanged) selected.model=typeof selected.model==='object' ? {...selected.model,primary:smartModel} : smartModel;
  if(options.smartThinking) selected.thinkingDefault=routing.smart.thinking;
  updated.plugins ||= {};updated.plugins.entries ||= {};updated.plugins.entries['s1-adv'] ||= {};
  updated.plugins.entries['s1-adv'].llm={allowModelOverride:true,allowedModels:[fastModel],
    allowedCompletionModels:[fastModel],allowAgentIdOverride:true,allowAuthProfileOverride:false};
  return {configPath:absolute,gatewayPath,config,auditConfig,gateway:updated,routing,
    configHash:sha256(text),gatewayHash:sha256(gatewayText),unavailable,
    summary:{profile,fast:routing.fast,smart:routing.smart,deadlineMs,available:unavailable.length===0,unavailable,
      writes:['private bridge modelRouting','this plugin completion allowlist for the exact fast model','selected primary agent thinking/model preferences'],
      requiresStoppedBridge:true,pendingAcceptedWork:await pendingWork(auditConfig),
      primaryModelChanged,primaryPermissionsUnchanged:true,agentRosterUnchanged:true,providerCredentialsUnchanged:true,restartRequired:true}};
}

export async function applyModelRoles(plan,{openclawCommand=['openclaw'],validateGateway}={}) {
  if(plan.unavailable.length) throw new Error('Selected models are unavailable on this host: '+plan.unavailable.join(', ')+'. Configure the provider or choose advertised available models; no credentials were copied.');
  await assertQuiescent(plan.auditConfig);
  for(const file of [plan.configPath,plan.gatewayPath])
    if(process.platform!=='win32' && ((await stat(file)).mode & 0o077)) throw new Error('Model setup requires private mode-0600 configuration files.');
  if(sha256(await readFile(plan.configPath,'utf8'))!==plan.configHash || sha256(await readFile(plan.gatewayPath,'utf8'))!==plan.gatewayHash)
    throw new Error('Configuration changed since preview. Plan again; nothing was overwritten.');
  const backup=path.join(path.dirname(plan.configPath),'model-role-backups',String(Date.now()));
  await mkdir(backup,{recursive:true,mode:0o700});await chmod(backup,0o700);
  await writeFile(path.join(backup,'bridge.json'),await readFile(plan.configPath),{mode:0o600,flag:'wx'});
  await writeFile(path.join(backup,'gateway.json'),await readFile(plan.gatewayPath),{mode:0o600,flag:'wx'});
  const candidate=path.join(backup,'gateway-candidate.json');await writeJsonAtomic(candidate,plan.gateway);
  if(validateGateway) await validateGateway(candidate);
  else {
    const check=spawnSync(openclawCommand[0],[...openclawCommand.slice(1),'config','validate','--json'],{
      env:{...process.env,OPENCLAW_CONFIG_PATH:candidate},encoding:'utf8',timeout:30000});
    await writeFile(path.join(backup,'validation.json'),check.stdout || check.stderr || '',{mode:0o600});
    if(check.status!==0) throw new Error('The intended OpenClaw host rejected the candidate configuration. Original files retained.');
  }
  if(sha256(await readFile(plan.configPath,'utf8'))!==plan.configHash || sha256(await readFile(plan.gatewayPath,'utf8'))!==plan.gatewayHash)
    throw new Error('Configuration changed during validation. Original configuration retained.');
  await assertQuiescent(plan.auditConfig);
  await writeJsonAtomic(plan.gatewayPath,plan.gateway);
  await writeJsonAtomic(plan.configPath,{...plan.config,modelRouting:plan.routing});
  return {...plan.summary,applied:true,backup,notes:['No service was restarted. Reload the intended Gateway and bridge after reviewing this configuration.']};
}
