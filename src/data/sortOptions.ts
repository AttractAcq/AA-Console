export type SortOptionId = "newest" | "oldest";

export type SortOption = { id: SortOptionId; label: string };

export const dateSortOptions: SortOption[] = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
];
