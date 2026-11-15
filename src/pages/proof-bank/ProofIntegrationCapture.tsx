import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Review = Pick<Database["public"]["Tables"]["google_reviews"]["Row"],
  "id" | "author_name" | "comment" | "review_url" | "reviewed_at" |
  "star_rating" | "gone_at" | "captured_proof_id">;

export function ProofIntegrationCapture({ clientId }: { clientId: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error: queryError } = await supabase.from("google_reviews")
      .select("id,author_name,comment,review_url,reviewed_at,star_rating,gone_at,captured_proof_id")
      .eq("client_id", clientId).order("reviewed_at", { ascending: false }).limit(100);
    setLoading(false);
    if (queryError) { setError(queryError.message); return; }
    setReviews(data ?? []);
    setError(null);
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function capture(reviewId: string) {
    setBusy(reviewId);
    setError(null);
    const { error: captureError } = await supabase.rpc("capture_google_review_as_proof_v6", {
      p_review_id: reviewId,
    });
    setBusy(null);
    if (captureError) { setError(captureError.message); return; }
    setNotice("Review captured as raw proof. Clear its rights before using it.");
    await refresh();
  }

  return <section className="space-y-4">
    <p className="text-sm text-muted-foreground">
      Google Business Profile reviews can enter the Proof Bank with their original URL,
      author, date and text. A captured review starts uncleared. Other provider imports
      require a verified connector.
    </p>
    <Link className="text-sm text-brand-strong underline-offset-2 hover:underline"
      to={`/clients/${clientId}/delivery/google-profile?tab=reviews`}>
      Check Google profile connection and reviews
    </Link>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
    {loading ? <p className="text-sm text-muted-foreground">Loading reviews…</p>
      : reviews.length === 0 ? <p className="text-sm text-muted-foreground">
        No ingested Google reviews are available. Verify the location and review ingest in Google Studio.
      </p> : <div className="space-y-3">{reviews.map((review) => {
        const blocker = review.captured_proof_id ? "Already captured"
          : review.gone_at ? "Removed from Google"
          : !review.comment?.trim() ? "No review text"
          : !review.review_url?.trim() ? "No source URL"
          : !review.reviewed_at ? "No review date" : null;
        return <article key={review.id} className="rounded-lg border border-border bg-card p-4 text-sm">
          <p className="font-medium">{review.author_name || "Unknown reviewer"}
            {review.star_rating ? ` · ${review.star_rating} stars` : ""}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {review.reviewed_at ? new Date(review.reviewed_at).toLocaleDateString() : "Date unknown"}
            {review.review_url && <> · <a className="underline" href={review.review_url}
              target="_blank" rel="noreferrer">Original review</a></>}
          </p>
          <p className="mt-2 whitespace-pre-wrap">{review.comment || "No review text"}</p>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={busy !== null || blocker !== null}
              onClick={() => void capture(review.id)}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">
              {busy === review.id ? "Capturing…" : "Capture as raw proof"}
            </button>
            {blocker && <span className="text-xs text-muted-foreground">{blocker}</span>}
          </div>
        </article>;
      })}</div>}
  </section>;
}
