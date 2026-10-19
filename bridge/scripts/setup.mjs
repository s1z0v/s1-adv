#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planInstall, applyInstall, doctor, enablePlugin } from "../src/install.mjs";
import { provisionFirmware } from "../src/firmware-automation.mjs";
import { planModelRoles, applyModelRoles, MODEL_PRESETS } from '../src/model-roles.mjs';

export async function setupCli(argv, { openclawCommand } = {}) {
  const [command = "help", ...rest] = argv;
  const options = {};
  const names = { "gateway-config":"gatewayConfig", "gateway-token-file":"gatewayTokenFile", "gateway-url":"gatewayUrl", "state-dir":"stateDir", "public-url":"publicUrl", "device-id":"deviceId", agent:"agent", port:"port", config:"config", "repo-dir":"repoDir", branch:"branch", "python-bin":"pythonBin", "push-remote":"pushRemote", 'model-profile':'modelProfile', 'fast-model':'fastModel', 'smart-model':'smartModel', 'fast-thinking':'fastThinking', 'smart-thinking':'smartThinking', 'fast-deadline-ms':'fastDeadlineMs' };
  for (let i = 0; i < rest.length; ++i) {
    const flag = rest[i].replace(/^--/, "");
    if (flag === "apply") options.apply = true;
    else if (flag === "no-probe") options.noProbe = true;
    else if (names[flag] && rest[i+1] && !rest[i+1].startsWith("--")) options[names[flag]] = rest[++i];
    else throw new Error(`Unknown or incomplete option: ${rest[i]}`);
  }
  if (command === "init") {
    const plan = await planInstall(options);
    if (!options.apply) return { ...plan.summary, applied: false, dryRun: true, modelPresets:MODEL_PRESETS,
      ...(options.modelProfile ? {modelProfile:options.modelProfile,modelSetup:'New private configuration will also provision the selected fast/smart roles. Existing configurations require the explicit models command.'} : {}) };
    const result=await applyInstall(plan);
    if(options.modelProfile && !plan.existing) {
      const roles=await planModelRoles(plan.configPath,options,{openclawCommand});
      return {...result,models:await applyModelRoles(roles,{openclawCommand})};
    }
    return result;
  }
  if(command==='models') {
    if(!options.config) throw new Error('models requires --config /absolute/private/config.json');
    const plan=await planModelRoles(options.config,options,{openclawCommand});
    return options.apply ? applyModelRoles(plan,{openclawCommand}) : {...plan.summary,dryRun:true,applied:false};
  }
  if (command === "doctor") {
    if (!options.config) throw new Error("doctor requires --config /absolute/private/config.json");
    return doctor(options.config, { probe: !options.noProbe });
  }
  if (command === "firmware") {
    if (!options.config || !options.repoDir || !options.branch) throw new Error("firmware requires --config, --repo-dir and --branch");
    if (!options.apply) return { dryRun: true, writes: ["private build/publish/smoke wrappers", "firmwareAutomation config"],
      repoDir: path.resolve(options.repoDir), branch: options.branch, next: "Review the dedicated agent permissions and your fork, then repeat with --apply." };
    return provisionFirmware(path.resolve(options.config), { ...options, repoDir: path.resolve(options.repoDir) });
  }
  if (command === "enable") {
    if (!options.config) throw new Error("enable requires --config /absolute/private/config.json");
    return enablePlugin(path.resolve(options.config), { apply:options.apply, gatewayConfigPath:options.gatewayConfig, openclawCommand });
  }
  return { usage: [
    "node scripts/setup.mjs init --gateway-config PATH [--state-dir PATH] [--agent cardputer] [--public-url https://bridge.example.com] [--apply]",
    "node scripts/setup.mjs doctor --config PATH [--no-probe]",
    "node scripts/setup.mjs firmware --config PATH --repo-dir PATH --branch BRANCH [--python-bin PATH] [--apply]",
    "node scripts/setup.mjs enable --config PATH [--apply]"
    ,"node scripts/setup.mjs models --config PATH [--model-profile codex|claude] [--fast-model PROVIDER/MODEL] [--smart-model PROVIDER/MODEL] [--apply]"
  ], defaults: "init previews without writes; --apply creates private files only. No gateway restart, OAuth copy, package install or firewall change." };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // OpenClaw also loads this module synchronously through its plugin loader.
  setupCli(process.argv.slice(2)).then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => { console.error(error.message); process.exitCode = 1; }
  );
}
