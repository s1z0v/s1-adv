import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";
import { encodeMininervaFrame, decodeMininervaFrame } from "./mininerva-compat.mjs";
import { agentIdForSession, validateDeviceTokens, validateUpstreamTransport } from "./security-policy.mjs";
import { StateStore } from "./state-store.mjs";
import { BridgeRuntime, transcode } from "./server.mjs";
import { PrivateStorageBudget } from "./storage-budget.mjs";

test("bundled Focus cues use the authenticated asset API with exact bytes and language", () => withBridge(async ({ base, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/api/cardputer/assets/manifest`)).status, 401);
  const manifest = await (await fetch(`${base}/api/cardputer/assets/manifest`, { headers })).json();
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.files.reduce((sum, file) => sum + file.size, 0), 5112916);
  for (const language of ["en"]) for (const cue of ["start", "break", "reflection"]) {
    const file = manifest.files.find(row => row.path === `/pomodoro/audio/${language}/${cue}.wav`);
    assert.equal(file.language, language);
    assert.equal((await fetch(file.url)).status, 401);
    const response = await fetch(file.url, { headers });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, file.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(response.headers.get("x-content-sha256"), file.sha256);
  }
  for (const file of ["ru/start.wav", "ru/break.wav", "ru/reflection.wav", "en/unknown.wav", "en/start.wav.owner.json", "manifest.json", "focus-audio/manifest.json"])
    assert.equal((await fetch(`${base}/api/cardputer/assets/file/${file}`, { headers })).status, 404);
}));

test("private overrides and manually added language assets remain available without automatic downloads", () => withBridge(async ({ base, token, config }) => {
  const root = path.join(config.assets.rootDir, config.assets.deviceClass, "audio", "en");
  await mkdir(root, { recursive: true });
  const original = await readFile(new URL("../assets/focus-audio/en/break.wav", import.meta.url));
  await writeFile(path.join(root, "start.wav"), original);
  const optionalRoot = path.join(root, "..", "ru");
  await mkdir(optionalRoot);
  const optional = Buffer.from(original); // Known WAV bytes stand in for a manual language asset.
  await writeFile(path.join(optionalRoot, "start.wav"), optional);
  const headers = { authorization: `Bearer ${token}` };
  const manifest = await (await fetch(`${base}/api/cardputer/assets/manifest`, { headers })).json();
  assert.equal(manifest.files.length, 4);
  const entry = manifest.files.find(file => file.path === "/pomodoro/audio/en/start.wav");
  assert.equal(entry.size, original.length);
  assert.equal(entry.language, "en");
  assert.deepEqual(Buffer.from(await (await fetch(entry.url, { headers })).arrayBuffer()), original);
  assert.deepEqual(await readFile(path.join(root, "start.wav")), original);
  assert.deepEqual(await readdir(root), ["start.wav"]);
  const ru = manifest.files.find(file => file.path === "/pomodoro/audio/ru/start.wav");
  assert.equal(ru.language, "ru");
  assert.deepEqual(Buffer.from(await (await fetch(ru.url, { headers })).arrayBuffer()), optional);
}));

test("disabling bundled cues leaves private asset service available", () => withBridge(async ({ base, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const manifest = await (await fetch(`${base}/api/cardputer/assets/manifest`, { headers })).json();
  assert.deepEqual(manifest.files, []);
  assert.equal((await fetch(`${base}/api/cardputer/assets/file/en/start.wav`, { headers })).status, 404);
}, {}, { assets: { bundledFocusAudio: false } }));

const root = fileURLToPath(new URL("../", import.meta.url));
const token = "test-only-device-token-00000000000000000000000000000001";

async function withBridge(run, security = {}, extra = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "s1-adv-security-"));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = JSON.parse(await readFile(path.join(root, "config.example.json"), "utf8"));
  config.server.port = port;
  config.stateDir = path.join(tmp, "state");
  config.media = Object.fromEntries(["inboundDir", "canonicalDir", "playbackDir", "tmpDir"].map(key => [key, path.join(tmp, key)]));
  config.assets.rootDir = path.join(tmp, "assets");
  config.assets.logsDir = path.join(tmp, "logs");
  config.firmware.rootDir = path.join(tmp, "firmware");
  config.upstream.url = "ws://127.0.0.1:1";
  config.upstream.token = "test-only-gateway-token-00000000000000000000000000001";
  config.devices[0].device_token = token;
  config.security = { ...config.security, ...security };
  extra = { ...extra, ...(extra.assets ? { assets: { ...config.assets, ...extra.assets } } : {}) };
  Object.assign(config, extra);
  const configPath = path.join(tmp, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root, env: { ...process.env, CARDPUTER_BRIDGE_CONFIG: configPath }, stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", chunk => { log = (log + chunk).slice(-12000); });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-12000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(`bridge exited during startup: ${log}`);
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch {}
      if (ready) break;
      await sleep(50);
    }
    assert.ok(ready, `bridge not ready: ${log}`);
    await run({ base, port, child, token, config, tmp });
    await sleep(75);
    assert.equal(child.exitCode, null, `bridge crashed: ${log}`);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
    await rm(tmp, { recursive: true, force: true });
  }
}

async function sendWs(base, route, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http:", "ws:") + route, options);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("websocket timeout")); }, 2500);
    ws.on("open", () => { if (payload !== undefined) ws.send(payload); });
    ws.on("message", () => ws.close());
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); res.resume(); resolve(res.statusCode); });
    ws.on("close", () => { clearTimeout(timer); resolve(101); });
    ws.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

test("unauthenticated null feed frame cannot crash the bridge", () => withBridge(async ({ base }) => {
  await sendWs(base, "/api/cardputer/v1/stream", "null");
}));

test("unauthenticated null compatibility payload cannot crash the bridge when explicitly enabled", () => withBridge(async ({ base }) => {
  await sendWs(base, "/compat/mininerva/ws", encodeMininervaFrame("auth", null));
}, {}, {mininervaCompat:{enabled:true}}));

test("legacy compatibility transport is closed by default", () => withBridge(async ({base}) => {
  assert.equal(await sendWs(base,"/compat/mininerva/ws",undefined),404);
}));

test("malformed Host on upgrade cannot crash the bridge", () => withBridge(async ({ port }) => {
  await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(
      "GET /api/cardputer/v1/stream HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ));
    socket.on("data", () => {});
    socket.on("close", resolve);
    socket.on("error", reject);
    socket.setTimeout(2500, () => socket.destroy());
  });
}));

test("browser origins are denied on every WebSocket route by default", () => withBridge(async ({ base }) => {
  for (const route of ["/api/cardputer/v1/stream", "/api/cardputer/v1/realtime", "/compat/mininerva/ws"]) {
    assert.equal(await sendWs(base, route, undefined, { origin: "https://untrusted.example" }), 403);
  }
}));

test("internal OTA is disabled by default, including through a proxy", () => withBridge(async ({ base, token }) => {
  for (const headers of [{}, { "x-forwarded-for": "203.0.113.1", "x-forwarded-proto": "https" }]) {
    const response = await fetch(`${base}/internal/cardputer/ota-install`, {
      method: "POST", headers: { ...headers, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: "0.2.1-dev" })
    });
    assert.equal(response.status, 404);
  }
}));

test("even enabled internal OTA rejects forwarded requests", () => withBridge(async ({ base, token }) => {
  const response = await fetch(`${base}/internal/cardputer/ota-install`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.1" }, body: "{}"
  });
  assert.equal(response.status, 404);
}, { internalOtaEnabled: true }));

test("compatibility authentication failures share the normal rate limit", () => withBridge(async ({ base }) => {
  for (let i = 0; i < 5; i++) {
    await sendWs(base, "/compat/mininerva/ws", encodeMininervaFrame("auth", { api_key: "wrong" }));
  }
  assert.equal(await sendWs(base, "/compat/mininerva/ws", undefined), 429);
}, { authFailureLimit: 5 }, {mininervaCompat:{enabled:true}}));

test("unauthenticated WebSocket connection count is bounded", () => withBridge(async ({ base }) => {
  const sockets = [];
  try {
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(base.replace("http:", "ws:") + "/api/cardputer/v1/stream");
      sockets.push(ws);
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    }
    assert.equal(await sendWs(base, "/compat/mininerva/ws", undefined), 429);
  } finally { for (const ws of sockets) ws.terminate(); }
}, { maxWsConnectionsPerIp: 2 }));

test("costly authenticated requests have a rate limit", () => withBridge(async ({ base, token }) => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(`${base}/api/device-tts`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}"
    })).status, 400);
  }
  assert.equal((await fetch(`${base}/api/device-tts`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}"
  })).status, 429);
}, { requestStartLimitPerDevice: 5 }));

test("placeholder, duplicate and gateway-reused device credentials are rejected", () => {
  for (const value of ["", "12345678", "REPLACE_WITH_RANDOM_DEVICE_TOKEN"]) {
    assert.throws(() => validateDeviceTokens({ devices: [{ device_token: value }] }));
  }
  assert.throws(() => validateDeviceTokens({ devices: [{ device_token: token }], upstream: { token } }));
  assert.throws(() => validateDeviceTokens({ devices: [{ device_token: token }, { device_token: token }] }));
  validateDeviceTokens({ devices: [{ device_token: token }], upstream: { token: "different" } });
});

test("independent device principals cannot share audio and provisioned OTA storage", () => {
  assert.throws(()=>validateDeviceTokens({devices:[{device_token:token},{device_token:token+"second"}]}),/exactly one device identity/);
});

test("legacy mixed-device state is refused before it can be normalized or served",async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),"s1-mixed-state-"));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const data=JSON.stringify({devices:{a:{},b:{}}});await writeFile(path.join(tmp,"state.json"),data);
  const runtime=Object.create(BridgeRuntime.prototype);runtime.config={stateDir:tmp};
  await assert.rejects(runtime.start(),/Legacy multi-device data/);
  assert.equal(await readFile(path.join(tmp,"state.json"),"utf8"),data);
});

test("private spoken replies require the current topic and session, including after remap",async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),"s1-asset-acl-"));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const runtime=Object.create(BridgeRuntime.prototype);
  runtime.config={assets:{rootDir:tmp,deviceClass:"cardputer_adv",replyCategory:"ai_answers",maxFileBytes:1000,maxManifestFiles:20,maxManifestBytes:10000}};
  let session="agent:cardputer:old";runtime.store={getTopic:key=>key==="private"?{session_key:session}:null};
  const file=path.join(tmp,"cardputer_adv/audio/ai_answers/reply.wav");await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,Buffer.alloc(44));
  const device={topics:["private"]},other={topics:["other"]};
  assert.equal(runtime.resolveAssetDownload(device,"ai_answers/reply.wav"),null);
  await writeFile(file+".owner.json",JSON.stringify({topic_key:"private",session_key:session}));
  assert.ok(runtime.resolveAssetDownload(device,"ai_answers/reply.wav"));
  assert.equal(runtime.resolveAssetDownload(other,"ai_answers/reply.wav"),null);
  session="agent:cardputer:new";
  assert.equal(runtime.resolveAssetDownload(device,"ai_answers/reply.wav"),null);
  assert.equal((await runtime.listDeviceAssets(device,{headers:{host:"127.0.0.1"}})).files.length,0);
});

test("rejected multipart uploads leave no recordings behind",()=>withBridge(async({base,token,config})=>{
  for(const fields of [{},{client_msg_id:"oversized-duration",duration_ms:"99999999"}]){
    const body=new FormData();body.set("audio",new Blob([Buffer.alloc(5000)],{type:"audio/wav"}),"test.wav");
    for(const[k,v]of Object.entries(fields))body.set(k,v);
    const res=await fetch(base+"/api/cardputer/v1/topics/cardputer%3Amain/voice",{method:"POST",headers:{authorization:`Bearer ${token}`},body});
    assert.equal(res.status,400);
    for(let i=0;i<20&&(await readdir(config.media.tmpDir)).length;i++)await sleep(10);
    assert.deepEqual(await readdir(config.media.tmpDir),[]);
  }
  const empty=await fetch(base+"/api/device-audio-turn-raw",{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"audio/wav"},body:Buffer.alloc(0)});
  assert.equal(empty.status,400);
  for(let i=0;i<20&&(await readdir(config.media.tmpDir)).length;i++)await sleep(10);
  assert.deepEqual(await readdir(config.media.tmpDir),[]);
}));

test("generated audio is saved with current-session ownership and a non-traversable filename",async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),"s1-audio-owner-"));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const oldKey=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;t.after(()=>{if(oldKey!==undefined)process.env.OPENAI_API_KEY=oldKey;});
  const bin=path.join(tmp,"speak.mjs");const wav=Buffer.alloc(1644);wav.write("RIFF",0);wav.writeUInt32LE(1636,4);wav.write("WAVEfmt ",8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write("data",36);wav.writeUInt32LE(1600,40);
  await writeFile(bin,`#!${process.execPath}\nprocess.stdout.write(Buffer.from(${JSON.stringify(wav.toString("base64"))},"base64"));\n`,{mode:0o700});
  const topic={topic_key:"private",session_key:"agent:cardputer:private"},runtime=Object.create(BridgeRuntime.prototype);
  runtime.config={assets:{rootDir:tmp,deviceClass:"cardputer_adv",replyCategory:"ai_answers",maxFileBytes:10000,maxManifestFiles:10,maxManifestBytes:10000},omnibotShim:{ttsFallbackProvider:"espeak",ttsFallbackBin:bin}};
  runtime.store={getTopic:()=>topic};
  const req={headers:{host:"127.0.0.1"}};
  const result=await runtime.saveReplyAudioAsset(req,"Private spoken answer that is much longer than thirty two characters","../../escape",topic);
  assert.ok(result?.url);const relative=new URL(result.url).pathname.split("/assets/file/")[1];
  const asset=runtime.resolveAssetDownload({topics:["private"]},relative);assert.ok(asset);
  assert.deepEqual(JSON.parse(await readFile(asset.filePath+".owner.json","utf8")),topic);
  assert.equal((await stat(asset.filePath)).mode&0o777,0o600);
  assert.equal((await runtime.listDeviceAssets({topics:["private"]},req)).files.length,1);
});

test("device log rotation is bounded and concurrent appends remain complete",async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),"s1-log-rotation-"));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const runtime=Object.create(BridgeRuntime.prototype);runtime.config={assets:{logsDir:tmp}};
  const log=path.join(tmp,"device.jsonl");await writeFile(log,Buffer.alloc(8*1024*1024));
  await Promise.all([runtime.appendDeviceLogs({device_id:"device"},{event:"one"}),runtime.appendDeviceLogs({device_id:"device"},{event:"two"})]);
  assert.equal((await stat(log+".previous")).size,8*1024*1024);
  assert.deepEqual((await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line).event),["one","two"]);
});

test("explicit legacy compatibility cannot bypass request admission",()=>withBridge(async({base,token})=>{
  const ws=new WebSocket(base.replace("http:","ws:")+"/compat/mininerva/ws");const frames=[];
  ws.on("message",raw=>frames.push(decodeMininervaFrame(raw)));
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  try{
    ws.send(encodeMininervaFrame("auth",{api_key:token,device_id:"fixture",version:"1"}));
    for(let i=0;i<80&&!frames.some(frame=>frame?.type==="auth_response");i++)await sleep(10);
    assert.ok(frames.some(frame=>frame?.type==="auth_response"&&frame.payload.success));
    for(let i=0;i<8;i++)ws.send(encodeMininervaFrame("text",{text:"fixture "+i}));
    for(let i=0;i<80&&!frames.some(frame=>JSON.stringify(frame).includes("request_rate_or_concurrency_limit"));i++)await sleep(10);
    assert.ok(frames.some(frame=>JSON.stringify(frame).includes("request_rate_or_concurrency_limit")));
  }finally{ws.terminate();}
},{requestStartLimitPerDevice:5},{mininervaCompat:{enabled:true}}));

test("explicit legacy compatibility cannot write through a full storage budget",()=>withBridge(async({base,token})=>{
  const ws=new WebSocket(base.replace("http:","ws:")+"/compat/mininerva/ws"),frames=[];
  ws.on("message",raw=>frames.push(decodeMininervaFrame(raw)));
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  try{
    ws.send(encodeMininervaFrame("auth",{api_key:token,device_id:"fixture",version:"1"}));
    for(let i=0;i<80&&!frames.some(frame=>frame?.type==="auth_response");i++)await sleep(10);
    assert.ok(frames.some(frame=>frame?.type==="auth_response"&&frame.payload.success));
    ws.send(encodeMininervaFrame("text",{text:"must not be persisted"}));
    for(let i=0;i<80&&!frames.some(frame=>JSON.stringify(frame).includes("bridge_storage_limit"));i++)await sleep(10);
    assert.ok(frames.some(frame=>JSON.stringify(frame).includes("bridge_storage_limit")));
    const history=await(await fetch(base+"/api/cardputer/v1/topics/cardputer%3Amain/history",{headers:{authorization:`Bearer ${token}`}})).json();
    assert.equal(history.items.length,0);
  }finally{ws.terminate();}
},{},{mininervaCompat:{enabled:true},storage:{maxBytes:1,reservePerRequestBytes:1,minFreeBytes:0}}));

test("private storage reservations serialize concurrent requests and release exactly once",async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),"s1-storage-"));t.after(()=>rm(tmp,{recursive:true,force:true}));
  await writeFile(path.join(tmp,"retained.wav"),Buffer.alloc(512));
  const budget=new PrivateStorageBudget({stateDir:tmp,storage:{maxBytes:1024,reservePerRequestBytes:512,minFreeBytes:0}});
  const [a,b]=await Promise.all([budget.acquire(),budget.acquire()]);
  assert.equal(a.ok,true);assert.equal(b.ok,false);a.release();a.release();
  assert.equal((await budget.acquire()).ok,true);
  assert.equal((await readdir(tmp)).includes("retained.wav"),true);
});

test("full private storage refuses work before writing another upload",()=>withBridge(async({base,token,config})=>{
  const body=new FormData();body.set("audio",new Blob([Buffer.alloc(5000)]),"test.wav");
  const res=await fetch(base+"/api/cardputer/v1/topics/cardputer%3Amain/voice",{method:"POST",headers:{authorization:`Bearer ${token}`},body});
  assert.equal(res.status,507);assert.deepEqual(await readdir(config.media.tmpDir),[]);
},{},{storage:{maxBytes:1,reservePerRequestBytes:1,minFreeBytes:0}}));

test("remote gateway credentials require TLS", () => {
  for (const url of ["ws://remote.example:18789", "http://127.0.0.1:18789", "wss://user:pass@remote.example"]) {
    assert.throws(() => validateUpstreamTransport({ upstream: { url } }));
  }
  for (const url of ["ws://127.0.0.1:18789", "ws://[::1]:18789", "wss://remote.example"]) {
    validateUpstreamTransport({ upstream: { url } });
  }
});

test("session creation and firmware jobs preserve the configured agent", () => withBridge(async ({ config }) => {
  config.topics[0].session_key = "agent:cardputer:isolated";
  config.upstream.deviceIdentityPath = path.join(config.stateDir, "test-upstream-device.json");
  const runtime = new BridgeRuntime(config);
  let created;
  runtime.upstream.rpc = async (_method, params) => { created = params; };
  await runtime.ensureUpstreamSessionForTopic(config.topics[0], { forceCreate: true });
  assert.equal(created.agentId, "cardputer");
  runtime.registerRuntimeTopic = () => {};
  const job = await runtime.createFirmwareJobTopicForDevice(runtime.store.getDevice("cardputer-adv-01"));
  assert.equal(agentIdForSession(job.session_key), "cardputer");
}));

test("a config session remap revokes cached history and old media", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "s1-adv-remap-"));
  try {
    const config = { stateDir: tmp, devices: [{ device_id: "d", device_token: token, topics: ["t"] }],
      topics: [{ topic_key: "t", session_key: "agent:main:old" }] };
    const old = new StateStore(config);
    old.appendMessage("t", { id: "old-private-message", content: { text: "old private data" } });
    old.state.media.old = { topic_key: "t" };
    old.state.device_events.d = [{ event_id: "old", topic_key: "t" }];
    await old.save();
    config.topics[0].session_key = "agent:cardputer:new";
    const current = new StateStore(config);
    await current.load();
    assert.equal(current.getTopic("t").session_key, "agent:cardputer:new");
    assert.equal(current.state.messages.t.length, 0);
    assert.equal(current.state.media.old, undefined);
    assert.equal(current.state.device_events.d.length, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test("uploaded playlists cannot make FFmpeg fetch internal URLs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "s1-adv-media-"));
  let requested = false;
  const { createServer } = await import("node:http");
  const target = createServer((_req, res) => { requested = true; res.end("private"); });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  try {
    const inputPath = path.join(tmp, "upload.wav");
    await writeFile(inputPath, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${target.address().port}/private\n#EXT-X-ENDLIST\n`);
    await assert.rejects(transcode({ inputPath, outputPath: path.join(tmp, "out.wav"), args: ["-ac", "1"] }));
    assert.equal(requested, false);
  } finally { await new Promise(resolve => target.close(resolve)); await rm(tmp, { recursive: true, force: true }); }
});
