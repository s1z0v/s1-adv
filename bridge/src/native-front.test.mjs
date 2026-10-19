import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registerNativeFront} from './native-front.mjs';

async function fixture(run) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'native-front-'));
 try {
  const identity=path.join(dir,'identity.json'),config=path.join(dir,'config.json');
  await writeFile(identity,JSON.stringify({deviceId:'paired-bridge-only'}));
  await writeFile(config,JSON.stringify({stateDir:dir,upstream:{deviceIdentityPath:identity},modelRouting:{enabled:true,deadlineMs:2500,
   fast:{agentId:'main',execution:'isolated-agent-runtime',model:'openai/gpt-5.6-luna',thinking:'medium'}}}));
  let handler;const calls=[],logs=[];
  const api={logger:{info:line=>logs.push(JSON.parse(line))},pluginConfig:{configPath:config},registerGatewayMethod:(name,fn,options)=>{
   assert.equal(name,'s1-adv.front');assert.equal(options.scope,'operator.write');handler=fn;},runtime:{llm:{complete:async args=>{
    calls.push(args);return {agentId:'main',provider:'openai',model:'gpt-5.6-luna',text:'{"decision":"answer","reply":"Hello."}',execution:{mode:'isolated-agent-runtime'}};
   }}}};
  assert(registerNativeFront(api));
  const request=async(params={},id='paired-bridge-only')=>{let result;
   await handler({params:{run_id:'cardputer-fast:'+'a'.repeat(64),prompt:'A bounded prompt',...params},client:{connect:{device:{id}}},respond:(...args)=>{result=args;}});return result;};
  const deadline=async value=>{const c=JSON.parse(await readFile(config,'utf8'));c.modelRouting.deadlineMs=value;await writeFile(config,JSON.stringify(c));};
  await run({calls,request,api,logs,deadline});
 } finally {await rm(dir,{recursive:true,force:true});}
}
test('native completion has literal zero tools, exact model policy and no auth/agent overrides from HTTP',()=>fixture(async f=>{
 const result=await f.request();assert(result[0]);assert.equal(result[1].tools_allowed,false);
 const call=f.calls[0];assert.equal(call.reasoning,'medium');assert.equal(call.execution.mode,'isolated-agent-runtime');
 assert.equal(call.model,'openai/gpt-5.6-luna');assert(!('authProfileId' in call.execution));
 await f.request();assert.equal(f.calls.length,1);
 assert.equal((await f.request({prompt:'changed'}))[0],false);
 for(const params of [{model:'evil/model'},{agentId:'other'},{authProfileId:'other'},{tools:['exec']},{prompt:'x'.repeat(24001)}])
  assert.equal((await f.request(params))[0],false);
 assert.equal((await f.request({},'another-client'))[0],false);assert.equal(f.calls.length,1);
}));
test('native completion has cleanup/receipt margin inside both short and default outer budgets',()=>fixture(async f=>{
 for(const [index,outer] of [250,2500,12000,15000].entries()) {
  await f.deadline(outer);
  const result=await f.request({run_id:'cardputer-fast:'+String(index+1).repeat(64)});
  assert(result[0]);const call=f.calls.at(-1);
  assert(call.execution.timeoutMs<outer);assert(call.execution.timeoutMs<=10000);
  if(outer===12000)assert.equal(call.execution.timeoutMs,10000);
 }
 assert.equal(f.logs.filter(x=>x.event==='start').length,4);
 assert.equal(f.logs.filter(x=>x.event==='complete').length,4);
 assert(f.logs.every(x=>/^cardputer-fast:[a-f0-9]{64}$/.test(x.run_id)));
}));
test('failed native calls log only safe correlation and categories, never prompt/provider secrets',()=>fixture(async f=>{
 f.api.runtime.llm.complete=async()=>{throw Object.assign(new Error('secret-token-private-prompt'),{code:'secret-token-private-code'});};
 const result=await f.request({prompt:'private-user-prompt'});
 assert.equal(result[0],false);assert.equal(result[2].code,'UNAVAILABLE');
 assert.equal(f.logs.at(-1).event,'error');assert.equal(f.logs.at(-1).error_code,'COMPLETION_FAILED');
 assert(!JSON.stringify([result,f.logs]).includes('private'));
 await f.request({prompt:'private-user-prompt'}); // same run is never executed again
 assert.equal(f.logs.filter(x=>x.event==='start').length,1);
}));
test('missing host capability fails closed without changing the agent roster',()=>{
 assert.equal(registerNativeFront({registerGatewayMethod(){throw Error('must not register');},runtime:{}}),false);
});
