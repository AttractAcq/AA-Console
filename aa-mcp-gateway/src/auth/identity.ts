import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { bots, type Identity } from "../shared/types.js";
export const credentialSchema = z
  .array(
    z
      .object({
        token: z.string().min(32),
        bot: z.enum(bots),
        clients: z.array(z.string().uuid()).min(1),
      })
      .strict(),
  )
  .min(1);
export type Credential = z.infer<typeof credentialSchema>[number];
const hash = (s: string) => createHash("sha256").update(s).digest();
export function authenticate(
  header: string | undefined,
  credentials: Credential[],
): Identity {
  const token = /^Bearer ([^\s]+)$/.exec(header ?? "")?.[1];
  if (!token) throw new Error("unauthorized");
  const c = credentials.find((c) =>
    timingSafeEqual(hash(c.token), hash(token)),
  );
  if (!c) throw new Error("unauthorized");
  return { bot: c.bot, clients: [...c.clients] };
}
