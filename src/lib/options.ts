import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import type { Option } from "../components/forms/fields";

/** Loads select options once, when the modal that needs them opens. */
export function useOptions(
  load: () => Promise<Option[]>,
  enabled: boolean,
  deps: unknown[] = [],
): Option[] {
  const [options, setOptions] = useState<Option[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setOptions(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return options;
}

export async function loadClients(): Promise<Option[]> {
  const { data } = await supabase.from("clients").select("id, name").order("name");
  return (data ?? []).map((c) => ({ value: c.id, label: c.name }));
}

export async function loadTeamMembers(): Promise<Option[]> {
  const { data } = await supabase
    .from("team_members")
    .select("id, name, category")
    .eq("active", true)
    .order("name");
  return (data ?? []).map((m) => ({ value: m.id, label: `${m.name} · ${m.category}` }));
}

export async function loadApprovedAssets(): Promise<Option[]> {
  const { data } = await supabase
    .from("client_media_assets")
    .select("id, ref_number, title")
    .eq("review_status", "approved")
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((a) => ({
    value: a.id,
    label: `${a.ref_number ?? "—"} · ${a.title ?? "Untitled"}`,
  }));
}

export async function loadBriefs(): Promise<Option[]> {
  const { data } = await supabase
    .from("client_briefs")
    .select("id, brief_ref, title, clients(name)")
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []).map((b) => {
    const client = (b as { clients?: { name: string } | null }).clients;
    return {
      value: b.id,
      label: `${b.brief_ref ?? "—"} · ${b.title}${client ? ` (${client.name})` : ""}`,
    };
  });
}

export async function loadAgents(): Promise<Option[]> {
  const { data } = await supabase.from("agents").select("agent_key, name").order("name");
  return (data ?? []).map((a) => ({ value: a.agent_key, label: a.name }));
}

export async function loadProofAssets(clientId: string): Promise<Option[]> {
  const { data } = await supabase
    .from("client_proof_assets")
    .select("id, title, media_type")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  return (data ?? []).map((p) => ({
    value: p.id,
    label: `${p.title ?? "Untitled"} · ${p.media_type}`,
  }));
}

export const MEDIA_TYPE_OPTIONS: Option[] = [
  { value: "image", label: "Image" },
  { value: "text", label: "Text" },
  { value: "video", label: "Video" },
];

export const ENGAGEMENT_OPTIONS: Option[] = [
  { value: "employee", label: "Employee" },
  { value: "contractor", label: "Contractor" },
];

export const PIPELINE_STAGE_OPTIONS: Option[] = [
  { value: "first_touch", label: "First Touch" },
  { value: "second_touch", label: "Second Touch" },
  { value: "call_booked", label: "Call Booked" },
];

export const CHANNEL_OPTIONS: Option[] = [
  { value: "organic", label: "Organic" },
  { value: "paid", label: "Paid" },
];

export const STATEMENT_OPTIONS: Option[] = [
  { value: "income", label: "Income Statement" },
  { value: "balance", label: "Balance Sheet" },
  { value: "cash_flow", label: "Cash Flow Statement" },
];

export const ACCESS_LEVEL_OPTIONS: Option[] = [
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
  { value: "admin", label: "Admin" },
];

export const TIER_OPTIONS: Option[] = [
  { value: "Growth", label: "Growth" },
  { value: "Scale", label: "Scale" },
  { value: "Enterprise", label: "Enterprise" },
  { value: "In-house", label: "In-house" },
];

/** Uploads a file to a bucket, then runs `then`. Removes the object if `then` fails. */
export async function uploadThen(
  bucket: string,
  path: string,
  file: File,
  then: (storagePath: string) => Promise<void>,
): Promise<void> {
  const { error: uploadError } = await supabase.storage.from(bucket).upload(path, file);
  if (uploadError) throw uploadError;
  try {
    await then(path);
  } catch (err) {
    await supabase.storage.from(bucket).remove([path]);
    throw err;
  }
}
