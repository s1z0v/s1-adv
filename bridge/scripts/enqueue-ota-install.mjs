import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const version = String(args.version || "").trim();
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u.test(version)) {
  throw new Error("usage: enqueue-ota-install.mjs --version <semver> [--device <device-id>] [--config config.json]");
}

const configPath = path.resolve(
  process.cwd(),
  args.config || process.env.CARDPUTER_BRIDGE_CONFIG || path.resolve(__dirname, "..", "config.json")
);
const config = JSON.parse(await readFile(configPath, "utf8"));
const deviceId = String(args.device || config.devices?.[0]?.device_id || "").trim();
const device = (config.devices || []).find((item) => item.device_id === deviceId);
if (!device) {
  throw new Error(`unknown device ${deviceId || "<empty>"}`);
}
if (!String(device.device_token || "").trim()) {
  throw new Error(`device ${deviceId} has no configured token`);
}

const minimumBattery = Math.max(25, Math.min(100, Number(args["min-battery"]) || 25));
const adminToken = config.security?.internalOtaToken || process.env.CARDPUTER_INTERNAL_OTA_TOKEN || "";
if (config.security?.internalOtaEnabled !== true || adminToken.length < 32) {
  throw new Error("Local OTA administration requires internalOtaEnabled and a separate random internalOtaToken.");
}
const port = Math.max(1, Math.min(65535, Number(config.server?.port) || 31889));
const endpoint = `http://127.0.0.1:${port}/internal/cardputer/ota-install`;
let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${device.device_token}`,
      "X-Admin-Token": adminToken,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      version,
      device_id: deviceId,
      min_battery: minimumBattery
    })
  });
} catch (error) {
  throw new Error(
    `Bridge is unavailable at ${endpoint}; refusing unsafe direct state write: ${String(error.message || error)}`
  );
}
const raw = await response.text();
let result;
try {
  result = JSON.parse(raw);
} catch {
  throw new Error(`Bridge returned ${response.status} with invalid JSON`);
}
if (!response.ok || result?.ok !== true) {
  throw new Error(`Bridge rejected OTA enqueue (${response.status}): ${String(result?.error || "unknown_error")}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
