import { MediaLibrary } from "../../components/MediaLibrary";

/** Stills and clips both: a story is a shape, not a media type. */
export function StoryLibraryPanel() {
  return <MediaLibrary contentFormat="story" />;
}
