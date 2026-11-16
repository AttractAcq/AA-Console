import { z } from "zod";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const registration = z.object({ canonical_request_id: uuid, payload_hash: hash }).strict();
const attestation = z.object({ approved: z.boolean(), state: z.string(),
  canonical_request_id: uuid.optional() }).strict();
const claimResponse = z.object({ claimed: z.boolean(), state: z.string() }).strict();
const outcomeResponse = z.object({ status: z.string(), execution_key: uuid,
  result_hash: hash, finished_at: z.string() }).strict();

export type GatewayApprovalPacket = {
  approval_id: string;
  client_id: string;
  bot_id: string;
  token_id: string;
  tool: string;
  risk: string;
  summary: string;
  payload: Record<string, unknown>;
  expires_at: string;
};

export interface CanonicalApprovalBridge {
  register(packet: GatewayApprovalPacket): Promise<{ canonical_request_id: string; payload_hash: string }>;
  attest(approvalId: string, tokenId: string, payloadHash: string,
    expectedCanonicalRequestId: string): Promise<boolean>;
  claim(approvalId: string, tokenId: string, payloadHash: string,
    executionKey: string): Promise<boolean>;
  finish(approvalId: string, executionKey: string, status: string,
    resultHash: string): Promise<void>;
}

/** The gateway uses only the existing fixed AA internal origin and service hop. */
export class AaCanonicalApprovalBridge implements CanonicalApprovalBridge {
  constructor(private origin: string, private secret: string) {}

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(new URL(path, this.origin), {
      method: "POST",
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error("canonical_approval_unavailable");
    return response.json();
  }

  async register(packet: GatewayApprovalPacket) {
    return registration.parse(await this.post("/internal/mcp/gateway-approval/register", packet));
  }

  async attest(approvalId: string, tokenId: string, payloadHash: string,
    expectedCanonicalRequestId: string) {
    const evidence = attestation.parse(await this.post("/internal/mcp/gateway-approval/attest", {
      approval_id: approvalId, token_id: tokenId, payload_hash: payloadHash,
    }));
    return evidence.approved && evidence.canonical_request_id === expectedCanonicalRequestId;
  }

  async claim(approvalId: string, tokenId: string, payloadHash: string,
    executionKey: string) {
    const result = claimResponse.parse(await this.post("/internal/mcp/gateway-approval/claim", {
      approval_id: approvalId, token_id: tokenId, payload_hash: payloadHash,
      execution_key: executionKey,
    }));
    return result.claimed && result.state === "claimed";
  }

  async finish(approvalId: string, executionKey: string, status: string,
    resultHash: string) {
    const result = outcomeResponse.parse(await this.post("/internal/mcp/gateway-approval/finish", {
      approval_id: approvalId, execution_key: executionKey,
      status, result_hash: resultHash,
    }));
    if (result.execution_key !== executionKey || result.status !== status
      || result.result_hash !== resultHash) throw new Error("canonical_outcome_mismatch");
  }
}
