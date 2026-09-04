export type MediaFilterId = "image" | "text" | "video";

export type MediaFilter = { id: MediaFilterId; label: string };

export const mediaFilters: MediaFilter[] = [
  { id: "image", label: "Image" },
  { id: "text", label: "Text" },
  { id: "video", label: "Video" },
];
