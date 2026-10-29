# SF45 — Edit a source video with AI and request a revision

**Where.** Clients → [client] → Delivery → Content Production Factory → Edit / Repurpose
**Owner.** Creative lead. **Reviewed.** 25 October 2026. **Part of** MF08.

## Do it
1. **Add video for editing** →
   - **Video source** — the raw footage
   - **Video title**
   - **Video format**
   - **Editing notes** — what the edit should do
   - **Related brief** — link it, so QA has something to judge against
   - **Usage rights** — the footage's permission (SF25)
2. The source video editor runs and returns an **AI edit result**.
3. Request a revision if it is not right. **Revisions are tracked rather than overwriting**,
   so you can see whether attempt three was better than attempt two.

## Writing editing notes that work
Be concrete and ordered: "cut the first four seconds, caption the price on screen at 0:06,
end on the logo". Vague notes ("make it punchier") produce a different video, not a better one.

## Then
QA (SF41), the video acceptance screen, approval (SF42).

## Gotcha
Renders run on the runtime, not on a local machine. If you are testing locally, ffmpeg here
has no drawtext and text-overlay renders will fail — that is a local tooling limit, not a
problem with the edit.
