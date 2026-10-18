import type { Adapter, Context, Tool } from "../../shared/types.js";

/** content.* dispatch. create_upload_url and submit_asset share this path with the other content tools. */
export class ContentService {
  constructor(private adapter: Adapter) {}
  execute(tool: Tool, input: Record<string, unknown>, context: Context) {
    return this.adapter.execute(tool, input, context);
  }
  generateBrief(tool: Tool, input: Record<string, unknown>, context: Context) {
    return this.execute(tool, input, context);
  }
}
