import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT);
 CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, body TEXT NOT NULL);`);
  }
  transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  audit(event: Record<string, unknown>) {
    this.db
      .prepare("INSERT INTO audit VALUES (?,?,?)")
      .run(randomUUID(), new Date().toISOString(), JSON.stringify(event));
  }
  approval(a: Record<string, unknown>) {
    this.db
      .prepare(
        "INSERT INTO approvals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(String(a.approval_id), JSON.stringify(a));
  }
  getApproval(id: string): any {
    const row = this.db
      .prepare("SELECT body FROM approvals WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  approvals(): any[] {
    return this.db
      .prepare("SELECT body FROM approvals ORDER BY rowid DESC LIMIT 1000")
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  activity(client: string, bot: string, limit: number) {
    return this.db
      .prepare(
        "SELECT timestamp, body FROM audit WHERE json_extract(body,'$.client_id')=? AND json_extract(body,'$.bot')=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(client, bot, limit)
      .map((r) => ({ timestamp: r.timestamp, ...JSON.parse(String(r.body)) }));
  }
  close() {
    this.db.close();
  }
}
