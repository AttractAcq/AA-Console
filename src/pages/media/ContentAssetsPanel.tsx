import { useSearchParams } from "react-router-dom";
import { Tabs } from "../../components/Tabs";
import { ImageLibraryPanel } from "./ImageLibraryPanel";
import { VideoLibraryPanel } from "./VideoLibraryPanel";
import { ReelShotsPanel } from "./ReelShotsPanel";
import { CopyLibraryPanel } from "./CopyLibraryPanel";
import { StoryLibraryPanel } from "./StoryLibraryPanel";
import { CarouselLibraryPanel } from "./CarouselLibraryPanel";

const assetTabs = [
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "reel-shots", label: "Reel Shots" },
  { id: "copy", label: "Copy" },
  { id: "stories", label: "Stories" },
  { id: "carousels", label: "Carousels" },
];

/** V2 groups the existing libraries without changing their handlers or records. */
export function ContentAssetsPanel() {
  const [params, setParams] = useSearchParams();
  const active = assetTabs.find((tab) => tab.id === params.get("asset"))?.id ?? "images";
  function selectAsset(id: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("asset", id);
      return next;
    });
  }
  return <div>
    <div className="mb-6"><Tabs tabs={assetTabs} activeId={active} onChange={selectAsset} /></div>
    <div id={`tabpanel-${active}`} role="tabpanel" aria-labelledby={`tab-${active}`}>
      {active === "images" && <ImageLibraryPanel />}
      {active === "videos" && <VideoLibraryPanel />}
      {active === "reel-shots" && <ReelShotsPanel />}
      {active === "copy" && <CopyLibraryPanel />}
      {active === "stories" && <StoryLibraryPanel />}
      {active === "carousels" && <CarouselLibraryPanel />}
    </div>
  </div>;
}
