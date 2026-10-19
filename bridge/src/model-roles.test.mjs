import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,mkdir} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {planModelRoles,applyModelRoles,MODEL_PRESETS} from './model-roles.mjs';

async function fixture(run,agents={entries:{main:{workspace:'/private/existing'}},defaults:{model:{primary:'openai/gpt-6.1-sol'}}}) {
 const root=await mkdtemp(path.join(os.tmpdir(),'s1-model-roles-'));
 try {
  const gatewayPath=path.join(root,'gateway.json'),configPath=path.join(root,'bridge.json');
  const gateway={agents,channels:{existing:{enabled:true}},gateway:{auth:{token:'private-existing-gateway-token'}}};
  const config={stateDir:path.join(root,'state'),server:{host:'127.0.0.1',port:1},devices:[{device_id:'test',topics:['main']}],topics:[{topic_key:'main',session_key:'agent:main:cardputer'}],
    installation:{agentId:'main',gatewayConfigPath:gatewayPath}};
  await writeFile(gatewayPath,JSON.stringify(gateway),{mode:0o600});await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const catalog=[{key:'openai/gpt-5.6-luna',available:true},{key:'openai/gpt-6.1-sol',available:true}];
  await run({root,gatewayPath,configPath,gateway,config,catalog});
 }finally{await rm(root,{recursive:true,force:true});}
}

test('role preview and apply preserve primary/default agent, tools, channels and credentials',()=>fixture(async f=>{
 const plan=await planModelRoles(f.configPath,{fastThinking:'low'},f);
 assert(plan.summary.available);assert.equal(plan.routing.fast.thinking,'low');assert.equal(plan.routing.smart.thinking,'high');
 assert.deepEqual(JSON.parse(await readFile(f.gatewayPath,'utf8')),f.gateway);
 assert.deepEqual(Object.keys(plan.gateway.agents.entries),['main']);
 assert.deepEqual(plan.gateway.agents.entries.main,f.gateway.agents.entries.main);
 assert.equal(plan.routing.fast.execution,'isolated-agent-runtime');
 assert.deepEqual(plan.gateway.plugins.entries['s1-adv'].llm.allowedCompletionModels,['openai/gpt-5.6-luna']);
 const result=await applyModelRoles(plan,{validateGateway:async()=>{}});assert(result.applied);
 const saved=JSON.parse(await readFile(f.gatewayPath,'utf8'));
 assert.deepEqual(saved.channels,f.gateway.channels);assert.deepEqual(saved.gateway,f.gateway.gateway);
 assert.deepEqual(saved.agents.defaults,f.gateway.agents.defaults);
 const second=await planModelRoles(f.configPath,{},f);
 assert.equal(second.routing.fast.thinking,'low');
 assert.deepEqual(second.gateway.agents.entries,plan.gateway.agents.entries);assert.equal(second.routing.fast.agentId,'main');
}));

test('existing main permissions are untouched; unavailable Claude models fail closed',()=>fixture(async f=>{
 const plan=await planModelRoles(f.configPath,{},f);
 assert.deepEqual(plan.gateway.agents.list[0],f.gateway.agents.list[0]);
 const claude=await planModelRoles(f.configPath,{modelProfile:'claude'},f);
 assert.deepEqual(claude.unavailable,[MODEL_PRESETS.claude.fast,MODEL_PRESETS.claude.smart]);
 await assert.rejects(applyModelRoles(claude,{validateGateway:async()=>{}}),/unavailable/);
},{list:[{id:'main',default:true,model:'openai/gpt-6.1-sol',tools:{allow:['exec']}}]}));

test('private-file and concurrent-configuration guards prevent partial overwrites',()=>fixture(async f=>{
 const plan=await planModelRoles(f.configPath,{},f);await chmod(f.configPath,0o644);
 await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/private/);
 await chmod(f.configPath,0o600);await writeFile(f.gatewayPath,JSON.stringify({...f.gateway,meta:{changed:true}}));
 await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/changed since preview/);
 assert(!JSON.parse(await readFile(f.configPath,'utf8')).modelRouting);
}));

test('model changes require a stopped bridge and a completed current session, preserving unrelated legacy holds',()=>fixture(async f=>{
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 f.config.server.port=server.address().port;await writeFile(f.configPath,JSON.stringify(f.config));
 try {
  const plan=await planModelRoles(f.configPath,{},f);
  await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/Stop the intended bridge/);
 } finally {await new Promise(resolve=>server.close(resolve));}
 await mkdir(f.config.stateDir);const state=path.join(f.config.stateDir,'state.json');
 await writeFile(state,JSON.stringify({turn_outbox:{version:1,entries:[{session_key:'agent:main:cardputer',phase:'inflight'}]}}));
 let plan=await planModelRoles(f.configPath,{},f);assert.equal(plan.summary.pendingAcceptedWork.primary,1);
 await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/unfinished or held/);
 await writeFile(state,JSON.stringify({front_turns:{version:1,entries:{one:{session_key:'agent:main:cardputer',phase:'pending'}}}}));
 plan=await planModelRoles(f.configPath,{},f);assert.equal(plan.summary.pendingAcceptedWork.front,1);
 await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/unfinished or held/);
 await writeFile(state,JSON.stringify({turn_outbox:{version:1,entries:[{session_key:'agent:legacy:other',phase:'held'}]}}));
 plan=await planModelRoles(f.configPath,{},f);assert.equal(plan.summary.pendingAcceptedWork.primary,0);
 assert((await applyModelRoles(plan,{validateGateway:async()=>{}})).applied);
}));

test('model changes audit unresolved owned legacy acknowledgements before outbox adoption',()=>fixture(async f=>{
 await mkdir(f.config.stateDir);const state=path.join(f.config.stateDir,'state.json');
 const ack={topic_key:'main',client_msg_id:'legacy-one',message_id:'m1',upstream_run_id:'r1',upstream_accepted:true};
 const data={topics:{main:{session_key:'agent:main:cardputer'}},messages:{main:[{id:'m1',sender:{id:'cardputer:test'}}]},idempotency:{one:ack}};
 await writeFile(state,JSON.stringify(data));let plan=await planModelRoles(f.configPath,{},f);
 assert.equal(plan.summary.pendingAcceptedWork.primary,1);
 await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/unfinished or held/);
 data.topics.main.session_key='agent:legacy:other';await writeFile(state,JSON.stringify(data));
 plan=await planModelRoles(f.configPath,{},f);assert.equal(plan.summary.pendingAcceptedWork.primary,0);
 assert((await applyModelRoles(plan,{validateGateway:async()=>{}})).applied);
}));

test('localhost model preflight also refuses a running IPv6 bridge',()=>fixture(async f=>{
 const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'::1',resolve);});
 f.config.server={host:'localhost',port:server.address().port};await writeFile(f.configPath,JSON.stringify(f.config));
 try {
  const plan=await planModelRoles(f.configPath,{},f);
  await assert.rejects(applyModelRoles(plan,{validateGateway:async()=>{}}),/Stop the intended bridge/);
 } finally {await new Promise(resolve=>server.close(resolve));}
}));
