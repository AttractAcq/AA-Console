import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { handleMcpContent } from './content-route.js';

const client = '11111111-1111-4111-8111-111111111111';
const project = '22222222-2222-4222-8222-222222222222';
const secret = 'test-only-service-secret';

it('routes exact read-only video status and rejects extra body fields', async () => {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => ({
    abortSignal: async () => ({ data: {
      client_id: client, project_id: project, stage: 'draft', stage_error: null,
      ir_version: 0, scenes: 0, audio_scenes: 0,
      render_candidates: 0, accepted_candidates: 0, critic_loops: 0,
      cost_usd_estimate: 0, asset_id: null,
      asset_review_status: null, human_approved_at: null,
    }, error: null, name, args }),
  }));
  const sb = { rpc } as unknown as SupabaseClient;
  const server = createServer((req, res) => {
    void handleMcpContent(req, res, sb, secret);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/internal/mcp/content/video-project-status';
  const headers = { authorization: `Bearer ${secret}`,
    'content-type': 'application/json', 'x-aa-bot-id': 'bot_production',
    'x-request-id': 'video-status-read', 'idempotency-key': 'video-status-read' };
  try {
    const ok = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ client_id: client, project_id: project }) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).project_id).toBe(project);
    expect(rpc).toHaveBeenCalledWith('mcp_video_project_status_v1', {
      p_bot_id: 'bot_production', p_client_id: client, p_project_id: project,
    });
    const invalid = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ client_id: client, project_id: project,
        include_private_media: true }) });
    expect(invalid.status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
