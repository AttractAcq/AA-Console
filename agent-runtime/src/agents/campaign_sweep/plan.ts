/**
 * What a campaign sweep composes, worked out separately from writing it.
 *
 * The step graph is the interesting part and it is pure, so it is testable
 * without a database: given a plan, what chain of steps does it imply?
 */

/** The platforms a post can go to, as the post_platform enum has them. */
const PLATFORMS = ["facebook", "instagram", "tiktok", "linkedin", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type Route = "organic" | "paid";
export type SweepPiece = {
  route: Route;
  platform: Platform;
  media_type: "image" | "text" | "video";
  content_format: "single" | "carousel" | "story" | "reel";
};

export type SweepStep = {
  stepKey: string;
  agentKey: "ideation" | "brief" | "creative_build";
  dependencies: string[];
  /** Exactly one of these, which add_workflow_agent_step enforces. */
  inputTable: string;
  inputFromStepKey: string | null;
  inputId: string | null;
  usesClientAsInput: boolean;
  inputParams: Record<string, unknown>;
};

/**
 * Which platform a route's pieces go to.
 *
 * The planner decides `channels`; this picks the first that is actually a post
 * platform. It does NOT invent one: a campaign whose channels name no post
 * platform has nothing for an organic piece to be published to, and saying so
 * beats composing a chain that fails at the end.
 */
export function platformFor(channels: readonly string[] | null): Platform | null {
  for (const channel of channels ?? []) {
    const c = channel.trim().toLowerCase();
    if ((PLATFORMS as readonly string[]).includes(c)) return c as Platform;
    // The planner writes "meta" for Meta campaigns, which is Facebook and
    // Instagram rather than a platform a post goes to. Instagram is the one
    // the daily package uses for Meta work.
    if (c === "meta") return "instagram";
  }
  return null;
}

/**
 * The chain for one campaign's planned content.
 *
 * Mirrors the daily content package's shape exactly, because that chain is
 * already driven by the reconciler and already has agents that understand it:
 *
 *   <piece>_idea    ideation        input: the client, params carry the campaign
 *   <piece>_brief   brief           input: the idea the previous step produced
 *   <piece>_create  creative_build  input: the brief the previous step produced
 *
 * Ideas depend on the previous piece's idea rather than running in parallel,
 * which is also what the daily package does -- `static_a_idea` depends on
 * `story_idea`. That is deliberate there and worth keeping: each idea is
 * written knowing what the earlier ones already said, so a campaign gets
 * genuinely distinct pieces instead of several models' first instinct.
 *
 * When the planner already saved exact ideas, the chain starts at each idea:
 * brief then creative. Deferred ideation keeps the three-step chain.
 */
export function sweepSteps(args: {
  organicCount: number;
  paidCount: number;
  platform: Platform;
  campaignId: string;
  pieces?: readonly SweepPiece[];
  plannedIdeaIds?: readonly string[];
}): SweepStep[] {
  const routes: Route[] = [
    ...Array.from({ length: args.organicCount }, () => "organic" as Route),
    ...Array.from({ length: args.paidCount }, () => "paid" as Route),
  ];

  const steps: SweepStep[] = [];
  let previousIdeaKey: string | null = null;

  const pieces = args.pieces ?? routes.map((route) => ({
    route, platform: args.platform, media_type: "image" as const, content_format: "single" as const,
  }));
  if (pieces.length !== routes.length) throw new Error("Sweep content requirements disagree with planned volume.");
  if (args.plannedIdeaIds && args.plannedIdeaIds.length !== pieces.length)
    throw new Error("Sweep planned ideas disagree with planned volume.");
  pieces.forEach((piece, index) => {
    const n = index + 1;
    const ideaKey = `piece${n}_idea`;
    const briefKey = `piece${n}_brief`;
    const createKey = `piece${n}_create`;

    const plannedId = args.plannedIdeaIds?.[index];
    if (!plannedId) steps.push({
      stepKey: ideaKey,
      agentKey: "ideation",
      // Sequential, so each idea sees the ones before it.
      dependencies: previousIdeaKey ? [previousIdeaKey] : [],
      inputTable: "clients",
      inputFromStepKey: null,
      inputId: null,
      usesClientAsInput: true,
      inputParams: {
        idea_count: 1,
        campaign_id: args.campaignId,
        target_platform: piece.platform,
        media_type: piece.media_type,
        content_format: piece.content_format,
        // Which half of a both-route campaign this piece serves. Migration 302
        // put acquisition_route on client_ideas for exactly this.
        acquisition_route: piece.route,
      },
    });

    steps.push({
      stepKey: briefKey,
      agentKey: "brief",
      dependencies: plannedId ? [] : [ideaKey],
      inputTable: "client_ideas",
      inputFromStepKey: plannedId ? null : ideaKey,
      inputId: plannedId ?? null,
      usesClientAsInput: false,
      inputParams: {},
    });

    steps.push({
      stepKey: createKey,
      agentKey: "creative_build",
      dependencies: [briefKey],
      inputTable: "client_briefs",
      inputFromStepKey: briefKey,
      inputId: null,
      usesClientAsInput: false,
      inputParams: {},
    });

    if (!plannedId) previousIdeaKey = ideaKey;
  });

  return steps;
}
