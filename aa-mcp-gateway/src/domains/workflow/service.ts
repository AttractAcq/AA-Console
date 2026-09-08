import type { Store } from "../../audit/store.js";
import type { Context, Result, Tool } from "../../shared/types.js";

/** Gateway control-plane reviews are distinct from AA delivery/production tasks. */
export class WorkflowService {
  constructor(private store: Store) {}
  execute(
    tool: Tool,
    input: Record<string, unknown>,
    context: Context,
  ): Omit<Result, "request_id"> | undefined {
    if (tool.name === "workflow.get_pending_approvals")
      return {
        status: "completed",
        capability: tool.name,
        data: {
          approvals: this.store
            .approvals()
            .filter(
              (a) =>
                a.requested_by_bot === context.bot &&
                a.client_id === input.client_id &&
                a.status === "pending" &&
                Date.parse(a.expires_at) > Date.now(),
            )
            .slice(0, Number(input.limit)),
        },
      };
    if (tool.name === "workflow.get_activity")
      return {
        status: "completed",
        capability: tool.name,
        data: {
          activity: this.store.activity(
            String(input.client_id),
            context.bot,
            Number(input.limit),
          ),
        },
      };
    if (tool.name === "workflow.create_approval")
      return {
        status: "completed",
        capability: tool.name,
        data: {
          decision: "approved",
          message: "Informational approval; no downstream action executed.",
        },
      };
    return undefined;
  }
}
