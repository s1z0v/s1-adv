import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,writeFile,rm,stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { firmwareCapability,provisionFirmware,firmwareCommand,provisioningEnvironment,trustedFirmwarePreflight } from "./firmware-automation.mjs";
import { createHash } from "node:crypto";
import { BridgeRuntime } from "./server.mjs";

const git=(repo,...args)=>execFileSync("git",args,{cwd:repo,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),"s1-firmware-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,"repo"),remote=path.join(root,"remote.git"),state=path.join(root,"private");
  await mkdir(repo);await mkdir(remote);await mkdir(state,{mode:0o700});
  git(remote,"init","--bare");git(repo,"init","-b","main");git(repo,"config","user.name","Fixture");git(repo,"config","user.email","fixture@example.invalid");
  await mkdir(path.join(repo,"scripts"));await mkdir(path.join(repo,"bots/CardputerADV"),{recursive:true});
  await writeFile(path.join(repo,".gitignore"),".pio/\n");
  await writeFile(path.join(repo,"bots/CardputerADV/platformio.ini"),'build_flags = -DAPP_VERSION=\\"0.2.1-dev\\"\n');
  await writeFile(path.join(repo,"scripts/cardputer.py"),`from pathlib import Path\np=Path(__file__).resolve().parents[1]/'bots/CardputerADV/.pio/build/cardputer_adv/firmware.bin'\np.parent.mkdir(parents=True,exist_ok=True)\np.write_bytes(bytes([0xe9])+bytes(4095))\n`);
  git(repo,"add",".");git(repo,"commit","-m","Fixture source");git(repo,"remote","add","origin",remote);git(repo,"push","-u","origin","main");
  const configPath=path.join(state,"config.json");
  const config={server:{host:"127.0.0.1",port:0},stateDir:path.join(state,"data"),firmware:{rootDir:path.join(state,"firmware"),deviceClass:"cardputer_adv"},
    devices:[{device_token:"fixture-device-token-private-1234567890"}],firmwareAutomation:{enabled:false}};
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  await writeFile(path.join(state,"firmware.env"),"DEFAULT_HUB_HOST='bridge.example.com'\nDEFAULT_DEVICE_TOKEN='abcdef0123456789abcdef0123456789'\n",{mode:0o600});
  return {root,repo,state,configPath,config};
}

test("stock config cannot promise firmware execution; provisioning creates executable private wrappers",async t=>{
  const f=await fixture(t);
  assert.equal((await firmwareCapability(f.config)).ready,false);
  const result=await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  for(const file of Object.values(result.wrappers))assert.equal((await stat(file)).mode&0o777,0o700);
  const configured=JSON.parse(await readFile(f.configPath,"utf8"));
  assert.equal((await firmwareCapability(configured)).ready,true);
  await assert.rejects(provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"}),/already provisioned/);
});

test("release verifies clean pushed source, exclusive build ownership and served bytes before unlocking",async t=>{
  const f=await fixture(t);await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  await writeFile(path.join(f.repo,"unreviewed.txt"),"dirty");
  await assert.rejects(firmwareCommand(f.configPath,"build"),/clean source commit/);
  await rm(path.join(f.repo,"unreviewed.txt"));
  const build=await firmwareCommand(f.configPath,"build");assert.equal(build.sourceSha,git(f.repo,"rev-parse","HEAD"));
  assert.equal((await stat(path.join(f.state,"firmware-candidate.bin"))).mode&0o777,0o600);
  await assert.rejects(firmwareCommand(f.configPath,"build"),/already owns the lock/);
  await assert.rejects(firmwareCommand(f.configPath,"publish",["0.2.2-dev"]),/version must match/);
  await writeFile(path.join(f.repo,"new.txt"),"reviewed");git(f.repo,"add",".");git(f.repo,"commit","-m","Different source");
  await assert.rejects(firmwareCommand(f.configPath,"publish",["0.2.1-dev"]),/source lock/);
  git(f.repo,"reset","--hard",build.sourceSha); // Disposable fixture only.
  const published=await firmwareCommand(f.configPath,"publish",["0.2.1-dev","fixture"]);assert.equal(published.verified,false);
  const config=JSON.parse(await readFile(f.configPath,"utf8"));
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${config.devices[0].device_token}`){res.writeHead(401);res.end();return;}
    const m=JSON.parse(await readFile(path.join(config.firmware.rootDir,"cardputer_adv/manifest.json"),"utf8"));
    if(req.url==="/api/cardputer/firmware/manifest")res.end(JSON.stringify({...m,firmware_url:`http://127.0.0.1:${server.address().port}/file`}));
    else res.end(await readFile(path.join(config.firmware.rootDir,"cardputer_adv",m.filename)));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  config.server.port=server.address().port;await writeFile(f.configPath,JSON.stringify(config),{mode:0o600});
  const result=await firmwareCommand(f.configPath,"smoke");assert.equal(result.verified,true);assert.equal(result.hardwareInstalled,false);
  await assert.rejects(stat(path.join(f.state,"firmware-release.lock")));
  const release=JSON.parse(await readFile(path.join(f.state,"firmware-release.json"),"utf8"));assert.equal(release.sha256,build.sha256);
});

test("smoke verifies only the configured canonical HTTPS origin and retains the lease on rejection",async t=>{
  const f=await fixture(t);await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  const build=await firmwareCommand(f.configPath,"build");
  await firmwareCommand(f.configPath,"publish",["0.2.1-dev"]);
  const config=JSON.parse(await readFile(f.configPath,"utf8"));
  config.publicBaseUrl="https://bridge.example.invalid";
  await writeFile(f.configPath,JSON.stringify(config),{mode:0o600});
  const manifest=JSON.parse(await readFile(path.join(config.firmware.rootDir,"cardputer_adv/manifest.json"),"utf8"));
  const bytes=await readFile(path.join(config.firmware.rootDir,"cardputer_adv",manifest.filename));
  let firmwareUrl='https://unrelated.example.invalid/file',downloads=0;
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,`Bearer ${config.devices[0].device_token}`);
    if(String(url).endsWith('/manifest'))return new Response(JSON.stringify({...manifest,firmware_url:firmwareUrl}));
    downloads++;assert.equal(String(url),firmwareUrl);return new Response(bytes);
  };
  await assert.rejects(firmwareCommand(f.configPath,'smoke'),/Unexpected firmware download origin/);
  assert.equal(downloads,0);await stat(path.join(f.state,'firmware-release.lock'));
  config.publicBaseUrl='http://bridge.example.invalid';firmwareUrl=config.publicBaseUrl+'/file';
  await writeFile(f.configPath,JSON.stringify(config),{mode:0o600});
  await assert.rejects(firmwareCommand(f.configPath,'smoke'),/must use HTTPS/);
  assert.equal(downloads,0);await stat(path.join(f.state,'firmware-release.lock'));
  config.publicBaseUrl='https://bridge.example.invalid';firmwareUrl=config.publicBaseUrl+'/file';
  await writeFile(f.configPath,JSON.stringify(config),{mode:0o600});
  const result=await firmwareCommand(f.configPath,'smoke');
  assert.equal(result.verified,true);assert.equal(result.sha256,build.sha256);assert.equal(downloads,1);
  await assert.rejects(stat(path.join(f.state,'firmware-release.lock')));
});

test("provisioning is data, never sourced shell code",()=>{
  assert.deepEqual(provisioningEnvironment("DEFAULT_DEVICE_ID='cardputer-adv-01'\nDEFAULT_WIFI_SSID=''\n"),{DEFAULT_DEVICE_ID:"cardputer-adv-01",DEFAULT_WIFI_SSID:""});
  for(const text of ["DEFAULT_DEVICE_TOKEN=$(touch bad)","DEFAULT_WIFI_SSID=`date`","PATH=/tmp",'DEFAULT_WIFI_PASSWORD="a; b"'])
    assert.throws(()=>provisioningEnvironment(text),/Unsupported|unsupported/);
});

test("isolated HTTP worker trusts only an operator-owned preflight for its exact workflow",async t=>{
  const f=await fixture(t);await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  const config=JSON.parse(await readFile(f.configPath,"utf8"));
  config.firmwareAutomation.executionMode="upstream-agent";
  config.firmwareAutomation.preflightPath=path.join(f.state,"preflight.json");
  assert.equal((await firmwareCapability(config)).ready,false);
  const receipt={version:1,configSha256:createHash("sha256").update(JSON.stringify(config.firmwareAutomation)).digest("hex"),checkedAt:new Date().toISOString()};
  const file={uid:0,mode:0o100644,isFile:()=>true};
  assert.equal(trustedFirmwarePreflight(config,receipt,file),true);
  for(const metadata of [{...file,uid:1000},{...file,mode:0o100664},{...file,mode:0o100646},{...file,isFile:()=>false}])
    assert.equal(trustedFirmwarePreflight(config,receipt,metadata),false);
  assert.equal(trustedFirmwarePreflight(config,{...receipt,checkedAt:"invalid"},file),false);
  assert.equal(trustedFirmwarePreflight({...config,firmwareAutomation:{...config.firmwareAutomation,repoDir:"/different/repo"}},receipt,file),false);
  config.firmwareAutomation.executionMode="unknown";
  assert.equal((await firmwareCapability(config)).ready,false);
});

test("publisher keeps provisioned OTA private and gives the configured worker read access",async t=>{
  const f=await fixture(t);f.config.firmware.storageOwner={uid:process.getuid(),gid:process.getgid()};
  await writeFile(f.configPath,JSON.stringify(f.config));await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  await firmwareCommand(f.configPath,"build");await firmwareCommand(f.configPath,"publish",["0.2.1-dev"]);
  for(const name of ["manifest.json","cardputer-adv-0.2.1-dev.bin"]){
    const info=await stat(path.join(f.config.firmware.rootDir,"cardputer_adv",name));
    assert.equal(info.mode&0o777,0o600);assert.equal(info.uid,process.getuid());
  }
});

test("relative OTA storage cannot bypass the same-version image guard",async t=>{
  const f=await fixture(t);f.config.firmware.rootDir="./ota";
  await writeFile(f.configPath,JSON.stringify(f.config),{mode:0o600});
  await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  await firmwareCommand(f.configPath,"build");
  const destination=path.join(f.state,"ota/cardputer_adv");await mkdir(destination,{recursive:true});
  const bytes=JSON.stringify({version:"0.2.1-dev",sha256:"different-image"});
  await writeFile(path.join(destination,"manifest.json"),bytes);
  await assert.rejects(firmwareCommand(f.configPath,"publish",["0.2.1-dev"]),/different image/);
  assert.equal(await readFile(path.join(destination,"manifest.json"),"utf8"),bytes);
});

test("standalone and plugin job prompts use the provisioned repo, branch and wrappers",async t=>{
  const f=await fixture(t);await provisionFirmware(f.configPath,{repoDir:f.repo,branch:"main"});
  const runtime=Object.create(BridgeRuntime.prototype);
  runtime.config=JSON.parse(await readFile(f.configPath,"utf8"));
  runtime.config.firmware.manifestFilename="manifest.json";
  runtime.config.firmwareAutomation.branch="custom-release";
  runtime.config.firmwareAutomation.pushRemote="myfork";
  const text=runtime.buildFirmwareJobUpstreamText({device:{device_id:"fixture"},text:"Change the firmware clock"});
  const context=JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(context.job_session_contract.repo,f.repo);
  assert.equal(context.job_session_contract.branch,"custom-release");
  assert.equal(context.job_session_contract.push_remote,"myfork");
  assert.equal(context.job_session_contract.build_wrapper,runtime.config.firmwareAutomation.wrappers.build);
  assert.equal(context.firmware.capabilities.hardware.server_firmware_repo,f.repo);
  assert.doesNotMatch(text,/Fetch origin main|\/root\/\.openclaw\/workspace/);
  assert.match(text,/commit source locally BEFORE building/);
});
