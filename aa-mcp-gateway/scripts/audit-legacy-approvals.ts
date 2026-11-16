import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ApprovalAudit = {
  total: number;
  canonical: number;
  legacy: number;
  malformed: number;
  legacy_cards: Array<{
    approval_id: string | null;
    status: string | null;
    tool: string | null;
    created_at: string | null;
    execution_status: string | null;
  }>;
};

/** Reads the persistent SQLite journal without creating tables or changing cards. */
export function auditApprovals(path: string): ApprovalAudit {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("SELECT body FROM approvals ORDER BY rowid").all();
    const audit: ApprovalAudit = { total: rows.length, canonical: 0,
      legacy: 0, malformed: 0, legacy_cards: [] };
    for (const row of rows) {
      let card: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(row.body));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        card = parsed as Record<string, unknown>;
      } catch {
        audit.malformed++;
        continue;
      }
      if (typeof card.canonical_request_id === "string"
        && typeof card.canonical_payload_hash === "string") {
        audit.canonical++;
        continue;
      }
      audit.legacy++;
      audit.legacy_cards.push({
        approval_id: typeof card.approval_id === "string" ? card.approval_id : null,
        status: typeof card.status === "string" ? card.status : null,
        tool: typeof card.tool === "string" ? card.tool : null,
        created_at: typeof card.created_at === "string" ? card.created_at : null,
        execution_status: typeof card.execution_status === "string"
          ? card.execution_status : null,
      });
    }
    return audit;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: audit-legacy-approvals.ts /absolute/path/to/gateway.sqlite");
  process.stdout.write(`${JSON.stringify(auditApprovals(path), null, 2)}\n`);
}
