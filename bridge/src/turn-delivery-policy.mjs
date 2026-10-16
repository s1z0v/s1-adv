// Transport policy only: all turns keep the same S1 session, model and tools.
export function voiceThinking(text, inputMode) {
  if (inputMode !== "voice") return undefined;
  // A conservative development/deep-work fence. Ambiguous follow-ups retain
  // the session default instead of silently downgrading a firmware task.
  if (/прошив|фич|добав|исправ|реализ|разработ|код|ошиб|обнов|собер|сборк|выкат|депло|интегр|анализ|подроб|продолж|сделай|делай|давай|firmware|feature|implement|fix|build|code|deploy|develop|analy[sz]|continue/iu.test(text)) return undefined;
  return "low";
}

export function unwrapCardputerEnvelope(text) {
  const value = String(text || "");
  // Only strip our exact, labeled envelope, never arbitrary user JSON.
  if (!value.includes("Cardputer runtime context (bridge metadata):") ||
      !value.includes("Cardputer reply policy (bridge metadata):")) return value;
  const marker = "\nUser text:\n";
  const at = value.lastIndexOf(marker);
  return at < 0 ? value : value.slice(at + marker.length).trim();
}

export function audioTerminalReady(bufferedBytes, audioDonePending) {
  return bufferedBytes === 0 && !audioDonePending;
}
