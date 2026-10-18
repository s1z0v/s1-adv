#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planInstall, applyInstall, doctor, enablePlugin } from "../src/install.mjs";
import { provisionFirmware } from "../src/firmware-automation.mjs";

export async function setupCli(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  const names = { "gateway-config":"gatewayConfig", "gateway-token-file":"gatewayTokenFile", "gateway-url":"gatewayUrl", "state-dir":"stateDir", "public-url":"publicUrl", "device-id":"deviceId", agent:"agent", port:"port", config:"config", "repo-dir":"repoDir", branch:"branch", "python-bin":"pythonBin", "push-remote":"pushRemote" };
  for (let i = 0; i < rest.length; ++i) {
    const flag = rest[i].replace(/^--/, "");
    if (flag === "apply") options.apply = true;
    else if (flag === "no-probe") options.noProbe = true;
    else if (names[flag] && rest[i+1] && !rest[i+1].startsWith("--")) options[names[flag]] = rest[++i];
    else throw new Error(`Unknown or incomplete option: ${rest[i]}`);
  }
  if (command === "init") {
    const plan = await planInstall(options);
    return options.apply ? applyInstall(plan) : { ...plan.summary, applied: false, dryRun: true };
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
    return enablePlugin(path.resolve(options.config), { apply:options.apply, gatewayConfigPath:options.gatewayConfig });
  }
  return { usage: [
    "node scripts/setup.mjs init --gateway-config PATH [--state-dir PATH] [--agent cardputer] [--public-url https://bridge.example.com] [--apply]",
    "node scripts/setup.mjs doctor --config PATH [--no-probe]",
    "node scripts/setup.mjs firmware --config PATH --repo-dir PATH --branch BRANCH [--python-bin PATH] [--apply]",
    "node scripts/setup.mjs enable --config PATH [--apply]"
  ], defaults: "init previews without writes; --apply creates private files only. No gateway restart, OAuth copy, package install or firewall change." };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // OpenClaw also loads this module synchronously through its plugin loader.
  setupCli(process.argv.slice(2)).then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => { console.error(error.message); process.exitCode = 1; }
  );
}
