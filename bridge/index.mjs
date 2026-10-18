import { createBridgeService } from "./src/plugin-service.mjs";
import { setupCli } from "./scripts/setup.mjs";

async function printCommand(name, options) {
  const args = [name];
  for (const [key,value] of Object.entries(options)) {
    const flag = `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
    if (value === true) args.push(flag);
    else if (value !== undefined && value !== false) args.push(flag, String(value));
  }
  // OpenClaw may prepend a system bin directory to PATH. Keep config writes
  // on this exact CLI/runtime when multiple host versions are installed.
  console.log(JSON.stringify(await setupCli(args, {
    openclawCommand: [process.execPath, process.argv[1]]
  }), null, 2));
}

export default {
  id: "s1-adv",
  name: "S1-ADV Cardputer Bridge",
  register(api) {
    api.registerService(createBridgeService(api.pluginConfig || {}, { logger: api.logger }));
    api.registerCli(({ program }) => {
      const command = program.command("s1-adv").description("Plan, configure and diagnose the Cardputer bridge");
      command.command("init")
        .description("Preview private configuration; --apply writes files, without changing gateway settings")
        .option("--gateway-config <path>", "OpenClaw config file")
        .option("--gateway-token-file <path>", "Private token file for external SecretRefs")
        .option("--gateway-url <url>", "Loopback WS or verified WSS gateway")
        .option("--state-dir <path>", "Private bridge directory")
        .option("--public-url <url>", "Device-facing HTTPS origin")
        .option("--agent <id>", "Dedicated OpenClaw agent", "cardputer")
        .option("--device-id <id>", "Unique Cardputer ID", "cardputer-adv-01")
        .option("--port <number>", "Loopback bridge port", "31889")
        .option("--apply", "Write private files after reviewing the plan")
        .action(options => printCommand("init", options));
      command.command("firmware")
        .description("Explicitly provision private firmware build/release wrappers; agent permissions remain yours")
        .requiredOption("--config <path>", "Private bridge config")
        .requiredOption("--repo-dir <path>", "Your firmware fork checkout")
        .requiredOption("--branch <name>", "Allowed source branch")
        .option("--python-bin <path>", "Python with PlatformIO installed", "python3")
        .option("--push-remote <name>", "Your writable fork remote", "origin")
        .option("--apply", "Write reviewed private wrappers/config")
        .action(options => printCommand("firmware", options));
      command.command("enable")
        .description("Preview this plugin's OpenClaw settings; --apply saves them without restarting")
        .requiredOption("--config <path>", "Private bridge config")
        .option("--gateway-config <path>", "Plugin host OpenClaw config; normally the active profile")
        .option("--apply", "Save the reviewed plugin entry")
        .action(options => printCommand("enable", options));
      command.command("doctor")
        .description("Check private config, actual bridge/gateway connection and audio dependencies")
        .requiredOption("--config <path>", "Private bridge config")
        .option("--no-probe", "Validate files/dependencies without a network probe")
        .action(options => printCommand("doctor", {
          config: options.config, noProbe: options.probe === false
        }));
    }, { commands: ["s1-adv"] });
  }
};
