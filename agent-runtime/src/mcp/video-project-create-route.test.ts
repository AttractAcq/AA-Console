import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { handleMcpContent } from './content-route.js';

const client = '11111111-1111-4111-8111-111111111111';
const brief = '22222222-2222-4222-8222-222222222222';
const campaign = '33333333-3333-4333-8333-333333333333';
const route = '44444444-4444-4444-8444-444444444444';
const source = '55555555-5555-4555-8555-555555555555';
const project = '66666666-6666-4666-8666-666666666666';
const job = '77777777-7777-4777-8777-777777777777';
const secret = 'test-only-service-secret';

it('starts a video with exact source and route IDs, refusing extra fields', async () => {
  const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: {
    client_id: client, project_id: project, job_id: job, stage: 'queued',
  }, error: null }) }));
  const sb = { rpc } as unknown as SupabaseClient;
  const server = createServer((req, res) => { void handleMcpContent(req, res, sb, secret); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/internal/mcp/content/create-video-project';
  const headers = { authorization: `Bearer ${secret}`,
    'content-type': 'application/json', 'x-aa-bot-id': 'bot_production',
    'x-request-id': 'video-create-request', 'idempotency-key': 'video-create-execution' };
  const body = { client_id: client,
    idea: 'Explain our reviewed service to prospective buyers.',
    audience: 'Local buyers', tone: 'confident', target_length_sec: 120,
    aspects: ['16:9', '9:16'], record_ids: [source],
    brief_id: brief, campaign_id: campaign, route_package_id: route,
    idempotency_key: 'video-create-key-1' };
  try {
    const ok = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify(body) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).job_id).toBe(job);
    expect(rpc).toHaveBeenCalledWith('mcp_create_video_project_v1', {
      p_bot_id: 'bot_production', p_request_id: 'video-create-request',
      p_execution_id: 'video-create-execution', p_client_id: client,
      p_idea: body.idea, p_audience: body.audience, p_tone: body.tone,
      p_target_length_sec: 120, p_aspects: body.aspects,
      p_record_ids: body.record_ids, p_brief_id: brief,
      p_campaign_id: campaign, p_route_package_id: route,
      p_request_key: body.idempotency_key,
    });
    const extra = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ ...body, approved: true }) });
    expect(extra.status).toBe(400);
    const missingSource = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ ...body, record_ids: [] }) });
    expect(missingSource.status).toBe(400);
    const routeWithoutBrief = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ ...body, brief_id: null }) });
    expect(routeWithoutBrief.status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
