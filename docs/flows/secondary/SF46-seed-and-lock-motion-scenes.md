# SF46 — Seed motion scenes, lock one, accept a candidate

**Where.** Clients → [client] → Delivery → Motion Design (v2) → Scenes / Renders
**Owner.** Creative lead. **Reviewed.** 25 October 2026. **Part of** MF07.

## Why v2 exists
v1 works — a prompt, a preset, an aspect and a duration — but it cannot iterate: the scene
plan was a blob on the project, so changing one beat meant a new project and a new render of
everything. v2 makes scenes editable rows.

## Seed the scenes
**Scenes** → if it reads *"This project has a plan but no editable scenes yet"*, use
**Seed its scenes** → *"Seeded from the plan this project already had."*

Seeding reads the plan v1 already wrote; it does not replace it, so a project made before
this still renders. **Seeding twice does nothing** — it returns zero rather than overwriting
edits somebody made.

## Lock what is right
Mark a scene **locked** to mean "do not regenerate this one". That is the whole point: scene
three can be reworked while one, two and four stay as approved.

Each scene carries its beat, script, start and duration, and optionally the **proof asset** it
rests on. Record that link — a proof-citing scene is the one that must be re-checked when
rights change.

## Accept a cut
**Renders** → **Candidates** with **Attempt**, **Brand QA**, **Claim QA**, **Benchmark**.
Then **Accept this cut** or **Reject** (with a reason — it is required).

Candidates are **kept, not overwritten**: after the fourth attempt the interesting question is
which way the quality moved, and that needs the earlier three to still exist.

**One accepted cut per project.** A second would be two things claiming to be the finished
video.

## Next
SF47 on why the QA verdicts are not the acceptance.
