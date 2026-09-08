import { z } from "zod";
export const bots = [
  "bot_chief_of_staff",
  "bot_client_delivery",
  "bot_marketing",
  "bot_production",
  "bot_distribution",
  "bot_sales_ops",
  "bot_admin",
  "bot_finance",
  "bot_engineering",
  "bot_security_devops",
] as const;
export type Bot = (typeof bots)[number];
export type Identity = {
  bot: Bot;
  clients: string[];
  /** AA grant patterns. Set in `BOT_AUTH_MODE=db`; omitted identities use the code matrix. */
  permissions?: string[];
};
export const resultSchema = z
  .object({
    status: z.enum([
      "completed",
      "accepted",
      "not_implemented",
      "approval_required",
      "rejected",
      "failed",
      "indeterminate",
    ]),
    capability: z.string(),
    request_id: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: z.string(),
        upstream_status: z.number().int().optional(),
      })
      .strict()
      .optional(),
    approval_id: z.string().optional(),
    message: z.string().optional(),
    required_dependency: z.string().optional(),
  })
  .strict();
export type Result = z.infer<typeof resultSchema>;
export type Tool = {
  name: string;
  domain: string;
  description: string;
  input: z.ZodObject;
  output: typeof resultSchema;
  risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  permissions: string[];
  approval: boolean;
  action: "read" | "write";
  reversible: boolean;
  audit: "required";
  implementation: "real" | "partial" | "stub";
  dependency: string;
};
export type Context = Identity & { request_id: string; execution_id: string };
export interface Adapter {
  execute(
    tool: Tool,
    input: Record<string, unknown>,
    context: Context,
  ): Promise<Omit<Result, "request_id">>;
}
