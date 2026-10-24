import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type Project = Database["public"]["Tables"]["motion_design_projects"]["Row"];
type Scene = Database["public"]["Tables"]["motion_scenes"]["Row"];
type CandidateDue = Database["public"]["Views"]["motion_candidate_due"]["Row"];

type Tab = "scenes" | "renders";

/**
 * Motion Design v2 — Scenes and Renders.
 *
 * v1 works and is untouched: a prompt, a preset, an aspect and a duration go
 * in, and an owned SVG render comes out. What it cannot do is iterate. The
 * scene plan is a blob on the project, so changing one beat means
 * regenerating all of them, and comparing two attempts means remembering
 * what the last one looked like.
 *
 * So scenes are rows that can be locked individually, and every render is
 * kept with its own QA verdicts. The line this page holds is that an AI
 * verdict is not an acceptance: brand QA and claim QA both passing means a
 * candidate is waiting for a person, not that it has shipped.
 */
export function MotionScenesPanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [candidates, setCandidates] = useState<CandidateDue[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [proj, sc, cand] = await Promise.all([
        supabase
          .from("motion_design_projects")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(30),
        supabase
          .from("motion_scenes")
          .select("*")
          .eq("client_id", clientId)
          .order("position", { ascending: true }),
        supabase.from("motion_candidate_due").select("*").eq("client_id", clientId),
      ]);
      for (const result of [proj, sc, cand]) {
        if (result.error) throw new Error(result.error.message);
      }
      setProjects(proj.data ?? []);
      setScenes(sc.data ?? []);
      setCandidates(cand.data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load motion designs.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(key: string, work: () => Promise<void>, said: string) {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await work();
      setNotice(said);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const scenesOf = (projectId: string) => scenes.filter((s) => s.project_id === projectId);

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {tab === "scenes" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Scenes</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              A locked scene is not regenerated, so scene three can be reworked while one, two and
              four stay as they were approved. Seeding reads the plan v1 already writes and never
              overwrites a scene somebody has edited.
            </p>
          </div>

          {projects.length === 0 && !loading ? (
            <EmptyState label="No motion design yet — start one on the v1 page" />
          ) : (
            projects.map((project) => {
              const theirs = scenesOf(project.id);
              return (
                <section key={project.id} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h4 className="font-medium">{project.prompt.slice(0, 80)}</h4>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {project.preset} · {project.aspect} · {project.duration_sec}s ·{" "}
                        {dayOrDash(project.created_at)}
                      </p>
                    </div>
                    {theirs.length === 0 && (
                      <Button
                        disabled={busy === project.id}
                        onClick={() =>
                          void act(
                            project.id,
                            async () => {
                              const { error: rpcError } = await supabase.rpc(
                                "seed_motion_scenes_v6",
                                { p_project_id: project.id },
                              );
                              if (rpcError) throw new Error(rpcError.message);
                            },
                            "Seeded from the plan this project already had.",
                          )
                        }
                      >
                        Seed its scenes
                      </Button>
                    )}
                  </div>

                  {theirs.length === 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {project.scene_plan
                        ? "This project has a plan but no editable scenes yet."
                        : "No plan yet — nothing to seed."}
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {theirs.map((scene) => (
                        <div
                          key={scene.id}
                          className={
                            scene.locked
                              ? "min-w-40 flex-1 rounded-lg border border-border bg-muted/40 p-3"
                              : "min-w-40 flex-1 rounded-lg border border-brand-strong/40 bg-card p-3"
                          }
                        >
                          <p className="text-xs font-medium">
                            {scene.position} · {scene.beat}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {Number(scene.start_sec)}–
                            {Number(scene.start_sec) + Number(scene.duration_sec)}s ·{" "}
                            {scene.locked ? "locked" : "editable"}
                          </p>
                          {scene.proof_asset_id && (
                            <p className="mt-1 text-xs text-brand-strong">cites proof</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
      )}

      {tab === "renders" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Candidates</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Every attempt is kept, because the interesting question after the fourth is which way
              the quality moved. Brand QA and claim QA catch different things, and neither is a
              sign-off: a person accepts the cut that ships.
            </p>
          </div>

          <DataTable
            columns={["Attempt", "Brand QA", "Claim QA", "What is stopping it", "Benchmark", "Actions"]}
            emptyLabel={loading ? "Loading…" : "No render candidates yet"}
            rows={candidates.map((row) => {
              const ready = row.blocker === null;
              const accepted = row.blocker === "Accepted.";
              return [
                <span key="a">
                  r{row.attempt}
                  <span className="block text-xs text-muted-foreground">
                    {(row.prompt ?? "").slice(0, 40)}
                  </span>
                </span>,
                <span
                  key="b"
                  className={
                    row.brand_qa === "fail"
                      ? "text-destructive"
                      : row.brand_qa === "pass"
                        ? "text-brand-strong"
                        : "text-muted-foreground"
                  }
                >
                  {row.brand_qa ?? "not run"}
                </span>,
                <span
                  key="c"
                  className={
                    row.claim_qa === "fail"
                      ? "text-destructive"
                      : row.claim_qa === "pass"
                        ? "text-brand-strong"
                        : "text-muted-foreground"
                  }
                >
                  {row.claim_qa ?? "not run"}
                </span>,
                <span
                  key="s"
                  className={
                    accepted ? "text-brand-strong" : ready ? "text-amber-600" : "text-destructive"
                  }
                >
                  {row.blocker ?? "QA passed — waiting for a person"}
                  {Number(row.scenes_citing_lost_proof ?? 0) > 0 && (
                    <span className="block text-xs">
                      {row.scenes_citing_lost_proof} scene
                      {Number(row.scenes_citing_lost_proof) === 1 ? "" : "s"} cite proof that has
                      gone
                    </span>
                  )}
                </span>,
                <span key="k" className="text-xs text-muted-foreground">
                  {row.benchmark_note ?? "not compared"}
                </span>,
                <span key="x" className="flex gap-2">
                  {ready && row.candidate_id && (
                    <>
                      <Button
                        disabled={busy === row.candidate_id}
                        onClick={() =>
                          void act(
                            row.candidate_id!,
                            async () => {
                              const { error: rpcError } = await supabase.rpc(
                                "accept_motion_candidate_v6",
                                { p_candidate_id: row.candidate_id!, p_accepted: true },
                              );
                              if (rpcError) throw new Error(rpcError.message);
                            },
                            "Accepted.",
                          )
                        }
                      >
                        Accept this cut
                      </Button>
                      <Button
                        disabled={busy === row.candidate_id}
                        onClick={() => {
                          const why = window.prompt("Why is this cut not good enough?");
                          if (why?.trim()) {
                            void act(
                              row.candidate_id!,
                              async () => {
                                const { error: rpcError } = await supabase.rpc(
                                  "accept_motion_candidate_v6",
                                  {
                                    p_candidate_id: row.candidate_id!,
                                    p_accepted: false,
                                    p_reason: why.trim(),
                                  },
                                );
                                if (rpcError) throw new Error(rpcError.message);
                              },
                              "Rejected.",
                            );
                          }
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  )}
                </span>,
              ];
            })}
          />
        </div>
      )}
    </div>
  );
}
