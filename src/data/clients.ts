export type Client = {
  id: string;
  name: string;
  initials: string;
  sector: string;
  location: string;
  tier: string;
  isInternal?: boolean;
};

export const clients: Client[] = [
  {
    id: "attract-acquisition",
    name: "Attract Acquisition",
    initials: "AA",
    sector: "Distribution partner",
    location: "Cape Town",
    tier: "In-house",
    isInternal: true,
  },
];
