import { useMemo } from "react";
import { FormModal } from "./forms/FormModal";
import type { FieldDef } from "./forms/fields";
import { META_CTAS } from "../lib/metaCta";
import { adCopyProblems, draftAdCopy, HEADLINE_LIMIT, mergeCopy, toColumns, type AdCopy } from "../lib/adCopy";
import { supabase } from "../lib/supabase";

export type AdCopyAsset = {
  id: string;
  title: string | null;
  ad_primary_text?: string | null;
  ad_headline?: string | null;
  ad_description?: string | null;
  ad_link_url?: string | null;
  ad_cta?: string | null;
  meta_ad_id?: string | null;
};

export type AdCopyBrief = {
  title?: string | null;
  hook?: string | null;
  premise?: string | null;
  argument?: string | null;
  call_to_action?: string | null;
};

/**
 * The words that turn an approved asset into a Meta ad.
 *
 * Opens on the saved copy, with anything blank drafted from the brief, so the
 * first visit is an edit rather than a blank form. Saving copy is what puts an
 * asset into the campaign's next Meta build.
 */
export function AdCopyModal({
  asset,
  brief,
  landingUrl,
  allowedCtas,
  open,
  onClose,
  onSaved,
}: {
  asset: AdCopyAsset | null;
  brief: AdCopyBrief | null;
  landingUrl: string | null;
  allowedCtas: readonly string[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialValues = useMemo(() => {
    if (!asset) return undefined;
    const draft = draftAdCopy({ brief, landingUrl, allowedCtas });
    return mergeCopy(asset, draft);
  }, [asset, brief, landingUrl, allowedCtas]);

  const fields = useMemo<FieldDef[]>(() => {
    const buttons = META_CTAS.filter((c) => allowedCtas.length === 0 || allowedCtas.includes(c.value));
    return [
      {
        name: "ad_primary_text",
        label: "Primary text",
        kind: "textarea",
        rows: 5,
        required: true,
        hint: "The words above the image.",
      },
      {
        name: "ad_headline",
        label: "Headline",
        kind: "text",
        required: true,
        hint: `The bold line under the image. Meta cuts most placements off around ${HEADLINE_LIMIT} characters.`,
      },
      { name: "ad_description", label: "Description (optional)", kind: "text", hint: "Often not shown, depending on placement." },
      {
        name: "ad_link_url",
        label: "Link",
        kind: "text",
        required: true,
        placeholder: "https://",
        hint: "Where the ad sends people. Drafted from the campaign's landing page when it has a published one.",
      },
      {
        name: "ad_cta",
        label: "Button",
        kind: "select",
        // The select's own blank option is "no button".
        options: buttons.map((c) => ({ value: c.value, label: c.label })),
        hint:
          allowedCtas.length > 0
            ? "Only the buttons this campaign's template can serve are offered. Leave blank for none."
            : "Leave blank for none.",
      },
    ];
  }, [allowedCtas]);

  return (
    <FormModal
      open={open && asset !== null}
      onClose={onClose}
      title={`Ad copy · ${asset?.title ?? "asset"}`}
      intro={
        asset?.meta_ad_id
          ? "This asset is already built in Meta. Changes here are saved but do not change the ad that exists; edit that in Ads Manager."
          : "Saving copy puts this asset into the campaign's next Meta build. Blank fields were drafted from the brief — edit them before saving."
      }
      fields={fields}
      // The panel behind this refreshes live, which hands it new rows. The
      // draft is what keeps half-written copy through that.
      draftKey={asset ? `ad-copy:${asset.id}` : undefined}
      initialValues={initialValues as Record<string, string> | undefined}
      submitLabel="Save ad copy"
      onSubmit={async (values) => {
        if (!asset) throw new Error("No asset selected.");
        const copy = values as unknown as AdCopy;
        const problems = adCopyProblems(copy, allowedCtas);
        if (problems.length > 0) throw new Error(problems.join(" "));
        const { error } = await supabase.from("client_media_assets").update(toColumns(copy)).eq("id", asset.id);
        if (error) throw new Error(error.message);
      }}
      onSaved={onSaved}
    />
  );
}
