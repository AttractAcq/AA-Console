import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UUID, authenticated, fail, header, json, readJsonBody } from './http.js';

const HEX64 = /^[0-9a-f]{64}$/;
const BOT = /^bot_[a-z0-9_]{1,60}$/;
const TOOL = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const REGISTER = '/internal/mcp/gateway-approval/register';
const ATTEST = '/internal/mcp/gateway-approval/attest';
const CLAIM = '/internal/mcp/gateway-approval/claim';
const FINISH = '/internal/mcp/gateway-approval/finish';

function exactKeys(body: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(body).sort().join(',') === keys.sort().join(',');
}

export async function handleMcpGatewayApproval(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  secret: string | null | undefined,
): Promise<void> {
  if (!authenticated(req, secret)) return fail(res, 'unauthorized');
  if (req.method !== 'POST' || !/^application\/json(?:\s*;.*)?$/i.test(header(req, 'content-type') ?? '')) {
    return fail(res, 'invalid_request');
  }
  const path = req.url;
  if (path !== REGISTER && path !== ATTEST && path !== CLAIM && path !== FINISH) return fail(res, 'invalid_request');
  let body: Record<string, unknown>;
  try { body = await readJsonBody(req, 65536); }
  catch { res.setHeader('Connection', 'close'); return fail(res, 'invalid_request'); }
  let rpc: string;
  let args: Record<string, unknown>;
  if (path === REGISTER) {
    if (!exactKeys(body, ['approval_id','client_id','bot_id','token_id','tool','risk','summary','payload','expires_at'])
      || typeof body.approval_id !== 'string' || !UUID.test(body.approval_id)
      || typeof body.client_id !== 'string' || !UUID.test(body.client_id)
      || typeof body.token_id !== 'string' || !UUID.test(body.token_id)
      || typeof body.bot_id !== 'string' || !BOT.test(body.bot_id)
      || typeof body.tool !== 'string' || !TOOL.test(body.tool)
      || !['LOW','MEDIUM','HIGH','CRITICAL'].includes(String(body.risk))
      || typeof body.summary !== 'string' || !body.summary.trim() || body.summary.length > 2000
      || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)
      || typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))) {
      return fail(res, 'invalid_request');
    }
    rpc = 'register_gateway_tool_review_v6';
    args = { p_packet: body };
  } else if (path === ATTEST || path === CLAIM) {
    const keys = path === CLAIM
      ? ['approval_id','token_id','payload_hash','execution_key']
      : ['approval_id','token_id','payload_hash'];
    if (!exactKeys(body, keys)
      || typeof body.approval_id !== 'string' || !UUID.test(body.approval_id)
      || typeof body.token_id !== 'string' || !UUID.test(body.token_id)
      || typeof body.payload_hash !== 'string' || !HEX64.test(body.payload_hash)
      || (path === CLAIM && (typeof body.execution_key !== 'string' || !UUID.test(body.execution_key)))) {
      return fail(res, 'invalid_request');
    }
    rpc = path === CLAIM ? 'claim_gateway_tool_execution_v6' : 'attest_gateway_tool_review_v6';
    args = { p_approval_id: body.approval_id, p_token_id: body.token_id,
      p_payload_hash: body.payload_hash,
      ...(path === CLAIM ? { p_execution_key: body.execution_key } : {}) };
  } else {
    if (!exactKeys(body, ['approval_id','execution_key','status','result_hash'])
      || typeof body.approval_id !== 'string' || !UUID.test(body.approval_id)
      || typeof body.execution_key !== 'string' || !UUID.test(body.execution_key)
      || !['completed','accepted','failed','indeterminate','rejected','not_implemented'].includes(String(body.status))
      || typeof body.result_hash !== 'string' || !HEX64.test(body.result_hash)) return fail(res, 'invalid_request');
    rpc = 'finish_gateway_tool_execution_v6';
    args = { p_approval_id: body.approval_id, p_execution_key: body.execution_key,
      p_status: body.status, p_result_hash: body.result_hash };
  }
  try {
    const { data, error } = await sb.rpc(rpc, args).abortSignal(AbortSignal.timeout(12_000));
    if (error) return fail(res, 'internal_error');
    if (path === REGISTER) {
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || typeof (data as { canonical_request_id?: unknown }).canonical_request_id !== 'string'
        || !UUID.test((data as { canonical_request_id: string }).canonical_request_id)
        || typeof (data as { payload_hash?: unknown }).payload_hash !== 'string'
        || !HEX64.test((data as { payload_hash: string }).payload_hash)) return fail(res, 'internal_error');
      return json(res, 200, data);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 'internal_error');
    if (path === ATTEST && (typeof (data as { approved?: unknown }).approved !== 'boolean'
      || typeof (data as { state?: unknown }).state !== 'string')) return fail(res, 'internal_error');
    if (path === CLAIM && (typeof (data as { claimed?: unknown }).claimed !== 'boolean'
      || typeof (data as { state?: unknown }).state !== 'string')) return fail(res, 'internal_error');
    if (path === FINISH && (typeof (data as { status?: unknown }).status !== 'string'
      || typeof (data as { result_hash?: unknown }).result_hash !== 'string')) return fail(res, 'internal_error');
    json(res, 200, data);
  } catch { fail(res, 'internal_error'); }
}
