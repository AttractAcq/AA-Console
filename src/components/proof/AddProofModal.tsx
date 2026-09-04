import { FormModal } from "../forms/FormModal";
import type { FieldDef } from "../forms/fields";
import { MEDIA_TYPE_OPTIONS, uploadThen } from "../../lib/options";
import { supabase } from "../../lib/supabase";
import type { ProofAsset } from "../../lib/media";

/**
 * Proof can be written, uploaded, or both — a testimonial alongside a
 * screenshot of it. That is why client_proof_assets allows a row with no
 * storage_path, and why proof_has_content only requires one of the two.
 * Shared by the admin Proof Bank and the client's own dashboard.
 */
const FIELDS: FieldDef[] = [
  {
    name: "media_type",
    label: "Type",
    kind: "select",
    required: true,
    options: MEDIA_TYPE_OPTIONS,
  },
  {
    name: "body",
    label: "Written proof",
    kind: "textarea",
    rows: 5,
    placeholder: "Paste the testimonial, review or result",
    hint: "Required for text proof. Optional caption for an image or video.",
  },
  {
    name: "file",
    label: "Image or video",
    kind: "file",
    accept: "image/*,video/*",
    hint: "Required for image and video proof. Attach one to written proof too — a screenshot of the review, say.",
  },
  { name: "title", label: "Title", kind: "text" },
  {
    name: "source",
    label: "Who / where from",
    kind: "text",
    placeholder: "Client name, platform, or where it came from",
  },
];

export function AddProofModal({
  open,
  onClose,
  clientId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string | undefined;
  onSaved?: () => void;
}) {
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title="Add Proof"
      draftKey={`proof:${clientId}`}
      intro="Write the proof, attach a file, or do both. Files upload to your private proof store."
      fields={FIELDS}
      submitLabel="Add proof"
      onSubmit={async (v) => {
        if (!clientId) throw new Error("No client selected.");
        const mediaType = v.media_type as ProofAsset["media_type"];
        const title = (v.title as string)?.trim() || null;
        const source = (v.source as string)?.trim() || null;
        const body = (v.body as string)?.trim() || null;
        const file = v.file instanceof File ? v.file : null;

        // Either half is enough on its own, which is what the
        // proof_has_content constraint enforces at the database too.
        if (mediaType === "text" && !body) {
          throw new Error("Written proof needs some text.");
        }
        if (mediaType !== "text" && !file) {
          throw new Error(`${mediaType === "video" ? "Video" : "Image"} proof needs a file.`);
        }

        const proofId = crypto.randomUUID();

        if (!file) {
          const { error } = await supabase.from("client_proof_assets").insert({
            id: proofId,
            client_id: clientId,
            media_type: mediaType,
            title,
            source,
            body,
          });
          if (error) throw error;
          return;
        }

        const path = `${clientId}/${proofId}/${file.name}`;
        await uploadThen("proof", path, file, async (storagePath) => {
          const { error } = await supabase.from("client_proof_assets").insert({
            id: proofId,
            client_id: clientId,
            media_type: mediaType,
            title: title ?? file.name,
            source,
            body,
            storage_path: storagePath,
          });
          if (error) throw error;
        });
      }}
      onSaved={onSaved}
    />
  );
}
