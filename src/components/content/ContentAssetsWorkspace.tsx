import { useSearchParams } from "react-router-dom";

import { ContentAssetTable } from "./ContentAssetTable";
import { ImageLibraryPanel } from "../../pages/media/ImageLibraryPanel";
import { VideoLibraryPanel } from "../../pages/media/VideoLibraryPanel";
import { ReelShotsPanel } from "../../pages/media/ReelShotsPanel";
import { CopyLibraryPanel } from "../../pages/media/CopyLibraryPanel";
import { StoryLibraryPanel } from "../../pages/media/StoryLibraryPanel";
import { CarouselLibraryPanel } from "../../pages/media/CarouselLibraryPanel";

/**
 * Assets, and the six libraries nested under it.
 *
 * The 16 October specification said Assets nests Images, Videos, Reel Shots,
 * Copy, Stories and Carousels; a later pass made Assets the flat
 * approved-assets table instead and left the six where they were, on v1. With
 * v1 archived they had nowhere to go, and four of them are not substitutable:
 * `ContentAssetTable` cuts the list by image/text/video and by whether a
 * person has signed it off, which is not a story view, a carousel view, the
 * reel edit stages, or the frame-and-shot view at all.
 *
 * So this restores the nesting rather than inventing a replacement. Each
 * library is the panel v1 rendered, unchanged.
 *
 * The chosen library is in `?library=`, keeping the ids v1 used for its tabs.
 * That is deliberate: an old `?tab=reel-shots` link needs no translation, it
 * is already the name of the library to open.
 */
export const ASSET_LIBRARIES = [
  { id: "approved", label: "Approved" },
  { id: "image-library", label: "Images" },
  { id: "video-library", label: "Videos" },
  { id: "reel-shots", label: "Reel Shots" },
  { id: "copy-library", label: "Copy" },
  { id: "story-library", label: "Stories" },
  { id: "carousel-library", label: "Carousels" },
] as const;

/** The library ids that were v1 tabs, so a link to one still resolves. */
export const LEGACY_LIBRARY_TABS: ReadonlySet<string> = new Set<string>(
  ASSET_LIBRARIES.filter((item) => item.id !== "approved").map((item) => item.id),
);

const button =
  "rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50";
const primary =
  "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground";

function panel(library: string) {
  switch (library) {
    case "image-library": return <ImageLibraryPanel />;
    case "video-library": return <VideoLibraryPanel />;
    case "reel-shots": return <ReelShotsPanel />;
    case "copy-library": return <CopyLibraryPanel />;
    case "story-library": return <StoryLibraryPanel />;
    case "carousel-library": return <CarouselLibraryPanel />;
    default: return <ContentAssetTable approved />;
  }
}

export function ContentAssetsWorkspace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("library") ?? searchParams.get("tab") ?? "";
  const library = LEGACY_LIBRARY_TABS.has(requested) ? requested : "approved";

  function open(id: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("tab", "assets");
      if (id === "approved") next.delete("library");
      else next.set("library", id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Asset library">
        {ASSET_LIBRARIES.map((item) => (
          <button
            key={item.id}
            className={library === item.id ? primary : button}
            aria-pressed={library === item.id}
            onClick={() => open(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {panel(library)}
    </div>
  );
}
