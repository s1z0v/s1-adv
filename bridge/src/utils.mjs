import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await ensureDir(path.dirname(filePath));
  await writeFile(tmpPath, JSON.stringify(value, null, 2));
  await rename(tmpPath, filePath);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseVisibleText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractMetadataBlock(text) {
  const match = text.match(/Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/);
  if (!match) {
    return {};
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}

export function stripTelegramEnvelope(text) {
  if (!text) {
    return "";
  }
  const transcriptMatch = text.match(/Transcript:\s*([\s\S]*)$/);
  if (transcriptMatch) {
    return transcriptMatch[1].trim();
  }
  const userTextMatch = text.match(/\n\n(?:\[Audio\]\n)?User text:\n([\s\S]*)$/);
  if (userTextMatch) {
    return userTextMatch[1].trim();
  }
  const lastFence = text.lastIndexOf("```");
  if (lastFence >= 0 && lastFence + 3 < text.length) {
    const tail = text.slice(lastFence + 3).trim();
    if (tail) {
      return tail;
    }
  }
  return text.trim();
}

export function stripMarkdownForDevice(value, { collapseWhitespace = true } = {}) {
  let text = String(value || "");
  if (!text) {
    return "";
  }

  text = text
    .replace(/\r\n?/gu, "\n")
    .replace(/```[\w-]*\n?([\s\S]*?)```/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}>\s?/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "• ")
    .replace(/^\s*\d+[.)]\s+/gmu, "")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/\*([^*\n]+)\*/gu, "$1")
    .replace(/_([^_\n]+)_/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/[*_`~]{2,}/gu, "")
    .replace(/^\s*\|(.+)\|\s*$/gmu, (_match, row) =>
      row
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" · ")
    )
    .replace(/^\s*:?-{3,}:?\s*(?:·\s*:?-{3,}:?\s*)*$/gmu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");

  if (collapseWhitespace) {
    text = text.replace(/\s+/gu, " ");
  } else {
    text = text
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n");
  }
  return text.trim();
}

export function isTelegramVoiceTranscript(text) {
  return /\[Audio\]/.test(text) || /<media:audio>/.test(text);
}

export function normalizeTimestamp(raw) {
  if (typeof raw === "number") {
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string") {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return nowIso();
}
