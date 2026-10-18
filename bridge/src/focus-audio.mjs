import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(new URL("../assets/focus-audio/", import.meta.url));
export const focusAudioPaths = ["en", "ru"].flatMap(language =>
  ["start", "break", "reflection"].map(cue => `${language}/${cue}.wav`));

// Only these six reviewed package assets can enter the existing download API.
// This library is read-only; a private asset at the same path takes precedence.
export async function loadFocusAudioBundle(root = bundleRoot) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.bundle_version !== 1 || manifest.files?.length !== focusAudioPaths.length)
    throw new Error("Invalid Focus audio bundle manifest");
  const files = [];
  for (const relativeUrlPath of focusAudioPaths) {
    const devicePath = `/pomodoro/audio/${relativeUrlPath}`;
    const matches = manifest.files.filter(file => file.path === devicePath);
    const entry = matches[0];
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) || entry.size < 44 || entry.size > 3 * 1024 * 1024 ||
        !Number.isFinite(entry.duration_sec) || entry.duration_sec <= 0 || entry.duration_sec > 120)
      throw new Error(`Invalid Focus audio metadata: ${relativeUrlPath}`);
    const filePath = path.join(root, relativeUrlPath);
    const info = await lstat(filePath);
    if (!info.isFile() || info.size !== entry.size)
      throw new Error(`Invalid Focus audio file: ${relativeUrlPath}`);
    const bytes = await readFile(filePath);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Focus audio checksum mismatch: ${relativeUrlPath}`);
    files.push({ filePath, relativeUrlPath, path: devicePath,
      category: relativeUrlPath.split("/")[0], language: relativeUrlPath.split("/")[0],
      title: path.basename(relativeUrlPath, ".wav").replace(/^./, c => c.toUpperCase()),
      sha256: entry.sha256, size: entry.size, duration_sec: entry.duration_sec });
  }
  return files;
}
