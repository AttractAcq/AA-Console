import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { readJsonBody, UUID } from "../mcp/http.js";
import { admitPublicRequest } from "../public/quota.js";
import { CAPTURE_HTML } from "./portal.js";
import { PROOF_CATEGORIES } from "./taxonomy.js";
import { verifyCaptureFile } from "./files.js";
import { PRIVATE_OBJECT_CACHE_CONTROL_SECONDS } from "../storage/signed-url-policy.js";
export const hashCaptureToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function handlePublicProof(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/public/proof") {
    const nonce = randomBytes(18).toString("base64");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:; form-action 'self'; frame-ancestors 'none'`,
    });
    res.end(CAPTURE_HTML.replaceAll("__NONCE__", nonce));
    return;
  }
  if (
    req.method !== "POST" ||
    !["/public/proof/config", "/public/proof/submit"].includes(req.url ?? "")
  ) {
    json(404, { error: "Not found" });
    return;
  }
  const rawAuthorization = req.headers.authorization ?? "";
  const admitted = await admitPublicRequest(req, sb, config,
    req.url === "/public/proof/config" ? "proof_config" : "proof_submit", rawAuthorization);
  if (!admitted.allowed) {
    json(admitted.reason === "quota" ? 429 : 503, {
      error: admitted.reason === "quota" ? "Please try again shortly." : "Capture link unavailable.",
    });
    return;
  }
  const token = rawAuthorization.replace(/^Bearer /, "");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    json(404, { error: "Capture link unavailable." });
    return;
  }
  const hash = hashCaptureToken(token), now = Date.now();

  try {
    const { data: link, error } = await sb
      .from("proof_capture_links")
      .select("*")
      .eq("token_hash", hash)
      .maybeSingle();
    if (error) throw error;
    if (!link || link.revoked_at || Date.parse(link.expires_at) <= now) {
      json(404, { error: "Capture link unavailable." });
      return;
    }
    const { data: config, error: ce } = await sb
      .from("proof_capture_configs")
      .select("name,instructions")
      .eq("id", link.config_id)
      .eq("client_id", link.client_id)
      .maybeSingle();
    if (ce) throw ce;
    if (!config) {
      json(404, { error: "Capture link unavailable." });
      return;
    }
    if (req.url === "/public/proof/config") {
      if (link.submissions >= link.max_submissions) {
        json(410, { error: "This capture link has already been completed." });
        return;
      }
      json(200, { ok: true, ...config, categories: PROOF_CATEGORIES });
      return;
    }
    const body = await readJsonBody(req, 36 * 1024 * 1024);
    if (
      !UUID.test(String(body.submissionId ?? "")) ||
      body.consent !== true ||
      body.website ||
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 200 ||
      typeof body.body !== "string" ||
      !body.body.trim() ||
      body.body.length > 20000
    ) {
      json(400, {
        error:
          "Provide your name, evidence description and permission confirmation.",
      });
      return;
    }
    const kinds = PROOF_CATEGORIES[
      body.category as keyof typeof PROOF_CATEGORIES
    ] as readonly string[] | undefined;
    if (!kinds?.includes(String(body.kind))) {
      json(400, { error: "Choose a valid proof category and type." });
      return;
    }
    const { data: prior, error: pe } = await sb
      .from("proof_capture_submissions")
      .select("proof_id")
      .eq("id", body.submissionId)
      .eq("link_id", link.id)
      .maybeSingle();
    if (pe) throw pe;
    if (prior) {
      json(200, { ok: true });
      return;
    }
    if (link.submissions >= link.max_submissions) {
      json(410, { error: "This capture link has already been completed." });
      return;
    }
    let path: string | null = null;
    let mime: string | null = null;
    if (body.file) {
      if (
        typeof body.file !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.file)
      ) {
        json(400, { error: "Invalid attachment." });
        return;
      }
      const bytes = Buffer.from(body.file, "base64");
      mime = String(body.mime ?? "");
      if (!verifyCaptureFile(bytes, mime)) {
        json(400, {
          error:
            "Use a supported photo, video, voice recording or PDF up to 25 MB.",
        });
        return;
      }
      path = `${link.client_id}/capture/${link.id}/${body.submissionId}`;
      const { error: uploadError } = await sb.storage
        .from("proof")
        .upload(path, bytes, { contentType: mime, upsert: false, cacheControl: PRIVATE_OBJECT_CACHE_CONTROL_SECONDS });
      if (uploadError) {
        // Recover an identical upload after a lost response without overwriting evidence.
        const priorFile = await sb.storage.from("proof").download(path);
        if (
          priorFile.error ||
          !priorFile.data ||
          !Buffer.from(await priorFile.data.arrayBuffer()).equals(bytes)
        )
          throw uploadError;
      }
    }
    const { error: saveError } = await sb.rpc(
      "accept_proof_capture_submission",
      {
        p_token_hash: hash,
        p_submission_id: body.submissionId,
        p_name: body.name.trim(),
        p_job_reference: String(body.jobReference ?? "").slice(0, 500),
        p_body: body.body.trim(),
        p_storage_path: path,
        p_mime: mime,
        p_category: body.category,
        p_kind: body.kind,
        p_consent:
          "Submitter confirmed permission to submit for business review; publication requires separate clearance.",
      },
    );
    if (saveError) throw saveError;
    json(200, { ok: true });
  } catch {
    // Preserve uploads after ambiguous database errors; a committed submission may reference them.
    json(400, {
      error: "Could not accept this submission. Check the link and try again.",
    });
  }
}
