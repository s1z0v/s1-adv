#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadFocusAudioBundle, focusAudioPaths } from "../src/focus-audio.mjs";
import plugin from "../index.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
assert.equal(manifest.version, pkg.version);
// Native hosts discover tools from the manifest before loading the module.
plugin.register({pluginConfig:{},registerTool(_factory,options){
  for(const name of [options.name,...(options.names || [])].filter(Boolean))
    assert(manifest.contracts?.tools?.includes(name), `Tool missing its native discovery contract: ${name}`);
},registerService(){},registerCli(){}});
assert.equal(pkg.private, false);
for (const hook of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"])
  assert.equal(pkg.scripts?.[hook], undefined, `Unexpected install/publish hook: ${hook}`);
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {cwd:root,encoding:"utf8"});
assert.equal(packed.status, 0, "npm pack could not inspect the public artifact");
const [artifact] = JSON.parse(packed.stdout);
const files = artifact.files.map(file => file.path);
const allowedRoot = new Set(["package.json", "index.mjs", "openclaw.plugin.json", "config.example.json", "README.md", "TURN-OUTBOX.md", "LICENSE", "CREDITS.md"]);
const audioFiles = new Set(focusAudioPaths.map(file => `assets/focus-audio/${file}`));
for (const file of files) {
  assert(!file.split("/").some(part => part.startsWith(".") || /^(?:data|output|inbound|node_modules|tmp.*)$/.test(part)), `Private/runtime path: ${file}`);
  assert(audioFiles.has(file) || !/\.(?:bin|wav|mp3|pem|key|env)$|\.test\.mjs$|smoke|mock-upstream|fixtures|security-model-gate/i.test(file), `Non-runtime file: ${file}`);
  assert(allowedRoot.has(file) || /^src\/[a-z0-9-]+\.mjs$/.test(file) ||
    /^scripts\/(?:setup|agent-status|publish-firmware|firmware-[a-z0-9-]+)\.mjs$/.test(file) ||
    ["skills/s1-adv/SKILL.md", "skills/s1-adv-firmware/SKILL.md"].includes(file) || audioFiles.has(file) ||
    file === "assets/focus-audio/manifest.json", `Unexpected package file: ${file}`);
}
for (const file of [...audioFiles, "assets/focus-audio/manifest.json"])
  assert(files.includes(file), `Required Focus asset missing: ${file}`);
await loadFocusAudioBundle(); // Inspect bytes/checksums, not just package filenames.
for (const file of ["index.mjs", "openclaw.plugin.json", "config.example.json", "src/server.mjs", "src/install.mjs", "scripts/setup.mjs", "skills/s1-adv/SKILL.md", "skills/s1-adv-firmware/SKILL.md", "TURN-OUTBOX.md", "LICENSE", "CREDITS.md"])
  assert(files.includes(file), `Required public file missing: ${file}`);
console.log(JSON.stringify({ok:true,name:artifact.name,version:artifact.version,files:files.length,packedBytes:artifact.size,unpackedBytes:artifact.unpackedSize}));
