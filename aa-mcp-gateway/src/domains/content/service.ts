import type { Adapter, Context, Tool } from "../../shared/types.js";
export class ContentService {
  constructor(private adapter: Adapter) {}
  generateBrief(tool: Tool, input: Record<string, unknown>, context: Context) {
    return this.adapter.execute(tool, input, context);
  }
}
