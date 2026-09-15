import { type Route, handleMcpContent } from './content-route.js';
import { UUID } from './http.js';

// Phase 16b: Proof Bank reads + create/attach. usage_rights is never a Bot
// input — create forces not_cleared; attach updates storage_path only.
// Authorization is require_active_bot + require_bot_client_grant in SQL.

const MEDIA = new Set(['image', 'video', 'text']);
const STRENGTH = new Set(['high', 'medium', 'low']);
const PROOF_TYPES = new Set([
  'customer_result', 'testimonial', 'review', 'case_study', 'before_after',
  'stat', 'credential', 'award', 'press', 'process', 'team_expertise', 'customer_story',
]);

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}
function uuid(body: Record<string, unknown>, key: string): string | undefined {
  const value = str(body, key);
  return value && UUID.test(value) ? value : undefined;
}
function subset(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}
function limitOf(body: Record<string, unknown>, max = 100): number | undefined | false {
  const limit = body.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > max) return false;
  return limit;
}

const ROUTES: Record<string, Route> = {
  '/internal/mcp/proof/search': {
    rpc: 'mcp_proof_search',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const limit = limitOf(body);
      const q = body.q === undefined ? undefined : str(body, 'q');
      const media_type = body.media_type === undefined ? undefined : str(body, 'media_type');
      const proof_type = body.proof_type === undefined ? undefined : str(body, 'proof_type');
      if (!client_id || limit === false
          || (q !== undefined && (q.length < 1 || q.length > 400))
          || (media_type !== undefined && !MEDIA.has(media_type))
          || (proof_type !== undefined && !PROOF_TYPES.has(proof_type))
          || !subset(body, ['client_id', 'limit', 'q', 'media_type', 'proof_type'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(q === undefined ? {} : { p_q: q }),
        ...(media_type === undefined ? {} : { p_media_type: media_type }),
        ...(proof_type === undefined ? {} : { p_proof_type: proof_type }),
      };
    },
  },
  '/internal/mcp/proof/get': {
    rpc: 'mcp_proof_get',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const proof_id = uuid(body, 'proof_id');
      if (!client_id || !proof_id || !subset(body, ['client_id', 'proof_id'])) return undefined;
      return { p_bot_id: null, p_client_id: client_id, p_proof_id: proof_id };
    },
  },
  '/internal/mcp/proof/get-for-avatar': {
    rpc: 'mcp_proof_get_for_avatar',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const avatar = str(body, 'avatar');
      const limit = limitOf(body, 50);
      if (!client_id || !avatar || avatar.length < 1 || avatar.length > 300 || limit === false
          || !subset(body, ['client_id', 'avatar', 'limit'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_avatar: avatar,
        ...(limit === undefined ? {} : { p_limit: limit }),
      };
    },
  },
  '/internal/mcp/proof/get-for-claim': {
    rpc: 'mcp_proof_get_for_claim',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const claim = str(body, 'claim');
      const limit = limitOf(body, 50);
      if (!client_id || !claim || claim.length < 1 || claim.length > 400 || limit === false
          || !subset(body, ['client_id', 'claim', 'limit'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_claim: claim,
        ...(limit === undefined ? {} : { p_limit: limit }),
      };
    },
  },
  '/internal/mcp/proof/create': {
    rpc: 'mcp_proof_create',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const media_type = str(body, 'media_type');
      const title = body.title === undefined ? undefined : str(body, 'title');
      const bodyText = body.body === undefined ? undefined : str(body, 'body');
      const source = body.source === undefined ? undefined : str(body, 'source');
      const storage_path = body.storage_path === undefined ? undefined : str(body, 'storage_path');
      const claim = body.claim === undefined ? undefined : str(body, 'claim');
      const evidence = body.evidence === undefined ? undefined : str(body, 'evidence');
      const avatar_relevance = body.avatar_relevance === undefined ? undefined : str(body, 'avatar_relevance');
      const proof_type = body.proof_type === undefined ? undefined : str(body, 'proof_type');
      const strength = body.strength === undefined ? undefined : str(body, 'strength');
      if (!client_id || !media_type || !MEDIA.has(media_type)
          || (title !== undefined && (title.length < 1 || title.length > 200))
          || (bodyText !== undefined && (bodyText.length < 1 || bodyText.length > 8000))
          || (source !== undefined && (source.length < 1 || source.length > 500))
          || (storage_path !== undefined && (storage_path.length < 1 || storage_path.length > 500))
          || (claim !== undefined && (claim.length < 1 || claim.length > 400))
          || (evidence !== undefined && (evidence.length < 1 || evidence.length > 4000))
          || (avatar_relevance !== undefined && (avatar_relevance.length < 1 || avatar_relevance.length > 300))
          || (proof_type !== undefined && !PROOF_TYPES.has(proof_type))
          || (strength !== undefined && !STRENGTH.has(strength))
          || body.usage_rights !== undefined
          || !subset(body, [
            'client_id', 'media_type', 'title', 'body', 'source', 'storage_path',
            'claim', 'evidence', 'avatar_relevance', 'proof_type', 'strength',
          ])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_media_type: media_type,
        ...(title === undefined ? {} : { p_title: title }),
        ...(bodyText === undefined ? {} : { p_body: bodyText }),
        ...(source === undefined ? {} : { p_source: source }),
        ...(storage_path === undefined ? {} : { p_storage_path: storage_path }),
        ...(claim === undefined ? {} : { p_claim: claim }),
        ...(evidence === undefined ? {} : { p_evidence: evidence }),
        ...(avatar_relevance === undefined ? {} : { p_avatar_relevance: avatar_relevance }),
        ...(proof_type === undefined ? {} : { p_proof_type: proof_type }),
        ...(strength === undefined ? {} : { p_strength: strength }),
      };
    },
  },
  '/internal/mcp/proof/attach-asset': {
    rpc: 'mcp_proof_attach_asset',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const proof_id = uuid(body, 'proof_id');
      const storage_path = str(body, 'storage_path');
      const brief_id = body.brief_id === undefined ? undefined : uuid(body, 'brief_id');
      if (!client_id || !proof_id || !storage_path || storage_path.length < 1 || storage_path.length > 500
          || (body.brief_id !== undefined && !brief_id)
          || body.usage_rights !== undefined
          || !subset(body, ['client_id', 'proof_id', 'storage_path', 'brief_id'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_proof_id: proof_id, p_storage_path: storage_path,
        ...(brief_id === undefined ? {} : { p_brief_id: brief_id }),
      };
    },
  },
};

export const handleMcpProof: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, ROUTES);
