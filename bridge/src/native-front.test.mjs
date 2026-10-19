import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
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
  let handler;const calls=[];
  const api={pluginConfig:{configPath:config},registerGatewayMethod:(name,fn,options)=>{
   assert.equal(name,'s1-adv.front');assert.equal(options.scope,'operator.write');handler=fn;},runtime:{llm:{complete:async args=>{
    calls.push(args);return {agentId:'main',provider:'openai',model:'gpt-5.6-luna',text:'{"decision":"answer","reply":"Hello."}',execution:{mode:'isolated-agent-runtime'}};
   }}}};
  assert(registerNativeFront(api));
  const request=async(params={},id='paired-bridge-only')=>{let result;
   await handler({params:{run_id:'cardputer-fast:'+'a'.repeat(64),prompt:'A bounded prompt',...params},client:{connect:{device:{id}}},respond:(...args)=>{result=args;}});return result;};
  await run({calls,request,api});
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
test('missing host capability fails closed without changing the agent roster',()=>{
 assert.equal(registerNativeFront({registerGatewayMethod(){throw Error('must not register');},runtime:{}}),false);
});
