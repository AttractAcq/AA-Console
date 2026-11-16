import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import { AuthError, BOT_FORBIDDEN_CODE, requireAdminOrClientManager } from "../master/auth.js";
import { readJsonBody, UUID } from "../mcp/http.js";
import { hashCaptureToken } from "./public-route.js";
export const captureBase = () =>
  (
    process.env.PROOF_CAPTURE_PUBLIC_URL ??
    "https://runtime.attractacq.com/public/proof"
  ).replace(/\/$/, "");
export function deliveryChannelAvailable(
  channel: string,
  config: RuntimeConfig,
): boolean {
  if (channel === "email") return Boolean(config.resendApiKey);
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (channel === "sms"
        ? process.env.TWILIO_SMS_FROM
        : channel === "whatsapp"
          ? process.env.TWILIO_WHATSAPP_FROM &&
            process.env.TWILIO_PROOF_WHATSAPP_CONTENT_SID
          : null),
  );
}
export async function handleProofCaptureAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): Promise<void> {
  const json = (status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  if (req.method !== "POST") {
    json(405, { ok: false, error: "POST only" });
    return;
  }
  try {
    const body = await readJsonBody(req, 30000),
      clientId = String(body.clientId ?? "");
    if (!UUID.test(clientId)) {
      json(400, { ok: false, error: "Select a client." });
      return;
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    let userId: string | null = null;
    if (req.url === "/internal/proof-capture/event") {
      const secret = config.mcpServiceSecret;
      if (
        !secret ||
        Buffer.byteLength(token) !== Buffer.byteLength(secret) ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(secret))
      ) {
        json(401, { ok: false, error: "Not permitted." });
        return;
      }
      body.action = "queue_delivery";
    } else {
      try {
        const caller = await requireAdminOrClientManager(sb, req.headers.authorization, clientId);
        userId = caller.userId;
      } catch (err) {
        const status = err instanceof AuthError ? err.status : 401;
        json(status, {
          ok: false,
          error:
            err instanceof AuthError && err.code === BOT_FORBIDDEN_CODE
              ? BOT_FORBIDDEN_CODE
              : err instanceof AuthError
                ? err.message
                : "Not permitted.",
        });
        return;
      }
    }
    if (body.action === "list") {
      if(!UUID.test(String(body.configId??""))) {json(400,{ok:false,error:"Select a capture setup."});return;}
      const [l, d] = await Promise.all([
        sb
          .from("proof_capture_links")
          .select(
            "id,config_id,expires_at,revoked_at,submissions,max_submissions,created_at",
          )
          .eq("client_id", clientId)
          .eq("config_id",body.configId)
          .order("created_at", { ascending: false })
          .limit(100),
        sb
          .from("proof_request_deliveries")
          .select(
            "id,config_id,channel,recipient,subject,message,scheduled_at,status,error,provider_id,created_at",
          )
          .eq("client_id", clientId)
          .eq("config_id",body.configId)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      if (l.error || d.error) throw l.error ?? d.error;
      json(200, {
        ok: true,
        links: l.data,
        deliveries: d.data,
        channels: ["email", "sms", "whatsapp"].filter((c) =>
          deliveryChannelAvailable(c, config),
        ),
      });
      return;
    }
    if (body.action === "revoke") {
      if (!UUID.test(String(body.linkId ?? "")))
        throw new Error("Select a link.");
      const { error } = await sb
        .from("proof_capture_links")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", body.linkId)
        .eq("client_id", clientId);
      if (error) throw error;
      json(200, { ok: true });
      return;
    }
    if (!["create_link", "queue_delivery"].includes(String(body.action))) {
      json(400, { ok: false, error: "Unknown capture action." });
      return;
    }
    const { data: setup, error: ce } = await sb
      .from("proof_capture_configs")
      .select("*")
      .eq("id", body.configId)
      .eq("client_id", clientId)
      .maybeSingle();
    if (ce || !setup) {
      json(404, { ok: false, error: "Capture setup unavailable." });
      return;
    }
    if (body.action === "create_link" && setup.method === "outcome_followup") {
      json(400, { ok: false, error: "Outcome follow-up links must be bound to a sale and consent." });
      return;
    }
    let scheduled = new Date(),
      channel = "",
      recipient = "",
      eventKey = "";
    let outcomeLeadId: string | null = null;
    let outcomeConsentId: string | null = null;
    let outcomeEventId: string | null = null;
    let outcomeCustomerName = "";
    if (body.action === "queue_delivery") {
      if (setup.method !== "automated_requests" && setup.method !== "outcome_followup") {
        json(400, { ok: false, error: "Choose a request delivery setup." });
        return;
      }
      if (setup.method === "outcome_followup") {
        outcomeLeadId = String(body.leadId ?? "");
        outcomeConsentId = String(body.consentId ?? "");
        outcomeEventId = String(body.eventId ?? "");
        if (!UUID.test(outcomeLeadId) || !UUID.test(outcomeConsentId) || !UUID.test(outcomeEventId)) {
          json(400, { ok: false, error: "Select a verified service result and its separate proof follow-up consent." });
          return;
        }
        const [{ data: lead, error: leadError }, { data: consent, error: consentError },
          { data: event, error: eventError }] = await Promise.all([
          sb.from("client_leads").select("id,name,stage,email,phone")
            .eq("id", outcomeLeadId).eq("client_id", clientId).maybeSingle(),
          sb.from("proof_outcome_followup_consents_v7")
            .select("id,lead_id,channel,recipient,withdrawn_at")
            .eq("id", outcomeConsentId).eq("client_id", clientId).maybeSingle(),
          sb.from("proof_service_outcomes_v7")
            .select("id,lead_id,verified_at,withdrawn_at")
            .eq("id", outcomeEventId).eq("client_id", clientId).maybeSingle(),
        ]);
        if (leadError || consentError || eventError) throw leadError ?? consentError ?? eventError;
        if (!lead || !consent || !event || !["sale", "cash"].includes(lead.stage)
            || consent.lead_id !== lead.id || consent.withdrawn_at
            || event.lead_id !== lead.id || !event.verified_at || event.withdrawn_at
            || (consent.channel === "email" &&
              consent.recipient.trim().toLowerCase() !== String(lead.email ?? "").trim().toLowerCase())
            || (consent.channel !== "email" &&
              consent.recipient.trim() !== String(lead.phone ?? "").trim())
            || (setup.trigger_event && setup.trigger_event !== "service_completed"
              && setup.trigger_event !== lead.stage)) {
          json(400, { ok: false, error: "The service result, sale, contact or proof follow-up consent is no longer current." });
          return;
        }
        channel = consent.channel;
        recipient = consent.recipient.trim();
        outcomeCustomerName = String(lead.name ?? "").slice(0, 200);
        eventKey = `outcome:${setup.id}:${event.id}:${consent.id}`;
      } else {
        channel = String(body.channel ?? "email");
        recipient = String(body.recipient ?? "").trim();
        eventKey = String(body.eventKey ?? "");
      }
      if (!deliveryChannelAvailable(channel, config)) {
        json(400, {
          ok: false,
          error: "This channel is not configured on the server.",
        });
        return;
      }
      if (
        (channel === "email" &&
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) ||
        (channel !== "email" && !/^\+[1-9]\d{7,14}$/.test(recipient)) ||
        recipient.length > 320 ||
        !eventKey ||
        eventKey.length > 200
      ) {
        json(400, {
          ok: false,
          error:
            "Provide a valid recipient and unique service event reference.",
        });
        return;
      }
      if (!setup.message_template?.trim()) {
        json(400, {
          ok: false,
          error: "Save a request message before queueing delivery.",
        });
        return;
      }
      if (setup.method === "automated_requests" && setup.trigger_event && body.triggerEvent !== setup.trigger_event) {
        json(400, {
          ok: false,
          error: "This event does not match the configured trigger.",
        });
        return;
      }
      scheduled = body.scheduledAt
        ? new Date(String(body.scheduledAt))
        : new Date();
      if (
        !Number.isFinite(scheduled.getTime()) ||
        scheduled.getTime() > Date.now() + 366 * 86400000
      ) {
        json(400, { ok: false, error: "Choose a date within the next year." });
        return;
      }
      const { data: existing, error: ee } = await sb
        .from("proof_request_deliveries")
        .select("id,config_id,recipient,channel")
        .eq("client_id", clientId)
        .eq("event_key", eventKey)
        .maybeSingle();
      if (ee) throw ee;
      if (existing) {
        if (
          existing.config_id !== setup.id ||
          existing.recipient !== recipient ||
          existing.channel !== channel
        ) {
          json(409, {
            ok: false,
            error: "Event reference already used for a different request.",
          });
          return;
        }
        json(200, { ok: true, deliveryId: existing.id });
        return;
      }
    }
    let whatsappTemplate: string | null = null;
    if (channel === "whatsapp") {
      const response = await fetch(
        `https://content.twilio.com/v1/Content/${encodeURIComponent(process.env.TWILIO_PROOF_WHATSAPP_CONTENT_SID!)}`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
      const template = (await response.json()) as {
        types?: Record<string, { body?: string }>;
      };
      whatsappTemplate = template.types?.["twilio/text"]?.body ?? null;
      if (
        !response.ok ||
        !whatsappTemplate ||
        !whatsappTemplate.includes("{{1}}") ||
        /\{\{(?!1\}\})/.test(whatsappTemplate)
      ) {
        json(400, {
          ok: false,
          error:
            "Configure a Twilio text template with one variable (1) for the evidence request. The template must be WhatsApp approved.",
        });
        return;
      }
    }
    const raw = randomBytes(32).toString("hex"),
      linkId = randomUUID();
    const expires = new Date(
      Math.max(Date.now(), scheduled.getTime()) + 14 * 86400000,
    ).toISOString();
    const max =
      body.action === "queue_delivery"
        ? 1
        : Math.min(100, Math.max(1, Number(body.maxSubmissions) || 1));
    if (!Number.isInteger(max)) {
      json(400, { ok: false, error: "Choose a whole number of submissions." });
      return;
    }
    const { error: le } = await sb
      .from("proof_capture_links")
      .insert({
        id: linkId,
        client_id: clientId,
        config_id: setup.id,
        token_hash: hashCaptureToken(raw),
        expires_at: expires,
        max_submissions: max,
        created_by: userId,
      });
    if (le) throw le;
    const url = `${captureBase()}#${raw}`;
    if (body.action === "create_link") {
      json(200, { ok: true, url, expiresAt: expires });
      return;
    }
    const id = randomUUID();
    const message = String(setup.message_template)
      .replaceAll("{{capture_link}}", url)
      .replaceAll(
        "{{customer_name}}",
        setup.method === "outcome_followup" ? outcomeCustomerName
          : String(body.customerName ?? "").slice(0, 200),
      );
    const requestMessage = message.includes(url)
      ? message
      : `${message}\n\n${url}`;
    const { error: de } = await sb
      .from("proof_request_deliveries")
      .insert({
        id,
        client_id: clientId,
        config_id: setup.id,
        link_id: linkId,
        event_key: eventKey,
        outcome_lead_id: outcomeLeadId,
        outcome_consent_id: outcomeConsentId,
        outcome_event_id: outcomeEventId,
        recipient,
        channel,
        subject: setup.name,
        message: whatsappTemplate
          ? whatsappTemplate.replaceAll("{{1}}", requestMessage)
          : requestMessage,
        template_variables: whatsappTemplate ? { "1": requestMessage } : null,
        template_sid:
          channel === "whatsapp"
            ? process.env.TWILIO_PROOF_WHATSAPP_CONTENT_SID
            : null,
        capture_url: url,
        scheduled_at: scheduled.toISOString(),
      });
    if (de) {
      await sb.from("proof_capture_links").delete().eq("id", linkId);
      if (de.code === "23505") {
        json(409, {
          ok: false,
          error: "This event was already queued. Refresh the delivery list.",
        });
        return;
      }
      throw de;
    }
    json(200, { ok: true, deliveryId: id });
  } catch {
    json(400, {
      ok: false,
      error: "Could not save this capture action. Check the input and retry.",
    });
  }
}
