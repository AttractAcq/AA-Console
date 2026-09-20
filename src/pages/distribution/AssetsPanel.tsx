import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CalendarPlus } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { MediaCard } from "../../components/MediaCard";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { Modal } from "../../components/Modal";
import { fetchClientAssets, fetchTextBodies, shortDate, signPaths } from "../../lib/media";
import type { MediaAsset } from "../../lib/media";
import { POST_PLATFORMS, platformLabel } from "../../lib/postPlatform";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

interface Booking {
  scheduled_for: string;
  channel: string;
  platform: string | null;
  published_at: string | null;
}

/**
 * Approved assets, and the one action left to take on them.
 *
 * Approval already removes an asset from the Approvals queue, which meant it
 * left the queue and arrived nowhere — 7 of 10 approved client assets had
 * never been scheduled. This is the place it arrives.
 *
 * Scheduled assets stay on the list rather than disappearing again, marked
 * with where and when they go. An asset that vanishes twice is an asset
 * nobody can confirm they dealt with.
 */
export function AssetsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [bookings, setBookings] = useState<Map<string, Booking>>(new Map());
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaAsset | null>(null);
  const [scheduling, setScheduling] = useState<MediaAsset | null>(null);
  const [date, setDate] = useState("");
  const [channel, setChannel] = useState<"organic" | "paid">("organic");
  const [platform, setPlatform] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const rows = await fetchClientAssets(clientId, { reviewStatus: "approved" });
      setAssets(rows);

      const { data: posts, error: postError } = await supabase
        .from("scheduled_posts")
        .select("asset_id, scheduled_for, channel, platform, published_at")
        .eq("client_id", clientId);
      if (postError) throw new Error(postError.message);

      const booked = new Map<string, Booking>();
      for (const p of posts ?? []) {
        const id = (p as { asset_id: string | null }).asset_id;
        if (id) booked.set(id, p as unknown as Booking);
      }
      setBookings(booked);

      const signed = await signPaths("client-media", rows.map((r) => r.storage_path));
      setUrls(signed);
      setBodies(await fetchTextBodies(rows.filter((r) => r.media_type === "text"), signed));
    } catch (err) {
      setLoadError(
        "Failed to load approved assets: " + (err instanceof Error ? err.message : "Unknown error"),
      );
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function schedule() {
    if (!scheduling) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("schedule_asset", {
      p_asset_id: scheduling.id,
      p_date: date,
      p_channel: channel,
      ...(platform
        ? { p_platform: platform as Database["public"]["Enums"]["post_platform"] }
        : {}),
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setScheduling(null);
    setDate("");
    setPlatform("");
    void refresh();
  }

  // Unscheduled first: those are the ones with work left on them.
  const ordered = [...assets].sort((a, b) => {
    const aBooked = bookings.has(a.id) ? 1 : 0;
    const bBooked = bookings.has(b.id) ? 1 : 0;
    if (aBooked !== bBooked) return aBooked - bBooked;
    return b.created_at.localeCompare(a.created_at);
  });
  const waiting = ordered.filter((a) => !bookings.has(a.id)).length;

  if (loadError) {
    return (
      <div role="alert">
        <p className="text-sm text-destructive">{loadError}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        Everything approved and ready to go out.{" "}
        {waiting > 0
          ? `${waiting} still ${waiting === 1 ? "has" : "have"} no date.`
          : "All of it is scheduled."}
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading approved assets…</p>
      ) : ordered.length === 0 ? (
        <EmptyState label="Nothing approved yet — assets appear here once they clear Approvals" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ordered.map((asset) => {
            const booking = bookings.get(asset.id);
            return (
              <MediaCard
                key={asset.id}
                mediaType={asset.media_type}
                url={urls.get(asset.storage_path)}
                body={bodies.get(asset.id)}
                title={asset.title ?? "Untitled"}
                meta={`${asset.ref_number ?? "—"} · ${shortDate(asset.created_at)}`}
                onOpen={() => setPreview(asset)}
                badge={
                  booking ? (
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                      {booking.published_at ? "Published" : "Scheduled"}
                    </span>
                  ) : undefined
                }
                actions={
                  booking ? (
                    <p className="text-xs text-muted-foreground">
                      {booking.channel} · {platformLabel(booking.platform)} ·{" "}
                      {shortDate(booking.scheduled_for)}
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setScheduling(asset);
                        setChannel("organic");
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
                      Schedule
                    </button>
                  )
                }
              />
            );
          })}
        </div>
      )}

      <Modal
        open={scheduling !== null}
        onClose={() => setScheduling(null)}
        title={`Schedule "${scheduling?.title ?? ""}"`}
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-card-foreground">Date</span>
            <input
              type="date"
              aria-label="Date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-card-foreground">Channel</span>
            <select
              aria-label="Channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value as "organic" | "paid")}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="organic">Organic</option>
              <option value="paid">Paid</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-card-foreground">Platform (optional)</span>
            <select
              aria-label="Platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">Not decided yet</option>
              {POST_PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setScheduling(null)}
              className="rounded-md px-3.5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!date || busy}
              onClick={() => void schedule()}
              className="rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Schedule
            </button>
          </div>
        </div>
      </Modal>

      <MediaDetailModal
        asset={preview}
        url={preview ? urls.get(preview.storage_path) : undefined}
        body={preview ? bodies.get(preview.id) : undefined}
        open={preview !== null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
