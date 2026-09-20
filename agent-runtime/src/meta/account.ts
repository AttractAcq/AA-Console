/**
 * Which ad account a client's paid work runs in.
 *
 * credential_label used to carry this as well as being the integration's
 * human name. Reading insights against a wrong value returns nothing and
 * somebody notices an empty report; creating a campaign against a wrong value
 * puts real money in somebody else's account, and Meta accepts it silently if
 * the token has access.
 *
 * So the column is preferred, the label is a fallback only while integrations
 * predate it, and anything not shaped like an account id is refused rather
 * than sent.
 */

const AD_ACCOUNT = /^act_[0-9]+$/;

export function isAdAccountId(value: unknown): value is string {
  return typeof value === "string" && AD_ACCOUNT.test(value);
}

export interface IntegrationRow {
  ad_account_id?: string | null;
  credential_label?: string | null;
}

/**
 * The account id to use, or a problem saying why there is none.
 *
 * The fallback is deliberately narrow: a credential_label is only accepted
 * when it is already shaped like an account id. A label reading "Main
 * account" is a name somebody typed, and treating it as an account is how a
 * write ends up addressed to nothing.
 */
export function adAccountFor(row: IntegrationRow): { id: string } | { problem: string } {
  const column = (row.ad_account_id ?? "").trim();
  if (column) {
    if (!isAdAccountId(column)) {
      return { problem: `"${column}" is not an ad account id. It should look like act_1234567890.` };
    }
    return { id: column };
  }

  const label = (row.credential_label ?? "").trim();
  if (isAdAccountId(label)) return { id: label };

  if (label) {
    return {
      problem: `This client has no ad account id recorded. "${label}" is the integration's name, not an account.`,
    };
  }
  return { problem: "This client has no ad account id recorded." };
}
