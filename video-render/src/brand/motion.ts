export const EASINGS = {
  enter: [0.16, 1, 0.3, 1],
  exit: [0.7, 0, 0.84, 0],
  move: [0.65, 0, 0.35, 1],
} as const;

export const DURATIONS = { micro: 8, short: 18, medium: 30, long: 48 } as const;
export const TRANSITIONS = ["cut", "fade", "slideLeft", "slideUp", "wipeBrand"] as const;
export const CAPTION_STYLE = {
  position: "bottom" as const, maxLines: 2, maxCharsPerLine: 32,
  highlight: "primary" as const,
};
export const SAFE_AREAS = {
  "16:9": { x: 96, y: 54 },
  "9:16": { x: 54, y: 220 },
  "1:1": { x: 72, y: 72 },
} as const;
