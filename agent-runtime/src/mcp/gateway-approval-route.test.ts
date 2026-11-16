import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { handleMcpGatewayApproval } from './gateway-approval-route.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const APPROVAL = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';
const CANONICAL = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const rpc = vi.fn((name: string) => ({ abortSignal: async () => ({
  data: name === 'register_gateway_tool_review_v6'
    ? { canonical_request_id: CANONICAL, payload_hash: HASH }
    : name === 'claim_gateway_tool_execution_v6'
      ? { claimed: true, state: 'claimed' }
    : name === 'finish_gateway_tool_execution_v6'
      ? { status: 'completed', execution_key: '55555555-5555-4555-8555-555555555555',
        result_hash: HASH, finished_at: '2026-11-14T12:00:00Z' }
    : { approved: true, state: 'source_decided', canonical_request_id: CANONICAL },
  error: null,
}) }));
let server: http.Server;
let port: number;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    void handleMcpGatewayApproval(req, res, { rpc } as unknown as SupabaseClient,
      'credential', 'attractacq');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); });

async function send(path: string, value: unknown, token = 'credential') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

it('registers only a scoped exact gateway packet over the service hop', async () => {
  rpc.mockClear();
  const packet = { approval_id: APPROVAL, client_id: CLIENT, bot_id: 'bot_production',
    token_id: TOKEN, tool: 'workflow.create_approval', risk: 'MEDIUM', summary: 'Review',
    payload: { client_id: CLIENT, summary: 'Review', idempotency_key: 'review-1' },
    expires_at: '2030-01-01T00:00:00Z' };
  expect((await send('/internal/mcp/gateway-approval/register', packet, 'wrong')).status).toBe(401);
  expect((await send('/internal/mcp/gateway-approval/register', { ...packet, extra: true })).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
  const result = await send('/internal/mcp/gateway-approval/register', packet);
  expect(result).toEqual({ status: 200, body: { canonical_request_id: CANONICAL, payload_hash: HASH } });
  expect(rpc).toHaveBeenCalledWith('register_gateway_tool_review_v6', { p_packet: packet });
});

it('freezes the configured GitHub organization into a Sites review packet', async () => {
  rpc.mockClear();
  const packet = { approval_id: APPROVAL, client_id: CLIENT, bot_id: 'bot_marketing',
    token_id: TOKEN, tool: 'sites.provision', risk: 'HIGH', summary: 'Provision',
    payload: { client_id: CLIENT, repo: 'harbour', idempotency_key: 'site-review-1' },
    expires_at: '2030-01-01T00:00:00Z' };
  const path = '/internal/mcp/gateway-approval/register';
  expect((await send(path, { ...packet, payload: { ...packet.payload,
    provider_org: 'attacker-org' } })).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
  expect((await send(path, packet)).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('register_gateway_tool_review_v6', {
    p_packet: { ...packet, payload: { ...packet.payload, provider_org: 'attractacq' } },
  });
});

it('attests the canonical decision against approval, token and payload hash', async () => {
  const packet = { approval_id: APPROVAL, token_id: TOKEN, payload_hash: HASH };
  expect((await send('/internal/mcp/gateway-approval/attest', { ...packet, payload_hash: 'bad' })).status).toBe(400);
  const result = await send('/internal/mcp/gateway-approval/attest', packet);
  expect(result.body).toEqual({ approved: true, state: 'source_decided', canonical_request_id: CANONICAL });
  expect(rpc).toHaveBeenCalledWith('attest_gateway_tool_review_v6', {
    p_approval_id: APPROVAL, p_token_id: TOKEN, p_payload_hash: HASH,
  });
});

it('claims once and records a bound outcome through service-only routes', async () => {
  const executionKey = '55555555-5555-4555-8555-555555555555';
  const claim = await send('/internal/mcp/gateway-approval/claim', {
    approval_id: APPROVAL, token_id: TOKEN, payload_hash: HASH, execution_key: executionKey,
  });
  expect(claim.body).toEqual({ claimed: true, state: 'claimed' });
  expect(rpc).toHaveBeenCalledWith('claim_gateway_tool_execution_v6', {
    p_approval_id: APPROVAL, p_token_id: TOKEN, p_payload_hash: HASH,
    p_execution_key: executionKey,
  });
  const finish = await send('/internal/mcp/gateway-approval/finish', {
    approval_id: APPROVAL, execution_key: executionKey, status: 'completed', result_hash: HASH,
  });
  expect(finish.body.status).toBe('completed');
  expect(rpc).toHaveBeenCalledWith('finish_gateway_tool_execution_v6', {
    p_approval_id: APPROVAL, p_execution_key: executionKey,
    p_status: 'completed', p_result_hash: HASH,
  });
});
