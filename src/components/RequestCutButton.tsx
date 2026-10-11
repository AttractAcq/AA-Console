import { useState } from "react";
import { supabase } from "../lib/supabase";
import type { CutState } from "../lib/reelShots";

/**
 * Ask for the reel to be cut.
 *
 * Migration 141 registered video_edit and gave the console one function to
 * call, and then nothing called it. A reel's clips could land and the cut
 * could only be started by someone with SQL access, which is the same as the
 * cut not existing for everybody else.
 *
 * The state line says what is on file. The action appears only when all
 * clips have landed, matching the database readiness guard.
 */
export function RequestCutButton({
  assetId,
  state,
  onRequested,
  onError,
}: {
  assetId: string;
  state: CutState;
  onRequested: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function request() {
    setBusy(true);
    const { error } = await supabase.rpc("request_video_edit", { p_asset_id: assetId });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    onRequested();
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      {state.url && (
        <video
          src={state.url}
          controls
          preload="metadata"
          className="max-h-[200px] w-auto rounded-md border border-border bg-black"
        />
      )}
      <span
        className={
          state.status === "failed"
            ? "text-xs text-destructive"
            : "text-xs text-muted-foreground"
        }
      >
        {state.detail}
      </span>
      {state.canRequest && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void request()}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {state.status === "failed" ? "Cut it again" : "Cut the reel"}
        </button>
      )}
    </span>
  );
}
