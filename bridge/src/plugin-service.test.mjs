import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { createBridgeService } from "./plugin-service.mjs";
import plugin from "../index.mjs";

test("native plugin registers lifecycle and CLI; disabled installation does not execute code", async()=>{
  let service,cli,spawns=0;
  plugin.register({pluginConfig:{},logger:{info(){}},registerService:s=>service=s,registerCli:c=>cli=c});
  assert.equal(service.id,"s1-adv-bridge");assert.equal(typeof cli,"function");
  await createBridgeService({}, {logger:{info(){}},spawnChild:()=>{++spawns;}}).start();
  assert.equal(spawns,0);
});
test("configured lifecycle starts once, masks credentials, and joins child termination",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"s1-service-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,"config.json"),secret="private-token-keep-server-side";
  await writeFile(configPath,JSON.stringify({server:{host:"127.0.0.1",port:31889},upstream:{token:secret}}),{mode:0o600});
  let calls=0,signals=[];const logs=[];
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=signal=>{signals.push(signal);child.emit("exit",0,signal);};
  const service=createBridgeService({configPath,autoStart:true},{logger:{info:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s)},
    spawnChild:(bin,args,options)=>{++calls;assert.equal(options.env.CARDPUTER_BRIDGE_CONFIG,configPath);assert.equal(args.length,1);assert.match(args[0],/server\.mjs$/);return child;}});
  await Promise.all([service.start(),service.start()]);assert.equal(calls,1);
  child.stdout.write(`message ${secret}\n`);child.stderr.write(`failure ${secret}\n`);
  assert.doesNotMatch(logs.join("\n"),new RegExp(secret));assert.match(logs.join("\n"),/redacted/);
  await service.stop();assert.deepEqual(signals,["SIGTERM"]);
  await service.stop();assert.deepEqual(signals,["SIGTERM"]);
});

test("stop joins an in-progress start and leaves no untracked child",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"s1-service-race-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,"config.json");await writeFile(configPath,JSON.stringify({server:{host:"127.0.0.1"}}),{mode:0o600});
  let spawned=0,terminated=0;
  const service=createBridgeService({configPath,autoStart:true},{logger:{info(){},warn(){},error(){}},spawnChild:()=>{
    ++spawned;const child=new EventEmitter();child.kill=()=>{++terminated;child.emit("exit",0,"SIGTERM");};return child;
  }});
  const starting=service.start();const stopping=service.stop();await Promise.all([starting,stopping]);
  assert.equal(spawned,1);assert.equal(terminated,1);
});
