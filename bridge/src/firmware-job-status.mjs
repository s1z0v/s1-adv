// Persisted per-request status. Polling neither acknowledges nor consumes it.
export function startFirmwareJob(deviceId, requestId, now = Date.now(), manifest = null) {
  const stamp = new Date(now).toISOString();
  return { device_id: deviceId, request_id: requestId, state: "building", started_at: stamp,
    updated_at: stamp, baseline_sha256: manifest?.sha256 || null };
}

export function updateFirmwareJob(job, { message = {}, text = "", manifest = null, now = Date.now() } = {}) {
  if (!job) return null;
  // Restart history and delayed frames must not finish a newer request.
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(message.timestamp);
  if (Number.isFinite(timestamp) && timestamp < Date.parse(job.started_at)) return job;
  if (message.role && message.role !== "assistant") return job;
  const next = { ...job, updated_at: new Date(now).toISOString() };
  const tools = Array.isArray(message.content) && message.content.some(c =>
    /^(toolCall|tool_use|functionCall)$/i.test(c.type));
  if (message.errorMessage || message.stopReason === "error" || message.stopReason === "aborted")
    return { ...next, state: "failed" };
  // Empty tool-only messages are heartbeats, never completion. A later tool
  // proves execution even if the initial sessions.send RPC timed out.
  if (tools || /^(toolUse|tool_calls|tool_use)$/i.test(message.stopReason || ""))
    return { ...next, state: "building" };
  if (!text.trim()) return next;
  if (message.stopReason && !/^(stop|end_turn|completed)$/i.test(message.stopReason)) return next;
  const published = /^[a-f0-9]{64}$/i.test(manifest?.sha256 || "") && manifest.size > 0 && manifest.version &&
    manifest.sha256 !== job.baseline_sha256 &&
    /^[a-f0-9]{40}$/i.test(manifest.build_git_sha || "") && text.includes(manifest.version) &&
    Date.parse(manifest.built_at || manifest.generated_at || "") >= Date.parse(job.started_at);
  const otaAction = /"type"\s*:\s*"ota\.(?:check|apply)"/.test(text);
  return { ...next, state: published && otaAction ? "ready" : "attention" };
}

export function firmwareJobDeliveryUncertain(job, now = Date.now()) {
  // Timeout means no RPC receipt; the gateway may already be executing it.
  return job ? { ...job, state: "uncertain", updated_at: new Date(now).toISOString() } : job;
}

export function publicFirmwareJob(job, now = Date.now()) {
  if (!job) return { state: "idle" };
  const stale = job.state === "building" && now - Date.parse(job.updated_at) > 15 * 60 * 1000;
  const state = job.agent_managed && job.work_kind !== 'firmware' && job.state === 'failed' ? 'error' : job.state;
  return { state: stale ? "stalled" : state, request_id: job.request_id,
    started_at: job.started_at, updated_at: job.updated_at,
    ...(job.agent_managed ? { agent_managed: true, task_id: job.task_id,
      work_kind: job.work_kind, question: job.question || null } : {}) };
}
