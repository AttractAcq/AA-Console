import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { MediaLibrary } from "../../components/MediaLibrary";
import { supabase } from "../../lib/supabase";

/**
 * Finished single videos.
 *
 * MediaLibrary asks for content_format 'single', the same way the carousel
 * and story libraries ask for theirs, so a reel never appears here — it is
 * content_format 'reel'. That filter is deliberate and this panel does not
 * change it.
 *
 * What it does change is the silence. A reel in production rendered six
 * stills, cost real money and sat in the one place nobody thinks to look,
 * while the library a person actually opens for a video showed nothing and
 * gave no reason. This says where it went.
 *
 * Deliberately does not promise that an assembled reel will show up here
 * later. It will not: assembly does not exist yet, and when it does the
 * finished file is still content_format 'reel' and still filtered out by
 * the same line. So there is currently no library that will ever list a
 * finished reel. That is a real gap and it needs deciding — either this
 * panel stops asking for 'single', or Reel shots becomes the reel library.
 * A reassuring sentence here would bury the question instead of posing it.
 */
export function VideoLibraryPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [, setSearchParams] = useSearchParams();
  const [reels, setReels] = useState(0);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    void (async () => {
      const { count } = await supabase
        .from("client_media_assets")
        .select("id", { count: "exact" as const, head: true })
        .eq("client_id", clientId)
        .eq("media_type", "video")
        .eq("content_format", "reel");
      if (!cancelled) setReels(count ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  return (
    <div>
      {reels > 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          {reels === 1 ? "One reel is" : `${reels} reels are`} in production for this client and not
          listed here — this library holds single videos. {reels === 1 ? "It is" : "They are"}{" "}
          reviewed shot by shot under{" "}
          <button
            type="button"
            className="font-medium text-brand-strong hover:underline"
            onClick={() => setSearchParams({ tab: "reel-shots" })}
          >
            Reel shots
          </button>
          .
        </p>
      )}
      <MediaLibrary mediaType="video" />
    </div>
  );
}
