import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadFocusAudioBundle } from "./focus-audio.mjs";

test("a modified cue or out-of-bundle path cannot pass the bundle integrity check", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "s1-focus-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../assets/focus-audio/", import.meta.url), root, { recursive: true });
  assert.equal((await loadFocusAudioBundle(root)).length, 6);
  const cuePath = path.join(root, "en/start.wav");
  const original = await readFile(cuePath);
  const modified = Buffer.from(original);
  modified[modified.length - 1] ^= 1;
  await writeFile(cuePath, modified);
  await assert.rejects(loadFocusAudioBundle(root), /checksum mismatch/);
  await writeFile(cuePath, original);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files[0].path = "/pomodoro/audio/../../private.wav";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadFocusAudioBundle(root), /Invalid Focus audio metadata/);
});
