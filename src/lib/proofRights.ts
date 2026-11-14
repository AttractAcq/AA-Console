import { supabase } from "./supabase";

/** Download the same private proof bytes whose digest is on the Inbox card. */
export async function downloadVerifiedProofFile(
  storagePath: string, expectedSha256: string, expectedBytes: number,
): Promise<void> {
  const { data, error } = await supabase.storage.from("proof").download(storagePath);
  if (error || !data) throw new Error(error?.message ?? "Could not download the proof file.");
  const buffer = await data.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const actualSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actualSha256 !== expectedSha256 || buffer.byteLength !== expectedBytes) {
    throw new Error("Stored proof bytes differ from the exact version under review.");
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: data.type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = storagePath.split("/").at(-1) || "proof";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
