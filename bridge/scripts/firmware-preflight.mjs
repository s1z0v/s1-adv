#!/usr/bin/env node
import { writeFirmwarePreflight } from "../src/firmware-automation.mjs";
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
try {
  if (!args.includes("--config") || !args.includes("--output")) throw new Error("usage: firmware-preflight.mjs --config PATH --output PATH");
  console.log(JSON.stringify(await writeFirmwarePreflight(value("--config"), value("--output"))));
} catch (error) { console.error(error.message); process.exitCode = 1; }
