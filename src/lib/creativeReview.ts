import { callRuntime } from "./callRuntime";
import { supabase } from "./supabase";

/** Verify actual Storage bytes before creating an exact creative review card. */
export async function requestOrdinaryMediaReview(clientId: string, assetId: string): Promise<string> {
  await callRuntime<{ assetId: string }>("/admin/creative/attest-asset", { clientId, assetId });
  const { data, error } = await supabase.rpc("request_ordinary_media_review_v6", {
    p_asset_id: assetId,
  });
  if (error || !data) throw new Error(error?.message ?? "Could not request creative review.");
  return data;
}

/** Attach trusted single-file bytes to an Engine slot's existing Inbox entry. */
export async function requestEngineSlotReview(
  clientId: string, slotId: string, assetId: string,
): Promise<string> {
  await callRuntime<{ assetId: string }>("/admin/creative/attest-asset", { clientId, assetId });
  const { data, error } = await supabase.rpc("request_engine_slot_exact_review_v6", {
    p_slot_id: slotId,
  });
  if (error || !data) throw new Error(error?.message ?? "Could not prepare Engine slot review.");
  return data;
}

/** Verify the finished render, then create the assigned seat's exact Inbox card. */
export async function requestVideoSeatReview(
  clientId: string, assetId: string, role: "owner" | "manager" | "client",
): Promise<string> {
  await callRuntime<{ assetId: string }>("/admin/creative/attest-asset", { clientId, assetId });
  const { data, error } = await supabase.rpc("request_video_seat_review_v6", {
    p_asset_id: assetId, p_role: role,
  });
  if (error || !data) throw new Error(error?.message ?? "Could not request video signoff.");
  return data;
}

/** Verify a motion candidate's stored MP4 before freezing its review packet. */
export async function requestMotionRenderReview(clientId: string, candidateId: string): Promise<string> {
  await callRuntime<{ candidateId: string }>("/admin/motion/attest-render", { clientId, candidateId });
  const { data, error } = await supabase.rpc("request_motion_render_review_v6", {
    p_candidate_id: candidateId,
  });
  if (error || !data) throw new Error(error?.message ?? "Could not request motion render review.");
  return data;
}

/** The reviewer downloads and checks the same file digest shown on the card. */
export async function downloadVerifiedCreativeFile(
  storagePath: string, expectedSha256: string,
): Promise<void> {
  const { data, error } = await supabase.storage.from("client-media").download(storagePath);
  if (error || !data) throw new Error(error?.message ?? "Could not download the creative file.");
  const buffer = await data.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (buffer.byteLength === 0 || actual !== expectedSha256) {
    throw new Error("Stored creative bytes differ from the exact version under review.");
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: data.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = storagePath.split("/").at(-1) || "creative";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
