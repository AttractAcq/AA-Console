import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const BOT = /^bot_[a-z0-9_]{1,60}$/;

export const MCP_ERRORS: Record<string, [number, string]> = {
  unauthorized: [401, 'Service authentication required.'],
  invalid_bot: [403, 'Bot identity is not supported.'],
  invalid_request: [400, 'Valid headers and JSON body are required.'],
  task_not_found: [404, 'Task not found.'],
  campaign_not_found: [404, 'Campaign not found.'],
  task_completed: [409, 'Task is already complete.'],
  invalid_assignee: [400, 'Use an active AA bot or member label.'],
  client_not_found: [404, 'Client not found.'],
  idea_not_found: [404, 'Idea not found.'],
  brief_not_found: [404, 'Brief not found.'],
  asset_not_found: [404, 'Asset not found.'],
  approval_not_found: [404, 'Approval request not found.'],
  approval_required: [409, 'Current human asset approval is required.'],
  approval_resource_mismatch: [409, 'Asset does not match the approval request.'],
  client_mismatch: [403, 'Resource does not belong to the requested client.'],
  client_forbidden: [403, 'Bot is not permitted for this client.'],
  bot_not_active: [403, 'Bot is not active.'],
  bot_forbidden: [403, 'This bot is not authorized for this action.'],
  invalid_idea_status: [409, 'Idea must already be approved for brief generation.'],
  invalid_brief_status: [409, 'Brief is not in a state that allows this action.'],
  invalid_asset_status: [409, 'Asset is not in a state that allows this action.'],
  invalid_formats: [400, 'Provide 1–6 known repurpose formats.'],
  idempotency_conflict: [409, 'Execution key was already used for a different request.'],
  brief_agent_unavailable: [503, 'Brief agent is unavailable.'],
  repurpose_agent_unavailable: [503, 'Repurpose agent is unavailable.'],
  queue_failure: [500, 'Unable to queue the job.'],
  internal_error: [500, 'Unable to process the request.'],
};

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function fail(res: ServerResponse, code: string, errors: Record<string, [number, string]> = MCP_ERRORS): void {
  const [status, message] = errors[code] ?? MCP_ERRORS.internal_error!;
  json(res, status, { error: { code, message } });
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const count = (req.rawHeaders ?? []).filter((_, i, all) => i % 2 === 0 && (all[i] ?? '').toLowerCase() === name).length;
  const value = req.headers[name];
  return count > 1 || typeof value !== 'string' ? undefined : value;
}

export function authenticated(req: IncomingMessage, secret: string | null | undefined): boolean {
  if (!secret) return false;
  const value = header(req, 'authorization');
  if (!value || !/^Bearer [^\s]+$/i.test(value)) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(value.slice(7)), digest(secret));
}

export function readJsonBody(req: IncomingMessage, maxBytes = 4096, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
    };
    const onError = () => {
      cleanup();
      req.on('error', () => { /* already rejected */ });
      req.pause();
      reject(new Error('invalid_request'));
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) return onError();
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new Error('invalid_request'));
      }
    };
    const timer = setTimeout(onError, timeoutMs);
    timer.unref();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onError);
  });
}
