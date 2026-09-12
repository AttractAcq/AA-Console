import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

const routes: Record<string, Route> = {};
// Offset-bearing ISO instants only. No timezone engine or external providers.
function instant(v: unknown): boolean {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      v,
    )
  )
    return false;
  const day = v.slice(0, 10);
  return (
    Number.isFinite(Date.parse(v)) &&
    new Date(day).toISOString().slice(0, 10) === day
  );
}
for (const action of [
  "list_events",
  "get_event",
  "create_event",
  "update_event",
]) {
  const write = action === "create_event" || action === "update_event";
  routes[`/internal/mcp/admin/${action.replaceAll("_", "-")}`] = {
    rpc: `mcp_admin_${action}`,
    kind: write ? "write" : "read",
    maxBodyBytes: 16384,
    parse(body) {
      const fields = ["client_id"];
      if (action === "list_events")
        fields.push("limit", "after", "status", "due_before");
      else if (action !== "create_event") fields.push("event_id");
      if (write)
        fields.push(
          "title",
          "notes",
          "starts_at",
          "ends_at",
          ...(action === "create_event"
            ? ["event_type"]
            : ["status", "expected_version"]),
        );
      if (Object.keys(body).some((k) => !fields.includes(k))) return;
      if (typeof body.client_id !== "string" || !UUID.test(body.client_id))
        return;
      if (
        fields.includes("event_id") &&
        (typeof body.event_id !== "string" || !UUID.test(body.event_id))
      )
        return;
      if (
        body.after !== undefined &&
        (typeof body.after !== "string" || !UUID.test(body.after))
      )
        return;
      if (
        body.limit !== undefined &&
        (!Number.isInteger(body.limit) ||
          Number(body.limit) < 1 ||
          Number(body.limit) > 100)
      )
        return;
      if (body.due_before !== undefined && !instant(body.due_before)) return;
      if (
        body.status !== undefined &&
        !["scheduled", "completed", "cancelled"].includes(String(body.status))
      )
        return;
      if (body.event_type !== undefined && typeof body.event_type !== "string")
        return;
      if (body.status !== undefined && typeof body.status !== "string") return;
      if (write) {
        if (
          typeof body.title !== "string" ||
          !body.title.trim() ||
          body.title.length > 200
        )
          return;
        if (
          body.notes !== null &&
          (typeof body.notes !== "string" || body.notes.length > 2000)
        )
          return;
        if (
          !instant(body.starts_at) ||
          (body.ends_at !== null &&
            (!instant(body.ends_at) ||
              Date.parse(String(body.ends_at)) <=
                Date.parse(String(body.starts_at))))
        )
          return;
        if (
          action === "create_event" &&
          (!["meeting", "reminder", "admin"].includes(
            String(body.event_type),
          ) ||
            (body.event_type === "meeting" && body.ends_at === null))
        )
          return;
        if (
          action === "update_event" &&
          (!Number.isInteger(body.expected_version) ||
            Number(body.expected_version) < 1 ||
            Number(body.expected_version) > 2147483646 ||
            !["scheduled", "completed", "cancelled"].includes(
              String(body.status),
            ))
        )
          return;
      }
      return Object.fromEntries(
        Object.entries(body).map(([k, v]) => [`p_${k}`, v]),
      );
    },
  };
}
export const handleMcpAdmin: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
