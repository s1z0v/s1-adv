import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createBridgeService(pluginConfig = {}, { logger = console, spawnChild = spawn } = {}) {
  let child = null;
  let stopping = false;
  const service = {
    id: "s1-adv-bridge",
    async start() {
      if (!pluginConfig.autoStart) {
        logger.info("S1-ADV is installed. Run setup/doctor and explicitly enable autoStart to run the bridge.");
        return;
      }
      if (child) return;
      const configPath = pluginConfig.configPath;
      if (!configPath || !path.isAbsolute(configPath)) throw new Error("S1-ADV requires an absolute private configPath.");
      const file = await stat(configPath);
      if (process.platform !== "win32" && (file.mode & 0o077)) throw new Error("S1-ADV config must have mode0600.");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (!["127.0.0.1", "::1", "localhost"].includes(config.server?.host))
        throw new Error("S1-ADV plugin requires a loopback bridge listener and a TLS proxy for device access.");
      const sensitive = [];
      const collect = value => {
        for (const [key, item] of Object.entries(value || {})) {
          if (item && typeof item === "object") collect(item);
          else if (/token|password|secret|api.?key/i.test(key) && typeof item === "string" && item.length >= 8) sensitive.push(item);
        }
      };
      collect(config);
      const sanitize = line => sensitive.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), line).slice(0, 2000);
      const env = { ...process.env, CARDPUTER_BRIDGE_CONFIG: configPath };
      const automation = config.firmwareAutomation;
      if (automation?.enabled) {
        env.CARDPUTER_FIRMWARE_REPO = automation.repoDir;
        env.CARDPUTER_FIRMWARE_BUILD_BIN = automation.wrappers?.build || "";
        env.CARDPUTER_FIRMWARE_PUBLISH_BIN = automation.wrappers?.publish || "";
        env.CARDPUTER_FIRMWARE_SMOKE_BIN = automation.wrappers?.smoke || "";
      }
      stopping = false;
      child = spawnChild(process.execPath, [path.join(root, "src/server.mjs")], {
        cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
      });
      const launched = child;
      for (const [stream, level] of [[child.stdout, "info"], [child.stderr, "warn"]]) {
        let buffer = "";
        stream?.on("data", chunk => {
          buffer += chunk.toString();
          const lines = buffer.split("\n"); buffer = lines.pop().slice(-8192);
          for (const line of lines) if (line.trim()) logger[level](`[s1-adv] ${sanitize(line)}`);
        });
      }
      child.on("error", () => logger.error("S1-ADV bridge process could not start. Run the setup doctor."));
      child.on("exit", (code, signal) => {
        if (child === launched) child = null;
        if (!stopping) logger.error(`S1-ADV bridge stopped (code=${code}, signal=${signal || "none"}). Run doctor before restarting.`);
      });
      logger.info("S1-ADV bridge process started; doctor verifies HTTP, gateway and optional providers separately.");
    },
    async stop() {
      if (!child) return;
      stopping = true;
      const running = child;
      await new Promise(resolve => {
        const timer = setTimeout(() => { running.kill("SIGKILL"); resolve(); }, 5000);
        running.once("exit", () => { clearTimeout(timer); resolve(); });
        running.kill("SIGTERM");
      });
      child = null;
    }
  };
  let lifecycle = Promise.resolve();
  const serialize = operation => {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => {});
    return next;
  };
  return { id:service.id,
    start:() => serialize(() => service.start()),
    stop:() => serialize(() => service.stop()) };
}
