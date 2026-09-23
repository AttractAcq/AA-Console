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

/** Ads Manager, opened on the campaign this built. */
export function adsManagerUrl(accountId: string, campaignId: string): string {
  const act = accountId.replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}&selected_campaign_ids=${campaignId}`;
}
