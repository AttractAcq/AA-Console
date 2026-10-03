/**
 * Small helpers for the Meta build section of a campaign.
 */

/** "za, gb ,US" → ["ZA","GB","US"], or a reason it cannot be. */
export function parseCountries(text: string): { codes: string[] } | { problem: string } {
  const codes = [...new Set(text.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const bad = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
  if (bad.length > 0) return { problem: `${bad.join(", ")} ${bad.length === 1 ? "is not a" : "are not"} two-letter country code${bad.length === 1 ? "" : "s"}.` };
  if (codes.length === 0) return { problem: "Name at least one country." };
  return { codes };
}

/**
 * A Meta object id as typed by a person, or a reason it is not one.
 *
 * Only needed because a campaign built by hand in Ads Manager — which is what
 * happens when there is no usable token — leaves the console with no record of
 * what exists. Until the ids are here, reporting cannot match the spend
 * against the campaign, and a later automated build creates a second campaign
 * beside the one already in the account.
 *
 * Strict about shape rather than forgiving: Meta's ids are bare digits, and the
 * things people paste instead are an Ads Manager URL or an act_ account id.
 * Storing either would point reporting at nothing, silently.
 */
export function parseMetaObjectId(text: string, label: string): { id: string } | { problem: string } {
  const value = text.trim();
  if (!value) return { problem: `Enter the ${label}.` };
  if (/^act_/.test(value)) {
    return { problem: `That is an ad account id, not the ${label}.` };
  }
  if (!/^[0-9]+$/.test(value)) {
    return { problem: `A ${label} is all digits. Copy it from the id column in Ads Manager, not from the address bar.` };
  }
  return { id: value };
}

/** Ads Manager, opened on the campaign this built. */
export function adsManagerUrl(accountId: string, campaignId: string): string {
  const act = accountId.replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}&selected_campaign_ids=${campaignId}`;
}
