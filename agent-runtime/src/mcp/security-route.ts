import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

function uuidOf(body: Record<string, unknown>, key: string): string | undefined | false {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && UUID.test(value) ? value : false;
}

function limitOf(body: Record<string, unknown>): number | undefined | false {
  const limit = body.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return false;
  return limit;
}

function subset(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

const SEVERITY = new Set(["low", "medium", "high", "critical"]);
const KIND = new Set(["finding", "incident"]);

const routes: Record<string, Route> = {
  "/internal/mcp/security/create-finding": {
    rpc: "mcp_security_create_finding",
    kind: "write",
    maxBodyBytes: 16384,
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const title = body.title;
      const notes = body.notes;
      const severity = body.severity;
      const kind = body.kind === undefined ? "finding" : body.kind;
      if (
        client_id === undefined ||
        client_id === false ||
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 200 ||
        (notes !== null && (typeof notes !== "string" || notes.length > 2000)) ||
        typeof severity !== "string" ||
        !SEVERITY.has(severity) ||
        typeof kind !== "string" ||
        !KIND.has(kind) ||
        !subset(body, ["client_id", "title", "notes", "severity", "kind"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        p_title: title,
        p_notes: notes,
        p_severity: severity,
        p_kind: kind,
      };
    },
  },
  "/internal/mcp/security/get-open-findings": {
    rpc: "mcp_security_get_open_findings",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const after = uuidOf(body, "after");
      const finding_id = uuidOf(body, "finding_id");
      const limit = limitOf(body);
      if (
        client_id === undefined ||
        client_id === false ||
        after === false ||
        finding_id === false ||
        limit === false ||
        !subset(body, ["client_id", "limit", "after", "finding_id"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(after ? { p_after: after } : {}),
        ...(finding_id ? { p_finding_id: finding_id } : {}),
      };
    },
  },
  "/internal/mcp/security/get-incident-status": {
    rpc: "mcp_security_get_incident_status",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const after = uuidOf(body, "after");
      const incident_id = uuidOf(body, "incident_id");
      const limit = limitOf(body);
      if (
        client_id === undefined ||
        client_id === false ||
        after === false ||
        incident_id === false ||
        limit === false ||
        !subset(body, ["client_id", "limit", "after", "incident_id"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(after ? { p_after: after } : {}),
        ...(incident_id ? { p_incident_id: incident_id } : {}),
      };
    },
  },
  "/internal/mcp/security/get-system-status": {
    rpc: "mcp_security_get_system_status",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      if (
        client_id === undefined ||
        client_id === false ||
        !subset(body, ["client_id"])
      )
        return;
      return { p_bot_id: null, p_client_id: client_id };
    },
  },
};

export const handleMcpSecurity: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
