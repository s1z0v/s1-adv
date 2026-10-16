import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures");

function ensureToneFixture(outputPath, codecArgs) {
  if (existsSync(outputPath)) {
    return;
  }
  const ffmpeg = spawnSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=1.2", "-ac", "1", "-ar", "16000", ...codecArgs, outputPath],
    { stdio: "ignore" }
  );
  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg failed while generating ${outputPath}`);
  }
}

export async function prepareFixtures() {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const wav = path.join(FIXTURES_DIR, "voice.wav");
  const ogg = path.join(FIXTURES_DIR, "voice.ogg");
  ensureToneFixture(wav, ["-c:a", "pcm_s16le"]);
  ensureToneFixture(ogg, ["-c:a", "libopus", "-b:a", "24k"]);
  return { fixturesDir: FIXTURES_DIR, wav, ogg };
}
