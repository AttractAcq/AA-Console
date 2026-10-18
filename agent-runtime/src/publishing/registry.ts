/**
 * Which adapter posts to which platform.
 *
 * A platform with no adapter is not an error here: platform_publishing says
 * `supported = false` for it and the queue never claims one, so this map and
 * that table have to agree. The test asserts they do, because the failure
 * mode of them disagreeing is a post claimed and then immediately failed.
 */

import type { Platform } from "../content/platform-limits.js";
import type { PublishAdapter } from "./types.js";
import { facebookAdapter, instagramAdapter } from "./meta.js";

const ADAPTERS: readonly PublishAdapter[] = [instagramAdapter, facebookAdapter];

export function adapterFor(platform: string): PublishAdapter | null {
  return ADAPTERS.find((a) => (a.platforms as readonly string[]).includes(platform)) ?? null;
}

export function supportedPlatforms(): Platform[] {
  return ADAPTERS.flatMap((a) => [...a.platforms]);
}
