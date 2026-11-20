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
type Proof = Pick<Database["public"]["Tables"]["client_proof_assets"]["Row"],
  "id" | "title" | "claim" | "evidence" | "usage_rights" | "expires_on">;
type GeneralClaim = { text: string; proofAssetId: string };
type Form = {
  offerId: string | null; serviceName: string; audience: string; promise: string;
  inclusions: string; exclusions: string; price: string; currency: string;
  deliveryCost: string; generalClaims: GeneralClaim[]; retainedClaims: Json[];
  dreamOutcome: string; dreamOutcomeBoost: string; likelihood: string;
  likelihoodMechanism: string; timeDelay: string; delayReductionSteps: string;
  effortSacrifice: string; effortReductionSteps: string; riskReversal: string;
  bonuses: string; scarcity: string; urgency: string; deliveryLimits: string;
};
const emptyForm: Form = { offerId: null, serviceName: "", audience: "", promise: "",
  inclusions: "", exclusions: "", price: "", currency: "EUR", deliveryCost: "",
  generalClaims: [], retainedClaims: [], dreamOutcome: "", dreamOutcomeBoost: "",
  likelihood: "", likelihoodMechanism: "", timeDelay: "", delayReductionSteps: "",
  effortSacrifice: "", effortReductionSteps: "", riskReversal: "", bonuses: "",
  scarcity: "", urgency: "", deliveryLimits: "" };
const lines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);
function valueObject(value: Json | null): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json> : {};
}
function valueText(value: Record<string, Json>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}
function valueLines(value: Record<string, Json>, key: string): string {
  return Array.isArray(value[key]) ? value[key].filter((item): item is string => typeof item === "string").join("\n") : "";
}
function bonusLines(value: Record<string, Json>): string {
  return Array.isArray(value.bonuses) ? value.bonuses.map((item) => {
    const bonus = valueObject(item);
    return [valueText(bonus, "name"), valueText(bonus, "value"), valueText(bonus, "delivery_limit")]
      .filter(Boolean).join(" | ");
  }).join("\n") : "";
}
function isClaim(value: Json): value is { kind: string; text: string; proof_asset_id?: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.kind === "string" && typeof value.text === "string";
}

export function ServiceOffersPanel({ selectedOfferId }: { selectedOfferId: string }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [manifestOffers, setManifestOffers] = useState<ManifestOffer[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [proofs, setProofs] = useState<Proof[]>([]);
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
    const queryError = offerResult.error ?? versionResult.error ?? signoffResult.error
      ?? manifestResult.error ?? linkResult.error ?? campaignResult.error;
    if (queryError) { setLoading(false); setError(queryError.message); return; }
    const proofResult = await supabase.from("client_proof_assets")
      .select("id,title,claim,evidence,usage_rights,expires_on")
      .eq("client_id", clientId);
    setLoading(false);
    if (proofResult.error) { setError(`Offer proof is unavailable: ${proofResult.error.message}`); return; }
    setError(null);
    setOffers(offerResult.data ?? []);
    setVersions(versionResult.data ?? []);
    setSignoffs(signoffResult.data ?? []);
    setManifests(manifestResult.data ?? []);
    setManifestOffers(linkResult.data ?? []);
    setCampaigns(campaignResult.data ?? []);
    setProofs(proofResult.data ?? []);
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const selected = offers.find((offer) => offer.id === selectedOfferId);
    if (!selected) return;
    setForm((current) => current.offerId === selected.id ? current : {
      ...emptyForm, offerId: selected.id, serviceName: selected.service_name,
    });
  }, [offers, selectedOfferId]);

  function update(field: Exclude<keyof Form, "offerId" | "retainedClaims" | "generalClaims">, value: string) {
    setForm((prior) => ({ ...prior, [field]: value }));
    setDraftKey(crypto.randomUUID());
  }
  function updateClaim(index: number, field: keyof GeneralClaim, value: string) {
    setForm((prior) => ({ ...prior, generalClaims: prior.generalClaims.map((claim, item) =>
      item === index ? { ...claim, [field]: value } : claim) }));
    setDraftKey(crypto.randomUUID());
  }

  function revise(offer: Offer, version: Version) {
    const equation = valueObject(version.value_equation);
    setForm({
      offerId: offer.id, serviceName: offer.service_name,
      audience: version.audience, promise: version.promise,
      inclusions: version.inclusions.join("\n"), exclusions: version.exclusions.join("\n"),
      price: version.price_amount?.toString() ?? "", currency: version.currency ?? "EUR",
      deliveryCost: version.delivery_cost_estimate?.toString() ?? "",
      generalClaims: Array.isArray(version.claims) ? version.claims
        .filter(isClaim).filter((claim) => claim.kind === "general")
        .map((claim) => ({ text: claim.text, proofAssetId: claim.proof_asset_id ?? "" })) : [],
      retainedClaims: Array.isArray(version.claims) ? version.claims
        .filter(isClaim).filter((claim) => claim.kind === "quantified") : [],
      dreamOutcome: valueText(equation, "dream_outcome"),
      dreamOutcomeBoost: valueText(equation, "dream_outcome_boost"),
      likelihood: valueText(equation, "likelihood"),
      likelihoodMechanism: valueText(equation, "likelihood_mechanism"),
      timeDelay: valueText(equation, "time_delay"),
      delayReductionSteps: valueLines(equation, "delay_reduction_steps"),
      effortSacrifice: valueText(equation, "effort_sacrifice"),
      effortReductionSteps: valueLines(equation, "effort_reduction_steps"),
      riskReversal: valueText(equation, "risk_reversal"),
      bonuses: bonusLines(equation),
      scarcity: valueText(equation, "scarcity"),
      urgency: valueText(equation, "urgency"),
      deliveryLimits: valueText(equation, "delivery_limits"),
    });
    setDraftKey(crypto.randomUUID());
    document.getElementById("service-offer-editor")?.scrollIntoView({ behavior: "smooth" });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!clientId || busy) return;
    if (form.offerId !== selectedOfferId) {
      setError("Choose a source-bound offer in Build before saving a version.");
      return;
    }
    setBusy("create"); setError(null);
    const price = form.price.trim() ? Number(form.price) : null;
    const deliveryCost = form.deliveryCost.trim() ? Number(form.deliveryCost) : null;
    if ((price !== null && (!Number.isFinite(price) || price < 0))
      || (deliveryCost !== null && (!Number.isFinite(deliveryCost) || deliveryCost < 0))) {
      setError("Enter valid non-negative amounts for price and delivery cost.");
      setBusy(null);
      return;
    }
    const generalClaims = form.generalClaims.filter((claim) => claim.text.trim());
    const unsupported = generalClaims.find((claim) => {
      const proof = proofs.find((item) => item.id === claim.proofAssetId);
      return !proof || proof.usage_rights !== "approved"
        || (proof.expires_on !== null && proof.expires_on < new Date().toISOString().slice(0, 10))
        || !proof.evidence?.trim()
        || (proof.claim ?? "").trim().replace(/\s+/g, " ").toLowerCase()
          !== claim.text.trim().replace(/\s+/g, " ").toLowerCase();
    });
    if (unsupported) {
      setError("Each general claim needs a current cleared proof record with matching claim text and evidence.");
      setBusy(null);
      return;
    }
    const claims: Json = [
      ...form.retainedClaims,
      ...generalClaims.map((claim) => ({ kind: "general", text: claim.text.trim(), proof_asset_id: claim.proofAssetId })),
    ];
    const bonuses = lines(form.bonuses).map((row) => row.split("|").map((part) => part.trim()));
    if (bonuses.length > 5 || bonuses.some((parts) => parts.length < 2 || parts.length > 3
      || !parts[0] || !parts[1])) {
      setError("Enter at most five bonuses, each as Name | Value | optional delivery limit.");
      setBusy(null);
      return;
    }
    const valueEquation: Json = {
      dream_outcome: form.dreamOutcome.trim(),
      dream_outcome_boost: form.dreamOutcomeBoost.trim(),
      likelihood: form.likelihood.trim(),
      likelihood_mechanism: form.likelihoodMechanism.trim(),
      time_delay: form.timeDelay.trim(),
      delay_reduction_steps: lines(form.delayReductionSteps),
      effort_sacrifice: form.effortSacrifice.trim(),
      effort_reduction_steps: lines(form.effortReductionSteps),
      risk_reversal: form.riskReversal.trim(),
      bonuses: bonuses.map(([name, value, deliveryLimit]) => ({
        name, value, delivery_limit: deliveryLimit ?? "",
      })),
      scarcity: form.scarcity.trim(),
      urgency: form.urgency.trim(),
      delivery_limits: form.deliveryLimits.trim(),
    };
    const { error: rpcError } = await supabase.rpc("create_service_offer_version_v9", {
      p_offer_id: selectedOfferId,
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
      p_value_equation: valueEquation,
      p_idempotency_key: draftKey,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    setForm({ ...emptyForm, offerId: selectedOfferId, serviceName: form.serviceName });
    setDraftKey(crypto.randomUUID());
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
    version.offer_id === selectedOfferId
      && signoffs.some((signoff) => signoff.offer_version_id === version.id));
  const selectedOffer = offers.find((offer) => offer.id === selectedOfferId);
  const selectedVersions = versions.filter((version) => version.offer_id === selectedOfferId);
  const selectedVersionIds = new Set(selectedVersions.map((version) => version.id));
  const selectedLinks = manifestOffers.filter((link) => selectedVersionIds.has(link.offer_version_id));

  return <div className="space-y-6">
    <div>
      <h2 className="text-xl font-semibold">{selectedOffer?.service_name ?? "Selected offer"} versions</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Draft a service-specific offer with its promise, inclusions, limits and economics.
        Each revision is a new version. Every explicit claim in a new structured offer must match cleared proof text and recorded evidence before sign-off or new campaign use.
      </p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <form id="service-offer-editor" onSubmit={(event) => void create(event)} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold">New offer version</h3>
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
      <fieldset className="space-y-4 rounded-lg border border-border p-4">
        <legend className="px-1 font-medium">Value equation</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">Dream outcome<textarea required rows={3} maxLength={2000} value={form.dreamOutcome}
            onChange={(event) => update("dreamOutcome", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">How this offer strengthens the outcome<textarea required rows={3} maxLength={2000} value={form.dreamOutcomeBoost}
            onChange={(event) => update("dreamOutcomeBoost", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Perceived likelihood of achievement<textarea required rows={3} maxLength={2000} value={form.likelihood}
            onChange={(event) => update("likelihood", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Proof or mechanism that raises likelihood<textarea required rows={3} maxLength={2000} value={form.likelihoodMechanism}
            onChange={(event) => update("likelihoodMechanism", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Time delay<textarea required rows={3} maxLength={2000} value={form.timeDelay}
            onChange={(event) => update("timeDelay", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Steps that reduce delay, one per line<textarea required rows={3} value={form.delayReductionSteps}
            onChange={(event) => update("delayReductionSteps", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Effort and sacrifice<textarea required rows={3} maxLength={2000} value={form.effortSacrifice}
            onChange={(event) => update("effortSacrifice", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Steps that reduce effort, one per line<textarea required rows={3} value={form.effortReductionSteps}
            onChange={(event) => update("effortReductionSteps", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Risk reversal or guarantee<textarea rows={3} maxLength={2000} value={form.riskReversal}
            onChange={(event) => update("riskReversal", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Bonuses, up to five<textarea rows={3} value={form.bonuses}
            onChange={(event) => update("bonuses", event.target.value)}
            aria-describedby="offer-bonus-format"
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" />
            <span id="offer-bonus-format" className="text-xs text-muted-foreground">One per line: Name | Value | optional delivery limit</span>
          </label>
          <label className="text-sm">Scarcity<textarea rows={2} maxLength={2000} value={form.scarcity}
            onChange={(event) => update("scarcity", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm">Urgency<textarea rows={2} maxLength={2000} value={form.urgency}
            onChange={(event) => update("urgency", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
          <label className="text-sm sm:col-span-2">Delivery limits<textarea rows={2} maxLength={2000} value={form.deliveryLimits}
            onChange={(event) => update("deliveryLimits", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2" /></label>
        </div>
      </fieldset>
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
      <fieldset className="space-y-3 rounded-lg border border-border p-3">
        <legend className="text-sm font-medium">General claims and supporting proof</legend>
        <p className="text-xs text-muted-foreground">Each claim must match the cleared proof claim and have recorded evidence. Review the source before saving.</p>
        {form.generalClaims.map((claim, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-sm">Claim
            <input value={claim.text} onChange={(event) => updateClaim(index, "text", event.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background p-2" />
          </label>
          <label className="text-sm">Cleared proof
            <select value={claim.proofAssetId} onChange={(event) => updateClaim(index, "proofAssetId", event.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background p-2">
              <option value="">Select proof</option>
              {proofs.filter((proof) => proof.usage_rights === "approved" && Boolean(proof.evidence?.trim())
                && (proof.expires_on === null || proof.expires_on >= new Date().toISOString().slice(0, 10)))
                .map((proof) => <option key={proof.id} value={proof.id}>{proof.title}: {proof.claim}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => { setForm((prior) => ({ ...prior,
            generalClaims: prior.generalClaims.filter((_, item) => item !== index) })); setDraftKey(crypto.randomUUID()); }}
            className="self-end rounded-lg border border-border px-3 py-2 text-sm">Remove</button>
        </div>)}
        <button type="button" onClick={() => { setForm((prior) => ({ ...prior,
          generalClaims: [...prior.generalClaims, { text: "", proofAssetId: "" }] })); setDraftKey(crypto.randomUUID()); }}
          className="rounded-lg border border-border px-3 py-2 text-sm">Add claim</button>
      </fieldset>
      {form.retainedClaims.length > 0 && <p className="text-xs text-muted-foreground">
        {form.retainedClaims.length} quantified claim(s) and their proof links will carry into this revision.
      </p>}
      <div className="flex gap-2">
        <button type="submit" disabled={Boolean(busy)} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Save draft version</button>
        {form.offerId && <button type="button" onClick={() => { setForm({ ...emptyForm, offerId: selectedOfferId,
          serviceName: offers.find((offer) => offer.id === selectedOfferId)?.service_name ?? "" }); setDraftKey(crypto.randomUUID()); }}
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
      {selectedLinks.length > 0 && <div className="space-y-1 text-sm">
        {selectedLinks.map((link) => {
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
    {loading ? <p className="text-sm text-muted-foreground">Loading offer versions…</p>
      : !selectedOffer ? <p className="text-sm text-muted-foreground">This offer is unavailable. Choose an offer from Offers.</p>
        : <section key={selectedOffer.id} className="space-y-3">
          <h3 className="text-lg font-semibold">{selectedOffer.service_name}</h3>
          {selectedVersions.map((version) => {
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
                  {Array.isArray(version.claims) && version.claims.filter(isClaim)
                    .filter((claim) => claim.kind === "general" || claim.kind === "quantified").map((claim, index) => {
                      const proof = proofs.find((item) => item.id === claim.proof_asset_id);
                      return <div key={`${claim.proof_asset_id ?? "missing"}-${index}`} className="rounded border border-border p-3">
                        <p className="font-medium">Claim: {claim.text}</p>
                        {proof ? <>
                          <p>Proof: {proof.title || proof.id}</p>
                          <p>Recorded proof claim: {proof.claim || "Missing"}</p>
                          <p>Evidence: {proof.evidence || "Missing"}</p>
                          <p>Rights: {proof.usage_rights} · Expires: {proof.expires_on || "No recorded expiry"}</p>
                        </> : <p role="alert">{claim.proof_asset_id
                          ? "The linked proof record is unavailable for this client."
                          : "No proof link was recorded for this claim."}</p>}
                      </div>;
                    })}
                </div>
              </details>
              <details className="mt-3 text-sm"><summary className="cursor-pointer">Value equation</summary>
                {version.value_equation === null
                  ? <p className="mt-2 text-muted-foreground">Legacy version; no structured value equation recorded.</p>
                  : <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{JSON.stringify(version.value_equation, null, 2)}</pre>}
              </details>
              <div className="mt-4 flex gap-2">
                {!signed && <Link to={`/clients/${clientId}/delivery/approval-inbox?tab=unified`}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Review in Approval Inbox</Link>}
                <button type="button" onClick={() => revise(selectedOffer, version)}
                  className="rounded-lg border border-border px-4 py-2 text-sm">Create revision</button>
              </div>
            </article>;
          })}
        </section>}
  </div>;
}
