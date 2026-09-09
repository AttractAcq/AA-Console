import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

const routes: Record<string, Route> = {};
const workflow = [
  "list_tasks",
  "get_task",
  "create_task",
  "assign_task",
  "complete_task",
];
for (const [domain, actions] of Object.entries({
  workflow,
  campaign: ["list", "get", "get_status"],
  attribution: ["get_campaign_performance"],
})) {
  for (const action of actions) {
    const write = ["create_task", "assign_task", "complete_task"].includes(
      action,
    );
    routes[`/internal/mcp/${domain}/${action.replaceAll("_", "-")}`] = {
      rpc: domain === "workflow" ? "mcp_workflow_task" : "mcp_campaign_read",
      kind: write ? "write" : "read",
      parse(body) {
        const fields = ["client_id"];
        if (["list", "list_tasks"].includes(action))
          fields.push("limit", "after");
        else if (action !== "create_task")
          fields.push(domain === "workflow" ? "task_id" : "campaign_id");
        if (action === "create_task") fields.push("title", "summary");
        if (action === "assign_task") fields.push("assignee");
        if (domain === "attribution") fields.push("start_date", "end_date");
        if (Object.keys(body).some((k) => !fields.includes(k)))
          return undefined;
        for (const key of fields.filter((k) => k.endsWith("_id"))) {
          if (typeof body[key] !== "string" || !UUID.test(body[key] as string))
            return undefined;
        }
        if (
          body.after !== undefined &&
          (typeof body.after !== "string" || !UUID.test(body.after))
        )
          return undefined;
        if (
          body.limit !== undefined &&
          (typeof body.limit !== "number" ||
            !Number.isInteger(body.limit) ||
            body.limit < 1 ||
            body.limit > 100)
        )
          return undefined;
        if (
          action === "create_task" &&
          (typeof body.title !== "string" ||
            !body.title.trim() ||
            body.title.length > 200)
        )
          return undefined;
        if (
          body.summary !== undefined &&
          (typeof body.summary !== "string" || body.summary.length > 4000)
        )
          return undefined;
        if (
          action === "assign_task" &&
          (typeof body.assignee !== "string" ||
            !/^(bot_[a-z0-9_]{1,60}|member:[0-9a-fA-F-]{36})$/.test(
              body.assignee,
            ))
        )
          return undefined;
        for (const key of ["start_date", "end_date"]) {
          const value = body[key];
          if (
            value !== undefined &&
            (typeof value !== "string" ||
              !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
              !Number.isFinite(Date.parse(value)) ||
              new Date(value).toISOString().slice(0, 10) !== value)
          )
            return undefined;
        }
        return {
          p_action: action,
          ...Object.fromEntries(
            Object.entries(body).map(([k, v]) => [`p_${k}`, v]),
          ),
        };
      },
    };
  }
}
export const handleMcpOrchestration: typeof handleMcpContent = (
  req,
  res,
  sb,
  secret,
) => handleMcpContent(req, res, sb, secret, routes);
