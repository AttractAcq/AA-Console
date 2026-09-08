import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RuntimeConfig } from '../../config.js';
import type { AgentRow } from '../../orchestration/registry.js';
import type { AgentJobRow } from '../../queue.js';
const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../../tools/anthropic.js', async () => ({
  ...await vi.importActual('../../tools/anthropic.js'), runAgentLoop: model,
}));
vi.mock('../shared.js', () => ({ loadUpstreamRecords: async () => [] }));
vi.mock('../identity.js', () => ({ loadIdentity: async () => ({}), identityWriterBlock: () => 'Identity' }));
vi.mock('../proof.js', () => ({ loadUsableProof: async () => [], renderProof: () => 'No proof', proofIdForRef: () => null }));
import { runBriefJob } from './index.js';

const job = { id: 'job', client_id: 'client', input_table: 'client_ideas', input_id: 'idea' } as AgentJobRow;
const config = { anthropicApiKeyByAgent: {}, anthropicApiKey: 'test' } as RuntimeConfig;
const agent = { agent_key: 'brief' } as AgentRow;
const existing = { id: 'brief', client_id: 'client', source_idea_id: 'idea', title: 'Human edited' };
function database(options: { existing?: typeof existing; conflict?: boolean; error?: string; wrongOwner?: boolean } = {}) {
  let saved: Record<string, unknown> | undefined = options.existing;
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    if (options.error) return { error: { code: options.error, message: 'write failed' } };
    if (options.conflict) {
      saved = { ...existing, client_id: options.wrongOwner ? 'other' : 'client' };
      return { error: { code: '23505', message: 'unique violation' } };
    }
    saved = { id: 'new-brief', ...row };
    return { error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === 'agent_job_events') return { insert: vi.fn(async () => ({ error: null })) };
    const query: any = {
      select: () => query, eq: () => query, is: () => query,
      neq: async () => ({ count: 0 }),
      maybeSingle: async () => ({ error: null, data: table === 'client_briefs' ? saved ?? null
        : table === 'client_ideas' ? { id: 'idea', title: 'Idea', media_type: 'image' } : { name: 'Client' } }),
      insert,
    };
    return query;
  });
  return { sb: { from } as unknown as SupabaseClient, insert, saved: () => saved };
}
beforeEach(() => {
  vi.clearAllMocks();
  model.mockResolvedValue({ submitted: {
    title: 'Generated title', hook: 'Start with the customer question.',
    premise: 'A practical piece about the service.', argument: 'Explain how it works and what the buyer should ask.',
    proof: 'No proof claim.', script: 'Here are the three questions to ask before booking a consultation. Discuss the process and what happens next.',
    visual_direction: 'A simple still image with clear type.', call_to_action: 'Ask a question.',
    channel_intent: 'Organic social', production_notes: 'Use the existing brand assets.',
  }, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } });
});
const run = (sb: SupabaseClient) => runBriefJob(sb, config, agent, job, Date.now() + 60_000);
describe('brief worker retry persistence', () => {
  it('reuses a persisted output on retry without another model call or overwrite', async () => {
    const db = database();
    expect((await run(db.sb)).ok).toBe(true);
    const first = db.saved();
    expect((await run(db.sb)).ok).toBe(true);
    expect(db.insert).toHaveBeenCalledOnce();
    expect(model).toHaveBeenCalledOnce();
    expect(db.saved()).toBe(first);
  });
  it('preserves a human-edited existing brief', async () => {
    const db = database({ existing });
    expect(await run(db.sb)).toEqual({ ok: true, retryable: false });
    expect(model).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.saved()?.title).toBe('Human edited');
  });
  it('accepts a concurrent winner after a unique violation and preserves its content', async () => {
    const db = database({ conflict: true });
    expect((await run(db.sb)).ok).toBe(true);
    expect(db.insert).toHaveBeenCalledOnce();
    expect(db.saved()?.title).toBe('Human edited');
  });
  it('does not mask a uniqueness error without a matching persisted brief', async () => {
    await expect(run(database({ error: '23505' }).sb)).rejects.toThrow('Failed to write brief');
    await expect(run(database({ conflict: true, wrongOwner: true }).sb)).rejects.toThrow('does not match');
  });
  it('does not mask unrelated database failures', async () => {
    await expect(run(database({ error: '23503' }).sb)).rejects.toThrow('Failed to write brief');
  });
});
