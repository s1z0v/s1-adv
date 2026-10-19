import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const AGENT_STATES = ['awaiting_input', 'working', 'building', 'completed', 'cancelled', 'failed'];
export const WORK_KINDS = ['conversation', 'task', 'firmware'];

// A distinct, purpose-bound credential. Never send the Gateway credential over HTTP.
export function agentStatusCredential(config) {
  const token = String(config.upstream?.token || '');
  return token.length >= 32
    ? createHmac('sha256', token).update('s1-adv/agent-status/v1').digest('hex') : '';
}

export function hasAgentStatusAccess(req, config) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  if (Object.keys(req.headers || {}).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'))) return false;
  const expected = Buffer.from(agentStatusCredential(config));
  const supplied = Buffer.from(String(req.headers?.['x-s1-agent-status'] || ''));
  return expected.length === 64 && supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

export function createAgentStatusTool(context, pluginConfig, { fetchImpl = fetch } = {}) {
  if (!context?.sessionKey || context.sandboxed || !path.isAbsolute(pluginConfig.configPath || '')) return null;
  let config;
  try {
    const file = statSync(pluginConfig.configPath);
    if (process.platform !== 'win32' && (file.mode & 0o077)) return null;
    config = JSON.parse(readFileSync(pluginConfig.configPath, 'utf8'));
  } catch { return null; }
  if (!(config.topics || []).some(topic => topic.session_key === context.sessionKey &&
      (config.devices || []).some(device => (device.topics || []).includes(topic.topic_key)))) return null;
  const host = config.server?.host;
  const port = Number(config.server?.port);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const credential = agentStatusCredential(config);
  if (!credential) return null;
  return {
    name: 'cardputer_status',
    label: 'Cardputer task status',
    description: 'Set the status of the current authenticated Cardputer turn in this same session. Ask missing requirements with awaiting_input before starting work. Use building only for explicitly accepted firmware work. Ordinary questions need no status call. This tool does not build, publish, install, cancel or resend a request.',
    parameters: { type: 'object', additionalProperties: false,
      required: ['request_id', 'state', 'work_kind'], properties: {
        request_id: { type: 'string', description: 'Exact current request_id from the Cardputer turn context.' },
        task_id: { type: 'string', description: 'Existing active_task.task_id when continuing that task; omit for a new task.' },
        state: { type: 'string', enum: AGENT_STATES },
        work_kind: { type: 'string', enum: WORK_KINDS },
        question: { type: 'string', maxLength: 512, description: 'For awaiting_input, the question also included in the visible assistant reply.' }
      } },
    async execute(_toolCallId, params) {
      const response = await fetchImpl(`http://${host === '::1' ? '[::1]' : host}:${port}/internal/cardputer/agent-status`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-s1-agent-status': credential },
        body: JSON.stringify({ ...params, session_key: context.sessionKey })
      });
      if (!response.ok) throw new Error(`Cardputer status rejected (HTTP ${response.status}). Do not claim the status changed.`);
      const result = await response.json();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  };
}

export function publishedAfterTask(manifest, task) {
  return !!(manifest?.version && manifest.size > 0 && /^[a-f0-9]{64}$/i.test(manifest.sha256 || '') &&
    /^[a-f0-9]{40}$/i.test(manifest.build_git_sha || '') && manifest.sha256 !== task.baseline_sha256 &&
    Date.parse(manifest.built_at || manifest.generated_at || '') >= Date.parse(task.started_at));
}
