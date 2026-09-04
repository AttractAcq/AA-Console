// Service-role Supabase client for the runtime.
//
// The `ws` transport below is load-bearing, not decoration. @supabase/supabase-js
// unconditionally constructs a Realtime client even though this service never
// subscribes to anything — only .from() and .rpc() are used — and that Realtime
// client throws AT CONSTRUCTION TIME when there is no native WebSocket global
// ("Node.js detected but native WebSocket not found"). In the v5 runtime this
// crashed every container start regardless of engines.node, because hosting
// platforms do not reliably honour engines.node / .node-version. Passing `ws`
// explicitly makes construction succeed on any Node version, so the service
// does not depend on the platform getting the runtime version right.
//
// Do not "clean this up".

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import WebSocket from "ws";
import type { RuntimeConfig } from "./config.js";

// ws's constructor is a structural match for realtime-js's
// WebSocketLikeConstructor but not identical to lib.dom's WebSocket — this
// cast is the documented pattern for supplying a Node WebSocket polyfill.
const wsTransport = WebSocket as unknown as WebSocketLikeConstructor;

export function serviceClient(config: RuntimeConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: wsTransport },
  });
}
