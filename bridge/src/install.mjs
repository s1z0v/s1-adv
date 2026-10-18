import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import JSON5 from "json5";
import { firmwareCapability } from "./firmware-automation.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const defaultGatewayConfig = () => process.env.OPENCLAW_CONFIG_PATH ||
  path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "openclaw.json");

export function gatewayToken(config, env = process.env) {
  const token = config.gateway?.auth?.token;
  if (typeof token === "string") {
    const ref = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(token);
    if (ref) return env[ref[1]] || "";
    return token;
  }
  if (token?.source === "env") return env[token.id] || "";
  return ""; // External SecretRefs must be resolved by their owner, not scraped.
}

function validAgent(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error("Invalid agent ID");
  return value;
}

export function configuredAgentExists(gateway, agent) {
  const agents=gateway.agents || {};
  return (agent==="main"&&agents.ownership!=="explicit") ||
    agents.list?.some(record=>record.id===agent) || Object.hasOwn(agents.entries || {},agent);
}

export async function planInstall(options = {}) {
  const gatewayPath = path.resolve(options.gatewayConfig || defaultGatewayConfig());
  const gateway = JSON5.parse(await readFile(gatewayPath, "utf8"));
  const stateDir = path.resolve(options.stateDir || path.join(path.dirname(gatewayPath), "s1-adv"));
  const configPath = path.join(stateDir, "config.json");
  const agent = validAgent(options.agent || "cardputer");
  const deviceId = options.deviceId || "cardputer-adv-01";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId)) throw new Error("Invalid device ID");
  const port = Number(options.port || 31889);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Bridge port must be 1024..65535");
  const publicUrl = options.publicUrl ? new URL(options.publicUrl) : null;
  if (publicUrl && (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash))
    throw new Error("Public URL must be an HTTPS origin without credentials, path or query");
  const token = options.gatewayTokenFile
    ? (await readFile(path.resolve(options.gatewayTokenFile), "utf8")).trim() : gatewayToken(gateway);
  if (!token) throw new Error("Gateway token unavailable. Use an environment SecretRef or --gateway-token-file; never pass a token on the command line.");
  const gatewayPort = Number(gateway.gateway?.port || 18789);
  const upstreamUrl = options.gatewayUrl || `ws://127.0.0.1:${gatewayPort}`;
  const upstream = new URL(upstreamUrl);
  if (upstream.username || upstream.password || !["ws:", "wss:"].includes(upstream.protocol) ||
      (upstream.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)))
    throw new Error("Gateway must use loopback WS or verified WSS");
  let existing = null;
  try { existing = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = existing || JSON.parse(await readFile(path.join(packageRoot, "config.example.json"), "utf8"));
  if (!existing) {
    config.server = { host: "127.0.0.1", port };
    config.stateDir = path.join(stateDir, "data");
    for (const [key, relative] of Object.entries({ inboundDir: "inbound", canonicalDir: "media/canonical", playbackDir: "media/playback", tmpDir: "media/tmp" }))
      config.media[key] = path.join(config.stateDir, relative);
    config.assets.rootDir = path.join(config.stateDir, "assets");
    config.assets.logsDir = path.join(config.stateDir, "logs");
    config.firmware.rootDir = path.join(config.stateDir, "firmware");
    config.upstream.url = upstreamUrl;
    config.upstream.token = token;
    config.devices = [{ device_id: deviceId, device_token: randomBytes(32).toString("hex"), default_topic_key: "cardputer:main", topics: ["cardputer:main"] }];
    config.topics = [{ topic_key: "cardputer:main", session_key: `agent:${agent}:cardputer`, title: "Cardputer", contour_id: agent }];
    config.firmwareAutomation = { enabled: false };
    config.installation = { publicUrl: publicUrl?.origin || "", agentId: agent, gatewayConfigPath: gatewayPath };
  }
  const selectedAgent = config.installation?.agentId || agent;
  const agentExists = !!configuredAgentExists(gateway, selectedAgent);
  return { config, configPath, stateDir, gatewayPath, existing: !!existing,
    summary: { configPath, stateDir, bridge: config.server, gateway: config.upstream.url,
      publicUrl: config.installation?.publicUrl || "not configured", agent: selectedAgent, agentExists,
      existingConfigurationPreserved: !!existing, firmwareAutomation: config.firmwareAutomation?.enabled === true,
      writes: existing ? [] : ["config.json (0600)", "firmware.env (0600)", "openclaw-plugin-config.json (0600)"],
      notes: ["No gateway, channel, provider, OAuth or firewall settings are changed.",
        "The device token grants access to the selected agent. Use a dedicated restricted agent for shared devices.",
        "Firmware automation is off until explicitly provisioned. Voice needs the selected STT/TTS providers."] }
  };
}

const envQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export async function applyInstall(plan) {
  if (!plan.summary.agentExists) throw new Error("Selected agent does not exist. Create a restricted cardputer agent with OpenClaw, or explicitly select an existing agent, then repeat setup.");
  await mkdir(plan.stateDir, { recursive: true, mode: 0o700 });
  await chmod(plan.stateDir,0o700);
  if (plan.existing) return { ...plan.summary, applied: false, reason: "Existing configuration retained; device token unchanged." };
  for (const name of ["config.json", "firmware.env", "openclaw-plugin-config.json"]) {
    try { await stat(path.join(plan.stateDir, name)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error("Setup output already exists; refusing to overwrite private files.");
  }
  const publicUrl = plan.config.installation.publicUrl ? new URL(plan.config.installation.publicUrl) : null;
  const device = plan.config.devices[0];
  const values = { DEFAULT_WIFI_SSID: "", DEFAULT_WIFI_PASSWORD: "", DEFAULT_HUB_HOST: publicUrl?.hostname || "",
    DEFAULT_HUB_PORT: publicUrl?.port || "443", DEFAULT_DEVICE_ID: device.device_id,
    DEFAULT_DEVICE_TOKEN: device.device_token, DEFAULT_TOPIC_KEY: device.default_topic_key };
  await writeFile(plan.configPath, `${JSON.stringify(plan.config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(path.join(plan.stateDir, "firmware.env"),
    "# Private. Set Wi-Fi locally or use device setup. Never commit or share this file.\n" +
    Object.entries(values).map(([k,v]) => `${k}=${envQuote(v)}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  await writeFile(path.join(plan.stateDir, "openclaw-plugin-config.json"),
    `${JSON.stringify({ plugins: { entries: { "s1-adv": { enabled: true, config: { configPath: plan.configPath, autoStart: true } } } } }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" });
  return { ...plan.summary, applied: true };
}

export async function doctor(configPath, { probe = true } = {}) {
  const absolute = path.resolve(configPath);
  const config = JSON.parse(await readFile(absolute, "utf8"));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const mode = (await stat(absolute)).mode & 0o777;
  add("private-config", process.platform === "win32" || (mode & 0o077) === 0, "Config should be readable only by its owner.");
  add("device-token", config.devices?.every(d => typeof d.device_token === "string" && d.device_token.length >= 32), "One unique random token per device.");
  add("single-device",config.devices?.length===1,"One device identity per bridge instance; keep private state/media/OTA directories separate.");
  add("loopback-listener", ["127.0.0.1", "::1", "localhost"].includes(config.server?.host), "Expose through a verified TLS proxy, not a public raw listener.");
  add("gateway-token", !!config.upstream?.token && config.upstream.token !== "replace-me", "Gateway token present; value omitted.");
  try {
    const gateway = JSON5.parse(await readFile(config.installation?.gatewayConfigPath || defaultGatewayConfig(), "utf8"));
    const agent = config.installation?.agentId || config.topics?.[0]?.session_key?.split(":")[1];
    add("agent-config", !!configuredAgentExists(gateway,agent), "Configured session must name an existing agent; model response is checked separately.");
  } catch { add("agent-config", false, "Cannot verify selected agent against the local gateway configuration."); }
  for (const binary of ["ffmpeg", ...(config.omnibotShim?.ttsFallbackProvider === "espeak" ? ["espeak-ng"] : [])]) {
    const found = spawnSync(binary, [binary === "ffmpeg" ? "-version" : "--version"], { encoding: "utf8", timeout: 5000 });
    add(binary, found.status === 0, found.status === 0 ? "Available" : "Install for configured audio support");
  }
  if (config.omnibotShim?.sttProvider === "local-whisper") {
    for (const [name, file, permission] of [["whisper-binary", config.omnibotShim.sttLocalBin, constants.X_OK], ["whisper-model", config.omnibotShim.sttLocalModel, constants.R_OK]]) {
      let ok = false; try { await access(file, permission); ok = true; } catch {}
      add(name, ok, ok ? "Available" : "Configured local speech dependency is missing; text chat can still work.");
    }
  }
  if (probe) {
    try {
      const response = await fetch(`http://${config.server.host}:${config.server.port}/healthz`, {
        headers: { Authorization: `Bearer ${config.devices[0].device_token}` }, signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      add("bridge-http", response.ok && body.ok === true, `HTTP ${response.status}`);
      add("upstream", body.upstream_connected === true, "Checks the real gateway connection, not a model answer.");
    } catch { add("bridge-http", false, "Not reachable. Start the reviewed bridge/plugin and approve its exact device identity if requested."); }
  }
  const firmware = await firmwareCapability(config);
  return { configPath: absolute, checks, textReady: probe && checks.filter(c => ["private-config","device-token","single-device","loopback-listener","gateway-token","agent-config","bridge-http","upstream"].includes(c.name)).every(c => c.ok),
    audioDependenciesReady: checks.filter(c => ["ffmpeg","espeak-ng","whisper-binary","whisper-model"].includes(c.name)).every(c => c.ok),
    firmwareAutomationEnabled: config.firmwareAutomation?.enabled === true, firmwareCapability: firmware,
    note: "A model round trip and physical-device acceptance are separate checks." };
}

export async function enablePlugin(configPath, { apply = false, gatewayConfigPath = defaultGatewayConfig(), runCommand = spawnSync } = {}) {
  gatewayConfigPath = path.resolve(gatewayConfigPath);
  const report = await doctor(configPath, { probe: false });
  const required = ["private-config", "device-token", "single-device", "loopback-listener", "gateway-token", "agent-config"];
  if (report.checks.some(check => required.includes(check.name) && !check.ok))
    throw new Error("Configuration is not ready to enable. Resolve the failed doctor checks first.");
  const host = JSON5.parse(await readFile(gatewayConfigPath, "utf8"));
  const operations = [];
  if (Array.isArray(host.plugins?.allow) && !host.plugins.allow.includes("s1-adv"))
    operations.push(["config", "set", "plugins.allow", JSON.stringify([...host.plugins.allow,"s1-adv"]), "--strict-json"]);
  operations.push(["config", "set", "plugins.entries.s1-adv", JSON.stringify({ enabled:true, config:{configPath:path.resolve(configPath),autoStart:true} }), "--strict-json"]);
  if (!apply) return { dryRun:true, gatewayConfigPath, operations, note:"Only this plugin entry and its allowlist membership are changed. Gateway restart remains an explicit operator step." };
  const backup = path.join(path.dirname(configPath), `gateway-config-before-enable-${Date.now()}.json5`);
  await writeFile(backup, await readFile(gatewayConfigPath), { mode:0o600, flag:"wx" });
  for (const args of operations) {
    const result = runCommand("openclaw",args,{encoding:"utf8",timeout:30000,
      env:{...process.env,OPENCLAW_CONFIG_PATH:gatewayConfigPath}});
    if (result.status !== 0) throw new Error(`OpenClaw rejected the plugin configuration. Inspect its config locally; private backup: ${backup}. No restart was performed.`);
  }
  return { enabled:true, gatewayConfigPath, backup, restartRequired:true, note:"Restart your intended Gateway when ready; existing channels and agents were preserved." };
}
