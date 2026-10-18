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

export function voiceReplyWaitMs(requested, configured) {
  const fallback = Math.min(10000, Number(configured) || 10000);
  if (typeof requested !== "string" || !/^\d+$/u.test(requested)) return fallback;
  return Math.min(fallback, Math.max(250, Number(requested)));
}

// OpenClaw session.message/chat.history expose the originating run in
// __openclaw.runId. Timestamps and topic sequence numbers are not turn identity.
export function gatewayTurnCorrelation(raw = {}, meta = {}) {
  const boundedId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : undefined;
  const runId = boundedId(raw?.__openclaw?.runId) || boundedId(meta?.runId) || boundedId(raw?.runId);
  const stopReason = boundedId(raw?.stopReason);
  const toolCalls = Array.isArray(raw?.content) && raw.content.some(item => /^(toolCall|tool_use|functionCall)$/iu.test(item?.type || ''));
  return {
    upstream_run_id: runId,
    upstream_stop_reason: stopReason,
    upstream_tool_calls: toolCalls || undefined
  };
}

export function assistantReplyMatchesTurn(message, { runId, clientMsgId } = {}) {
  if (message?.sender?.kind !== 'assistant' || message?.content?.kind !== 'text') return false;
  const source = message.source || {};
  const owned = source.upstream_run_id
    ? Boolean(runId && source.upstream_run_id === runId)
    : Boolean(clientMsgId && message.client_msg_id === `${clientMsgId}:reply` && source.transport !== 'upstream');
  if (!owned || source.upstream_tool_calls) return false;
  // A tool/commentary message can have visible text but is not a final answer.
  return !source.upstream_stop_reason || /^(stop|end_turn|completed)$/iu.test(source.upstream_stop_reason);
}
