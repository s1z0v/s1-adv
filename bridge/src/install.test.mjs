import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { planInstall, applyInstall, gatewayToken, doctor, enablePlugin, configuredAgentExists } from "./install.mjs";

test("doctor never sends a device credential to remote or malformed destinations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "s1-doctor-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gatewayConfig = path.join(root, "openclaw.json");
  await writeFile(gatewayConfig, JSON.stringify({ gateway: { auth: { token: "fixture-gateway-token-private" } }, agents: { list: [{ id: "cardputer" }] } }));
  const plan = await planInstall({ gatewayConfig, stateDir: path.join(root, "private") });
  await applyInstall(plan);
  const config = JSON.parse(await readFile(plan.configPath, "utf8"));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, upstream_connected: true, delivery_ready: true }) };
  };
  for (const host of ["bridge.example.com", "127.0.0.1.attacker.invalid", "0.0.0.0", "[::1]", "127.1"]) {
    await writeFile(plan.configPath, JSON.stringify({ ...config, server: { host, port: 31889 } }));
    const result = await doctor(plan.configPath, { fetchImpl });
    assert.equal(result.textReady, false);
    assert.equal(calls.length, 0);
  }
  for (const port of [0, -1, 65536, "31889/path", "31889@attacker.invalid"]) {
    await writeFile(plan.configPath, JSON.stringify({ ...config, server: { host: "127.0.0.1", port } }));
    await doctor(plan.configPath, { fetchImpl });
    assert.equal(calls.length, 0);
  }
  for (const [host, expectedHost] of [["localhost", "127.0.0.1"], ["127.0.0.1", "127.0.0.1"], ["::1", "[::1]"]]) {
    await writeFile(plan.configPath, JSON.stringify({ ...config, server: { host, port: 31889 } }));
    await doctor(plan.configPath, { fetchImpl });
    assert.equal(calls.at(-1).url, `http://${expectedHost}:31889/healthz`);
    assert.equal(calls.at(-1).options.redirect, "error");
  }
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(plan.configPath, 0o644);
    const before = calls.length;
    await doctor(plan.configPath, { fetchImpl });
    assert.equal(calls.length, before);
  }
});

test("doctor refuses a live HTTP redirect instead of forwarding its device token", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "s1-doctor-redirect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  let redirect = false;
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (redirect) {
      res.writeHead(302, { location: "/credential-sink" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, upstream_connected: true, delivery_ready: true }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const gatewayConfig = path.join(root, "openclaw.json");
  await writeFile(gatewayConfig, JSON.stringify({ gateway: { auth: { token: "fixture-gateway-token-private" } }, agents: { list: [{ id: "cardputer" }] } }));
  const plan = await planInstall({ gatewayConfig, stateDir: path.join(root, "private") });
  await applyInstall(plan);
  const config = JSON.parse(await readFile(plan.configPath, "utf8"));
  config.server = { host: "127.0.0.1", port: server.address().port };
  await writeFile(plan.configPath, JSON.stringify(config));
  const healthy = await doctor(plan.configPath);
  assert.equal(healthy.textReady, true);
  assert.equal(requests[0].authorization, `Bearer ${config.devices[0].device_token}`);
  redirect = true;
  const result = await doctor(plan.configPath);
  assert.deepEqual(requests.map(request => request.url), ["/healthz", "/healthz"]);
  assert.equal(result.checks.find(check => check.name === "bridge-http").ok, false);
  assert.equal(result.textReady, false);
});

test("preview writes nothing; apply isolates private configuration and repeat preserves identity", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "s1-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gatewayConfig = path.join(root, "openclaw.json");
  const original = '// JSON5 is accepted by OpenClaw\n{ gateway: { port:18789, auth:{ token:"${TEST_GATEWAY_TOKEN}" } }, agents:{list:[{id:"cardputer"}]}, channels:{privateExample:{secret:"not-to-be-copied"}} }';
  await writeFile(gatewayConfig, original);
  process.env.TEST_GATEWAY_TOKEN = "fixture-gateway-token-private";
  t.after(() => delete process.env.TEST_GATEWAY_TOKEN);
  const options = { gatewayConfig, publicUrl: "https://bridge.example.com", stateDir: path.join(root,"private") };
  const plan = await planInstall(options);
  assert.equal(plan.summary.agentExists, true);
  assert.doesNotMatch(JSON.stringify(plan.summary), /fixture-gateway|not-to-be-copied/);
  await assert.rejects(access(plan.stateDir));
  const result = await applyInstall(plan);
  assert.equal(result.applied, true);
  const bytes = await readFile(plan.configPath,"utf8");
  const config = JSON.parse(bytes);
  assert.equal(config.firmwareAutomation.enabled,false);
  assert.equal(config.devices[0].device_token.length,64);
  assert.equal(config.topics[0].session_key,"agent:cardputer:cardputer");
  assert.doesNotMatch(bytes,/not-to-be-copied|privateExample/);
  for (const name of ["config.json","firmware.env","openclaw-plugin-config.json"])
    assert.equal((await stat(path.join(plan.stateDir,name))).mode & 0o777,0o600);
  assert.equal((await stat(plan.stateDir)).mode & 0o777,0o700);
  assert.equal((await applyInstall(await planInstall(options))).applied,false);
  assert.equal(await readFile(plan.configPath,"utf8"),bytes);
  assert.equal(await readFile(gatewayConfig,"utf8"),original);
  const offline = await doctor(plan.configPath,{probe:false});
  assert.equal(offline.textReady,false); // Config validity is not a live round trip.
  assert.equal(offline.firmwareCapability.ready,false);
  assert.deepEqual(offline.focusAudio, { enabled: true, available: true, files: 3, bytes: 5112916 });
});

test("unsafe URLs, missing credentials and ambiguous agent IDs fail without leaking values", async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"s1-install-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const gatewayConfig=path.join(root,"openclaw.json");
  await writeFile(gatewayConfig,JSON.stringify({gateway:{auth:{token:"fixture-token-private"}}}));
  for(const publicUrl of ["http://bridge.example","https://secret:pass@bridge.example","https://bridge.example/path"])
    await assert.rejects(planInstall({gatewayConfig,publicUrl}),/HTTPS origin/);
  await assert.rejects(planInstall({gatewayConfig,gatewayUrl:"ws://remote.example:18789"}),/loopback/);
  await assert.rejects(planInstall({gatewayConfig,agent:"main;echo"}),/Invalid agent/);
  const missingAgent = await planInstall({gatewayConfig});
  assert.equal(missingAgent.summary.agentExists,false);
  await assert.rejects(applyInstall(missingAgent),/agent does not exist/);
  await writeFile(gatewayConfig,JSON.stringify({gateway:{auth:{token:{source:"file",id:"secret"}}}}));
  await assert.rejects(planInstall({gatewayConfig}),/token unavailable/);
  assert.equal(gatewayToken({gateway:{auth:{token:{source:"env",id:"VALUE"}}}},{VALUE:"token"}),"token");
});

test("enable previews and targets only the intended host profile and plugin membership", async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"s1-enable-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const upstream=path.join(root,"upstream.json"),host=path.join(root,"host.json");
  await writeFile(upstream,JSON.stringify({gateway:{auth:{token:"fixture-upstream-token-private"}}}));
  const llm={allowModelOverride:true,allowedCompletionModels:["openai/gpt-5.6-luna"]};
  const original=JSON.stringify({plugins:{allow:["existing"],entries:{existing:{enabled:true},"s1-adv":{llm,config:{allowRoot:false}}}},channels:{private:{enabled:true}}});
  await writeFile(host,original,{mode:0o600});
  const plan=await planInstall({gatewayConfig:upstream,stateDir:path.join(root,"bridge"),agent:"main"});
  await applyInstall(plan);
  let calls=[];
  const runCommand=(program,args,options)=>{calls.push({program,args,options});return {status:0};};
  const preview=await enablePlugin(plan.configPath,{gatewayConfigPath:host,runCommand});
  assert.equal(preview.dryRun,true);assert.equal(calls.length,0);
  assert.deepEqual(JSON.parse(preview.operations[0][3]),["existing","s1-adv"]);
  const enabled=JSON.parse(preview.operations[1][3]);assert.deepEqual(enabled.llm,llm);assert.equal(enabled.config.allowRoot,false);
  const result=await enablePlugin(plan.configPath,{apply:true,gatewayConfigPath:host,runCommand});
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.program,"openclaw");assert.equal(call.options.env.OPENCLAW_CONFIG_PATH,host);assert.match(call.args[2],/^plugins\.(allow|entries\.s1-adv)$/);}
  assert.equal(await readFile(result.backup,"utf8"),original);
  assert.equal((await stat(result.backup)).mode&0o777,0o600);
  assert.equal(await readFile(host,"utf8"),original);
  calls=[];
  const openclawCommand=[process.execPath,"/reviewed/OpenClaw/openclaw.mjs"];
  const exactPreview=await enablePlugin(plan.configPath,{gatewayConfigPath:host,runCommand,openclawCommand});
  assert.deepEqual(exactPreview.openclawCommand,openclawCommand);
  await enablePlugin(plan.configPath,{apply:true,gatewayConfigPath:host,runCommand,openclawCommand});
  assert.equal(calls.length,2);
  for(const call of calls){
    assert.equal(call.program,process.execPath);
    assert.equal(call.args[0],openclawCommand[1]);
    assert.equal(call.args[1],"config");
    assert.equal(call.options.env.OPENCLAW_CONFIG_PATH,host);
  }
});

test("native legacy list and current explicit agent maps preserve the selected identity",()=>{
  assert.equal(configuredAgentExists({agents:{list:[{id:"cardputer"}]}},"cardputer"),true);
  assert.equal(configuredAgentExists({agents:{ownership:"explicit",entries:{cardputer:{}}}},"cardputer"),true);
  assert.equal(!!configuredAgentExists({agents:{ownership:"explicit",entries:{cardputer:{}}}},"main"),false);
});
