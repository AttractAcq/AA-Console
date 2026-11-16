/** A reviewed, no-script form saved into the page revision before approval. */
const MARKER = "<!-- aa-page-capture-form -->";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]!);

export function appendPageCaptureForm(html: string, runtimeBase: string, token: string, consentWording: string): string {
  if (html.includes(MARKER)) throw new Error("This page already has an AA capture form.");
  if (!/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(runtimeBase)) throw new Error("A secure runtime URL is required.");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("A valid capture token is required.");
  const wording = consentWording.trim();
  if (wording.length < 10 || wording.length > 2000) throw new Error("Consent wording must be 10–2000 characters.");
  const action = `${runtimeBase.replace(/\/+$/, "")}/public/lead/form/${token}`;
  const form = `${MARKER}\n<section aria-labelledby="aa-capture-heading" style="max-width:40rem;margin:2rem auto;padding:1.5rem;border:1px solid currentColor;border-radius:.75rem"><h2 id="aa-capture-heading">Get in touch</h2><form method="post" action="${escapeHtml(action)}"><p><label for="aa-capture-name">Name</label><br><input id="aa-capture-name" name="name" autocomplete="name" maxlength="200"></p><p><label for="aa-capture-email">Email</label><br><input id="aa-capture-email" name="email" type="email" autocomplete="email" maxlength="320" required></p><p><label for="aa-capture-message">Message</label><br><textarea id="aa-capture-message" name="message" maxlength="4000"></textarea></p><p><label><input type="checkbox" name="consent" value="yes" required> ${escapeHtml(wording)}</label></p><button type="submit">Send enquiry</button></form></section>\n`;
  const closing = html.search(/<\/body\s*>/i);
  if (closing < 0) return `${html}\n${form}`;
  return `${html.slice(0, closing)}${form}${html.slice(closing)}`;
}
