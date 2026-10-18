import { CONTENT_FORMATS, formatAllows } from "../../lib/contentFormat";
import { CAPTURE_METHODS, PROOF_CATEGORIES, categoryLabel } from "../../lib/proofFactory";
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
  classify = false,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string | undefined;
  onSaved?: () => void;
  classify?: boolean;
}) {
  return (
    <FormModal
      open={open}
      onClose={onClose}
      title="Add Proof"
      draftKey={`proof:${clientId}`}
      intro="Write the proof, attach a file, or do both. Files upload to your private proof store."
      fields={classify ? [...FIELDS,
        { name: "source_format", label: "Source format", kind: "select", required: true, options: CONTENT_FORMATS.map((f) => ({value: f.value, label: f.label})) },
        { name: "capture_method", label: "Capture method", kind: "select", required: true, options: CAPTURE_METHODS.map((m) => ({ value: m.id, label: m.label })) },
        { name: "source_category", label: "Proof category", kind: "select", required: true, options: Object.keys(PROOF_CATEGORIES).map((value) => ({ value, label: categoryLabel(value) })) },
        ...Object.entries(PROOF_CATEGORIES).map(([category, types]): FieldDef => ({ name: `kind_${category}`, label: "Proof type", kind: "select", required: true, showIf: { field: "source_category", equals: [category] }, options: types.map((value) => ({ value, label: value })) })),
      ] : FIELDS}
      initialValues={classify ? { capture_method: "manual_import", source_format: "single" } : undefined}
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

        const category = v.source_category as keyof typeof PROOF_CATEGORIES;
        const kind = v[`kind_${category}`] as string;
        if (classify && !(PROOF_CATEGORIES[category] as readonly string[] | undefined)?.includes(kind)) throw new Error("Choose a proof type in the selected category.");
        const sourceFormat = v.source_format as "single" | "carousel" | "story" | "reel";
        if (classify && !formatAllows(sourceFormat, mediaType)) throw new Error("Choose a format compatible with the media type.");
        const classification = classify ? { source_format: sourceFormat, capture_method: v.capture_method as string, source_category: category, source_kind: kind } : {};
        const proofId = crypto.randomUUID();

        if (!file) {
          const { error } = await supabase.from("client_proof_assets").insert({
            ...classification,
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
            ...classification,
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
