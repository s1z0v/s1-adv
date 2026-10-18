import { access, readFile, writeFile, mkdir, rm, copyFile, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function firmwareWorkflowPaths(config, defaults = {}) {
  const automation = config.firmwareAutomation || {};
  return { repoDir: automation.repoDir || defaults.repoDir || "",
    build: automation.wrappers?.build || defaults.build || "",
    publish: automation.wrappers?.publish || defaults.publish || "",
    smoke: automation.wrappers?.smoke || defaults.smoke || "",
    branch: automation.branch || "main", pushRemote: automation.pushRemote || "origin" };
}
export async function firmwareCapability(config, env = process.env) {
  if (config.firmwareAutomation?.enabled === false)
    return { ready: false, reason: "Firmware automation is disabled. Provision the optional firmware workflow first." };
  const automation = config.firmwareAutomation || {};
  const repo = automation.repoDir || env.CARDPUTER_FIRMWARE_REPO;
  const wrappers = automation.wrappers || { build: env.CARDPUTER_FIRMWARE_BUILD_BIN,
    publish: env.CARDPUTER_FIRMWARE_PUBLISH_BIN, smoke: env.CARDPUTER_FIRMWARE_SMOKE_BIN };
  if (!repo || !Object.values(wrappers).every(Boolean))
    return { ready: false, reason: "Firmware automation is not configured. Install its build, publish and verification wrappers." };
  try {
    await access(path.join(repo, ".git"), constants.R_OK);
    await access(repo, constants.W_OK);
    for (const key of ["build", "publish", "smoke"]) await access(wrappers[key], constants.X_OK);
  } catch { return { ready: false, reason: "Firmware repository or workflow wrappers are unavailable to the bridge user. Run setup doctor." }; }
  return { ready: true };
}

export async function provisionFirmware(configPath, { repoDir, branch, pythonBin = "python3", pushRemote = "origin" }) {
  if (!repoDir || !path.isAbsolute(repoDir) || !branch || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,120}$/.test(branch) || branch.includes(".."))
    throw new Error("An absolute firmware checkout and an explicit safe branch are required.");
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(pushRemote)) throw new Error("Invalid push remote name");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.firmwareAutomation?.enabled) throw new Error("Firmware workflow is already provisioned; preserve its configuration and release lock.");
  await access(path.join(repoDir, "scripts/cardputer.py"), constants.R_OK);
  const state = path.dirname(configPath), bin = path.join(state, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const wrappers = {};
  for (const action of ["build", "publish", "smoke"]) {
    const destination = path.join(bin, `cardputer-${action}.mjs`);
    const source = `#!/usr/bin/env node\nimport { firmwareCommand } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "src/firmware-automation.mjs")).href)};\ntry { console.log(JSON.stringify(await firmwareCommand(${JSON.stringify(configPath)}, ${JSON.stringify(action)}, process.argv.slice(2)), null, 2)); } catch (error) { console.error(error.message); process.exitCode=1; }\n`;
    await writeFile(destination, source, { mode: 0o700, flag: "wx" });
    wrappers[action] = destination;
  }
  config.firmwareAutomation = { enabled: true, repoDir, branch, pythonBin, pushRemote,
    envFile: path.join(state, "firmware.env"), wrappers };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { enabled: true, repoDir, branch, wrappers,
    requiredAgentPermissions: "Read/edit this checkout; execute only reviewed workflow commands and git for this checkout. Publishing needs your own fork push permission. No gateway/provider credentials belong on the device." };
}

function command(program, args, { cwd, env = process.env, logFile } = {}) {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 24 * 1024 * 1024 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return { ok: result.status === 0, output, status: result.status, logFile };
}
function git(repo, args) {
  const result = command("git", args, { cwd: repo });
  if (!result.ok) throw new Error("Firmware git precondition failed. Check the private checkout and credentials.");
  return result.output.trim();
}
function cleanCheckout(automation) {
  const repo = automation.repoDir;
  if (git(repo, ["branch", "--show-current"]) !== automation.branch) throw new Error("Firmware checkout is on a different branch; refusing to switch it.");
  if (git(repo, ["status", "--porcelain"])) throw new Error("Review and commit firmware changes before build. A clean source commit is required.");
  const remote = git(repo, ["remote", "get-url", automation.pushRemote]);
  if (/^https?:\/\//.test(remote)) {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) throw new Error("Do not embed credentials in the git remote. Use a host credential helper or SSH.");
  }
  return git(repo, ["rev-parse", "HEAD"]);
}
export function provisioningEnvironment(text) {
  const env = {};
  const allowed = new Set(["DEFAULT_WIFI_SSID", "DEFAULT_WIFI_PASSWORD", "DEFAULT_HUB_HOST", "DEFAULT_HUB_PORT", "DEFAULT_DEVICE_ID", "DEFAULT_DEVICE_TOKEN", "DEFAULT_TOPIC_KEY"]);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^(?:export )?([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match || !allowed.has(match[1])) throw new Error("Unsupported firmware.env assignment.");
    let value = match[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1,-1);
    else if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    if (!/^[A-Za-z0-9 _.:/@+=!?-]*$/.test(value)) throw new Error("Firmware compile-time value contains unsupported characters. Use device setup for Wi-Fi credentials.");
    env[match[1]] = value;
  }
  return env;
}

export async function firmwareCommand(configPath, action, args = []) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.firmwareAutomation?.enabled !== true) throw new Error("Firmware automation is disabled.");
  const automation = config.firmwareAutomation, state = path.dirname(configPath);
  const receiptPath = path.join(state, "firmware-build.json"), lockPath = path.join(state, "firmware-release.lock");
  const sourceSha = cleanCheckout(automation);
  if (action === "build") {
    const lease = randomUUID();
    await writeFile(lockPath, `${JSON.stringify({ lease, sourceSha, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" })
      .catch(() => { throw new Error("A firmware release already owns the lock. Inspect its receipt before retrying; locks are never stolen automatically."); });
    try {
      const provisioning = provisioningEnvironment(await readFile(automation.envFile, "utf8"));
      const result = command(automation.pythonBin, [path.join(automation.repoDir, "scripts/cardputer.py"), "build"], {
        cwd: automation.repoDir, env: { ...process.env, ...provisioning, BUILD_GIT_SHA: sourceSha, BUILD_TIME: new Date().toISOString() } });
      const logFile = path.join(state, "firmware-build.log");
      await writeFile(logFile, result.output, { mode: 0o600 });
      if (!result.ok) throw new Error("Firmware build failed. Details are in the private firmware-build.log; no OTA was published.");
      if (cleanCheckout(automation) !== sourceSha) throw new Error("Firmware source changed during build; refusing to publish.");
      const binary = path.join(automation.repoDir, "bots/CardputerADV/.pio/build/cardputer_adv/firmware.bin");
      const bytes = await readFile(binary);
      if (bytes.length < 4096 || bytes.length > 0x300000 - 65536 || bytes[0] !== 0xe9)
        throw new Error("Firmware image is invalid or lacks required OTA slot headroom.");
      const ini = await readFile(path.join(automation.repoDir, "bots/CardputerADV/platformio.ini"), "utf8");
      const version = ini.match(/APP_VERSION=\\?"([^"\\]+)\\?"/)?.[1];
      if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Error("Cannot determine firmware version.");
      const candidate = path.join(state, "firmware-candidate.bin");
      await copyFile(binary, candidate);
      await chmod(candidate, 0o600);
      const receipt = { lease, sourceSha, version, binary: candidate, size: bytes.length, sha256: sha256(bytes), builtAt: new Date().toISOString() };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      return { ...receipt, binary: "private candidate retained", logFile };
    } catch (error) {
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      if (lock.lease === lease) await rm(lockPath);
      throw error;
    }
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (receipt.lease !== lock.lease || sourceSha !== receipt.sourceSha) throw new Error("Build receipt does not match the current release/source lock.");
  const bytes = await readFile(receipt.binary);
  if (sha256(bytes) !== receipt.sha256 || bytes.length !== receipt.size) throw new Error("Candidate differs from the verified build.");
  if (action === "publish") {
    if (args[0] !== receipt.version) throw new Error("Requested publish version must match the verified build.");
    const remote = git(automation.repoDir, ["ls-remote", "--exit-code", automation.pushRemote, `refs/heads/${automation.branch}`]);
    if (remote.split(/\s/)[0] !== sourceSha) throw new Error("Push the exact verified source to the configured fork/branch before publishing OTA.");
    const firmwareRoot = path.resolve(state, config.firmware.rootDir || path.join(config.stateDir || "./data", "firmware"));
    const manifestPath = path.join(firmwareRoot, config.firmware.deviceClass || "cardputer_adv", config.firmware.manifestFilename || "manifest.json");
    let existing;
    try { existing = JSON.parse(await readFile(manifestPath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (existing?.version === receipt.version && existing.sha256 !== receipt.sha256) throw new Error("This version already names a different image. Bump the version; never overwrite it.");
    if (!existing || existing.version !== receipt.version) {
      const result = command(process.execPath, [path.join(packageRoot, "scripts/publish-firmware.mjs"), "--config", configPath,
        "--bin", receipt.binary, "--version", receipt.version, "--git", sourceSha, "--notes", String(args[1] || "S1-ADV firmware update").slice(0, 500)]);
      if (!result.ok) throw new Error("Firmware publisher failed; inspect local permissions and keep the release lock for diagnosis.");
    }
    return { published: true, sourceSha, version: receipt.version, sha256: receipt.sha256, verified: false, next: "Run the smoke wrapper before claiming completion." };
  }
  if (action !== "smoke") throw new Error("Unknown firmware workflow command");
  const base = `http://${config.server.host}:${config.server.port}`;
  const headers = { Authorization: `Bearer ${config.devices[0].device_token}` };
  const response = await fetch(`${base}/api/cardputer/firmware/manifest`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Authenticated firmware manifest check failed.");
  const manifest = await response.json();
  if (manifest.sha256 !== receipt.sha256 || manifest.build_git_sha !== sourceSha || manifest.version !== receipt.version || manifest.size !== receipt.size)
    throw new Error("Served firmware manifest differs from the verified candidate.");
  const url = new URL(manifest.firmware_url || manifest.url, base);
  const publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : null;
  if (url.origin !== base && url.origin !== publicOrigin) throw new Error("Unexpected firmware download origin.");
  if (url.origin !== base && url.protocol !== 'https:') throw new Error("Public firmware download must use HTTPS.");
  const download = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const downloaded = Buffer.from(await download.arrayBuffer());
  if (!download.ok || downloaded.length !== receipt.size || sha256(downloaded) !== receipt.sha256) throw new Error("Served firmware file verification failed.");
  await writeFile(path.join(state, "firmware-release.json"), `${JSON.stringify({ ...receipt, verifiedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await rm(lockPath);
  return { verified: true, sourceSha, version: receipt.version, size: receipt.size, sha256: receipt.sha256, hardwareInstalled: false };
}
