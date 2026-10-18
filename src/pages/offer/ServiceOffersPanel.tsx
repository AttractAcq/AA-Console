import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database, Json } from "../../types/database";

type Offer = Database["public"]["Tables"]["service_offers"]["Row"];
type Version = Database["public"]["Tables"]["service_offer_versions"]["Row"];
type Signoff = Database["public"]["Tables"]["service_offer_signoffs"]["Row"];
type Manifest = Database["public"]["Tables"]["campaign_manifest_versions"]["Row"];
type ManifestOffer = Database["public"]["Tables"]["campaign_manifest_offers"]["Row"];
type Campaign = Database["public"]["Tables"]["client_campaigns"]["Row"];
type Form = {
  offerId: string | null; serviceName: string; audience: string; promise: string;
  inclusions: string; exclusions: string; price: string; currency: string;
  deliveryCost: string; claims: string; retainedClaims: Json[];
};
const emptyForm: Form = { offerId: null, serviceName: "", audience: "", promise: "",
  inclusions: "", exclusions: "", price: "", currency: "EUR", deliveryCost: "",
  claims: "", retainedClaims: [] };
const lines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);
function isClaim(value: Json): value is { kind: string; text: string; proof_asset_id?: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.kind === "string" && typeof value.text === "string";
}

export function ServiceOffersPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [manifestOffers, setManifestOffers] = useState<ManifestOffer[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedManifestId, setSelectedManifestId] = useState("");
  const [selectedOfferVersionId, setSelectedOfferVersionId] = useState("");
  const [form, setForm] = useState<Form>(emptyForm);
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) { setLoading(false); return; }
    setLoading(true);
    const [offerResult, versionResult, signoffResult, manifestResult, linkResult, campaignResult] = await Promise.all([
      supabase.from("service_offers").select("*").eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase.from("service_offer_versions").select("*").eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase.from("service_offer_signoffs").select("*").eq("client_id", clientId),
      supabase.from("campaign_manifest_versions").select("*").eq("client_id", clientId),
      supabase.from("campaign_manifest_offers").select("*").eq("client_id", clientId),
      supabase.from("client_campaigns").select("*").eq("client_id", clientId),
    ]);
    setLoading(false);
    const queryError = offerResult.error ?? versionResult.error ?? signoffResult.error
      ?? manifestResult.error ?? linkResult.error ?? campaignResult.error;
    if (queryError) { setError(queryError.message); return; }
    setError(null);
    setOffers(offerResult.data ?? []);
    setVersions(versionResult.data ?? []);
    setSignoffs(signoffResult.data ?? []);
    setManifests(manifestResult.data ?? []);
    setManifestOffers(linkResult.data ?? []);
    setCampaigns(campaignResult.data ?? []);
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);

  function update(field: Exclude<keyof Form, "offerId" | "retainedClaims">, value: string) {
    setForm((prior) => ({ ...prior, [field]: value }));
    setDraftKey(crypto.randomUUID());
  }

  function revise(offer: Offer, version: Version) {
    setForm({
      offerId: offer.id, serviceName: offer.service_name,
      audience: version.audience, promise: version.promise,
      inclusions: version.inclusions.join("\n"), exclusions: version.exclusions.join("\n"),
      price: version.price_amount?.toString() ?? "", currency: version.currency ?? "EUR",
      deliveryCost: version.delivery_cost_estimate?.toString() ?? "",
      claims: Array.isArray(version.claims) ? version.claims
        .filter(isClaim).filter((claim) => claim.kind === "general")
        .map((claim) => claim.text).join("\n") : "",
      retainedClaims: Array.isArray(version.claims) ? version.claims
        .filter(isClaim).filter((claim) => claim.kind === "quantified") : [],
    });
    setDraftKey(crypto.randomUUID());
    document.getElementById("service-offer-editor")?.scrollIntoView({ behavior: "smooth" });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!clientId || busy) return;
    setBusy("create"); setError(null);
    const price = form.price.trim() ? Number(form.price) : null;
    const deliveryCost = form.deliveryCost.trim() ? Number(form.deliveryCost) : null;
    if ((price !== null && (!Number.isFinite(price) || price < 0))
      || (deliveryCost !== null && (!Number.isFinite(deliveryCost) || deliveryCost < 0))) {
      setError("Enter valid non-negative amounts for price and delivery cost.");
      setBusy(null);
      return;
    }
    const claims: Json = [
      ...form.retainedClaims,
      ...lines(form.claims).map((text) => ({ kind: "general", text })),
    ];
    const { error: rpcError } = await supabase.rpc("create_service_offer_version_v6", {
      p_client_id: clientId,
      p_service_name: form.serviceName.trim(),
      p_audience: form.audience.trim(),
      p_promise: form.promise.trim(),
      p_inclusions: lines(form.inclusions),
      p_exclusions: lines(form.exclusions),
      // An offer with no price has no currency either, and the function takes
      // both positionally with no default. The generated types model every
      // argument as non-nullable, which is why these are cast rather than
      // omitted — leaving them out would not match the signature.
      p_price_amount: price as unknown as number,
      p_currency: (price === null ? null : form.currency.trim().toUpperCase()) as unknown as string,
      p_delivery_cost_estimate: deliveryCost as unknown as number,
      p_claims: claims,
      p_idempotency_key: draftKey,
      // A first version is not a revision of an existing offer, and that is
      // what the default says.
      ...(form.offerId ? { p_offer_id: form.offerId } : {}),
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    setForm(emptyForm);
    setDraftKey(crypto.randomUUID());
    await refresh();
  }

  async function approve(version: Version) {
    setBusy(version.id); setError(null);
    const { error: rpcError } = await supabase.rpc("approve_service_offer_version_v6", {
      p_version_id: version.id,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
  }

  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!selectedManifestId || !selectedOfferVersionId || busy) return;
    setBusy("attach"); setError(null);
    const { error: rpcError } = await supabase.rpc("attach_campaign_offer_v6", {
      p_manifest_id: selectedManifestId, p_offer_version_id: selectedOfferVersionId,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    setSelectedManifestId(""); setSelectedOfferVersionId("");
    await refresh();
  }

  const currentManifests = manifests.filter((manifest) =>
    !manifests.some((other) => other.campaign_id === manifest.campaign_id
      && other.version > manifest.version));
  const approvedVersions = versions.filter((version) =>
    signoffs.some((signoff) => signoff.offer_version_id === version.id));

  return <div className="space-y-6">
    <div>
      <h2 className="text-xl font-semibold">Service offers</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Draft a service-specific offer with its promise, inclusions, limits and economics.
        Each revision is a new version. Quantified claims require current, cleared proof before human sign-off.
      </p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <form id="service-offer-editor" onSubmit={(event) => void create(event)} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold">{form.offerId ? "New offer version" : "New service offer"}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Service name<input required maxLength={200} disabled={Boolean(form.offerId)}
          value={form.serviceName} onChange={(event) => update("serviceName", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
        <label className="text-sm">Audience<input required maxLength={2000} value={form.audience}
          onChange={(event) => update("audience", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
      </div>
      <label className="block text-sm">Offer promise<textarea required rows={3} maxLength={4000} value={form.promise}
        onChange={(event) => update("promise", event.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Included, one per line<textarea rows={3} value={form.inclusions}
          onChange={(event) => update("inclusions", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
        <label className="text-sm">Exclusions or limits, one per line<textarea rows={3} value={form.exclusions}
          onChange={(event) => update("exclusions", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="text-sm">Price, if known<input type="number" min="0" step="0.01" value={form.price}
          onChange={(event) => update("price", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
        <label className="text-sm">Currency<input maxLength={3} value={form.currency}
          onChange={(event) => update("currency", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
        <label className="text-sm">Estimated delivery cost<input type="number" min="0" step="0.01" value={form.deliveryCost}
          onChange={(event) => update("deliveryCost", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
      </div>
      <label className="block text-sm">General claims, one per line<textarea rows={3} value={form.claims}
        onChange={(event) => update("claims", event.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
      {form.retainedClaims.length > 0 && <p className="text-xs text-muted-foreground">
        {form.retainedClaims.length} quantified claim(s) and their proof links will carry into this revision.
      </p>}
      <div className="flex gap-2">
        <button type="submit" disabled={Boolean(busy)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Save draft version</button>
        {form.offerId && <button type="button" onClick={() => { setForm(emptyForm); setDraftKey(crypto.randomUUID()); }}
          className="rounded-lg border border-border px-4 py-2 text-sm">Cancel revision</button>}
      </div>
    </form>
    <section className="space-y-3 rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold">Campaign offer</h3>
      <p className="text-sm text-muted-foreground">
        Link one approved offer version to the current campaign package. A later revision needs a new package link;
        existing packages keep their exact offer version.
      </p>
      {currentManifests.length === 0 ? <p className="text-sm text-muted-foreground">
        No v6 campaign package exists yet. Plan a route-bound campaign in Campaign Factory first.
      </p> : <form onSubmit={(event) => void attach(event)} className="flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1 text-sm">Current campaign package
          <select required value={selectedManifestId} onChange={(event) => setSelectedManifestId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2">
            <option value="">Choose a campaign</option>
            {currentManifests.map((manifest) => {
              const campaign = campaigns.find((item) => item.id === manifest.campaign_id);
              const linked = manifestOffers.find((item) => item.manifest_id === manifest.id);
              return <option key={manifest.id} value={manifest.id} disabled={Boolean(linked)}>
                {campaign?.name ?? manifest.campaign_id} · package v{manifest.version}{linked ? " · linked" : ""}
              </option>;
            })}
          </select>
        </label>
        <label className="min-w-56 flex-1 text-sm">Approved offer version
          <select required value={selectedOfferVersionId} onChange={(event) => setSelectedOfferVersionId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2">
            <option value="">Choose an offer</option>
            {approvedVersions.map((version) => <option key={version.id} value={version.id}>
              {offers.find((offer) => offer.id === version.offer_id)?.service_name ?? "Offer"} · v{version.version}
            </option>)}
          </select>
        </label>
        <button type="submit" disabled={Boolean(busy) || approvedVersions.length === 0}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Link offer
        </button>
      </form>}
      {manifestOffers.length > 0 && <div className="space-y-1 text-sm">
        {manifestOffers.map((link) => {
          const manifest = manifests.find((item) => item.id === link.manifest_id);
          const version = versions.find((item) => item.id === link.offer_version_id);
          const offer = offers.find((item) => item.id === version?.offer_id);
          return <p key={link.manifest_id}>
            <Link className="text-primary underline" to={`/clients/${clientId}/delivery/campaign-factory/${link.campaign_id}`}>
              {campaigns.find((item) => item.id === link.campaign_id)?.name ?? "Campaign"}
            </Link> · package v{manifest?.version ?? "?"} → {offer?.service_name ?? "Offer"} v{version?.version ?? "?"}
          </p>;
        })}
      </div>}
    </section>
    {loading ? <p className="text-sm text-muted-foreground">Loading offers…</p>
      : offers.length === 0 ? <p className="text-sm text-muted-foreground">No service offers have been drafted yet.</p>
        : offers.map((offer) => <section key={offer.id} className="space-y-3">
          <h3 className="text-lg font-semibold">{offer.service_name}</h3>
          {versions.filter((version) => version.offer_id === offer.id).map((version) => {
            const signed = signoffs.some((signoff) => signoff.offer_version_id === version.id);
            const margin = version.price_amount !== null && version.delivery_cost_estimate !== null
              ? version.price_amount - version.delivery_cost_estimate : null;
            return <article key={version.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold">Version {version.version} · {signed ? "Approved" : "Draft"}</h4>
                <span className="text-xs font-mono text-muted-foreground">{version.content_hash.slice(0, 16)}…</span>
              </div>
              <p className="mt-3 text-sm">{version.promise}</p>
              <p className="mt-2 text-sm text-muted-foreground">Audience: {version.audience}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Price: {version.price_amount === null ? "Unknown" : `${version.price_amount} ${version.currency}`}
                {margin !== null ? ` · Estimated gross contribution: ${margin} ${version.currency}` : ""}
              </p>
              <details className="mt-3 text-sm"><summary className="cursor-pointer">Inclusions, limits and claims</summary>
                <div className="mt-2 space-y-2 whitespace-pre-wrap">
                  <p>Included: {version.inclusions.join("; ") || "None specified"}</p>
                  <p>Limits: {version.exclusions.join("; ") || "None specified"}</p>
                  <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(version.claims, null, 2)}</pre>
                </div>
              </details>
              <div className="mt-4 flex gap-2">
                {!signed && <button type="button" disabled={Boolean(busy)} onClick={() => void approve(version)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Approve version</button>}
                <button type="button" onClick={() => revise(offer, version)}
                  className="rounded-lg border border-border px-4 py-2 text-sm">Create revision</button>
              </div>
            </article>;
          })}
        </section>)}
  </div>;
}
