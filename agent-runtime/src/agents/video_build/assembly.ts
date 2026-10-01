/**
 * Assembly v1 is an editor handoff, not a compositor.
 *
 * Higgsfield returns clips. brief_dispatch already emails a brief to an
 * editor. This scaffold does not call it: motion has not produced clips,
 * and handing an editor an empty reel would look like a finished job.
 */

export interface AssemblyHandoff {
  via: "brief_dispatch";
  status: "not_started";
  note: string;
}

export function assemblyHandoff(): AssemblyHandoff {
  return {
    via: "brief_dispatch",
    status: "not_started",
    note: "Editor assembly v1. Clips are not composited here. Not started while motion is paused.",
  };
}
