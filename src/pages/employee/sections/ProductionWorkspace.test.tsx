import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tables, inserted, updates, upload, rpc } = vi.hoisted(() => ({
  tables: new Map<string, unknown>(),
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  upload: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const rows = () => Promise.resolve(tables.get(table) ?? { data: [] });
      return {
        select: () => ({
          eq: () => ({
            order: () => Object.assign(rows(), { limit: rows }),
            limit: rows,
            in: rows,
          }),
        }),
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, row });
          return Promise.resolve({ error: tables.get(`${table}:insertError`) ?? null });
        },
        update: (patch: Record<string, unknown>) => ({
          eq: () => {
            updates.push({ table, patch });
            return Promise.resolve({ error: tables.get(`${table}:updateError`) ?? null });
          },
        }),
      };
    },
    storage: { from: () => ({ upload }) },
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

import { ProductionWorkspace } from "./ProductionWorkspace";

const JOB_WITH_BRIEF = {
  id: "job-1",
  title: "Shade Guide Still",
  due_date: "2026-09-30",
  compensation: 250,
  completed_at: null,
  stage: "assigned",
  stage_reason: null,
  client_id: "client-1",
  brief_id: "brief-1",
  clients: { name: "Harbour Dental" },
  client_briefs: {
    title: '"Natural For My Age" Is A Design Brief',
    brief_ref: "HD-0005",
    body: "## Hook\n\nThe shade guide is the whole conversation.",
  },
};

const JOB_NO_BRIEF = {
  ...JOB_WITH_BRIEF,
  id: "job-2",
  title: "Founder intro piece",
  brief_id: null,
  client_briefs: null,
};

function show(jobs: unknown[] = [JOB_WITH_BRIEF]) {
  tables.set("job_assignments", { data: jobs });
  tables.set("client_media_assets", { data: [] });
  return render(<ProductionWorkspace memberId="member-1" variant="editors" />);
}

async function deliver(jobLabel: RegExp) {
  const user = userEvent.setup();
  await screen.findByText("Edit queue");
  await user.selectOptions(screen.getByLabelText("Job"), screen.getByRole("option", { name: jobLabel }));
  await user.upload(
    screen.getByLabelText("File"),
    new File(["x"], "IMG_4032.mov", { type: "video/quicktime" }),
  );
  await user.click(screen.getByRole("button", { name: /Deliver|Upload/i }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  inserted.length = 0;
  updates.length = 0;
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  upload.mockResolvedValue({ error: null });
});

describe("delivering against a brief", () => {
  // The break this file exists for. Without brief_id a human-made asset has
  // no route back to its brief or its idea, so every asset an editor ever
  // delivered was invisible to attribution.
  it("links the delivered asset to the brief the job was for", async () => {
    show();
    await deliver(/Shade Guide Still/);
    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]?.row.brief_id).toBe("brief-1");
    expect(inserted[0]?.row.client_id).toBe("client-1");
    expect(inserted[0]?.row.member_id).toBe("member-1");
  });

  // "IMG_4032.mov" tells a reviewer nothing about what they are approving.
  it("names the asset after the brief, not the camera's filename", async () => {
    show();
    await deliver(/Shade Guide Still/);
    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]?.row.title).toBe('"Natural For My Age" Is A Design Brief');
  });

  // It used to write completed_at directly, which closed the job the instant
  // a file arrived — while the asset was still unreviewed, and leaving a
  // later rejection with nowhere to go.
  it("marks the assignment delivered rather than done", async () => {
    show();
    await deliver(/Shade Guide Still/);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "deliver_assignment",
        expect.objectContaining({ p_assignment_id: "job-1" }),
      ),
    );
    // Nothing writes the stage or completed_at by hand any more: a direct
    // update is refused by trigger.
    expect(updates).toHaveLength(0);
  });

  it("hands over the asset it just created, not a different one", async () => {
    show();
    await deliver(/Shade Guide Still/);
    await waitFor(() => expect(inserted).toHaveLength(1));
    const args = rpc.mock.calls.find((c) => c[0] === "deliver_assignment")![1] as {
      p_asset_id: string;
    };
    expect(args.p_asset_id).toBe(inserted[0]!.row.id);
  });

  it("still delivers for a job with no brief attached", async () => {
    show([JOB_NO_BRIEF]);
    await deliver(/Founder intro piece/);
    await waitFor(() => expect(inserted).toHaveLength(1));
    expect(inserted[0]?.row.brief_id).toBeNull();
    expect(inserted[0]?.row.title).toBe("Founder intro piece");
  });
});

describe("the brief is on the page the work is delivered from", () => {
  it("shows the brief once a job is chosen", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("Edit queue");
    expect(screen.queryByText(/HD-0005/)).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Job"),
      screen.getByRole("option", { name: /Shade Guide Still/ }),
    );
    expect(screen.getByText(/HD-0005/)).toBeInTheDocument();
    expect(screen.getByText(/The shade guide is the whole conversation/)).toBeInTheDocument();
  });

  it("says plainly when a job has no brief to work from", async () => {
    const user = userEvent.setup();
    show([JOB_NO_BRIEF]);
    await screen.findByText("Edit queue");
    await user.selectOptions(
      screen.getByLabelText("Job"),
      screen.getByRole("option", { name: /Founder intro piece/ }),
    );
    expect(screen.getByText(/no brief attached/i)).toBeInTheDocument();
  });
});

describe("when something goes wrong", () => {
  it("does not claim delivery when the upload failed", async () => {
    upload.mockResolvedValue({ error: { message: "Storage quota exceeded" } });
    show();
    await deliver(/Shade Guide Still/);
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage quota exceeded");
    expect(inserted).toHaveLength(0);
  });

  // The file is delivered either way; a failure to record it is worth
  // saying rather than swallowing, but it is not a failed delivery.
  it("reports a delivery that could not be marked delivered", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "denied" } });
    show();
    await deliver(/Shade Guide Still/);
    expect(await screen.findByText(/could not be marked delivered/i)).toBeInTheDocument();
    expect(inserted).toHaveLength(1);
  });
});

describe("the states an assignment can be in", () => {
  const at = (stage: string, over: Record<string, unknown> = {}) => ({
    ...JOB_WITH_BRIEF,
    stage,
    ...over,
  });

  it("offers accept and decline on new work, and nowhere else", async () => {
    // An editor who could not take a job had no way to say so, and the
    // agency found out when the due date passed.
    show([at("assigned")]);
    expect(await screen.findByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("accepts through the named function, not a direct write", async () => {
    // job_assignments.stage is written only by advance_assignment; a direct
    // update is refused by trigger.
    show([at("assigned")]);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("accept_assignment", { p_assignment_id: "job-1" }),
    );
    expect(updates).toHaveLength(0);
  });

  it("will not send a decline with no reason", async () => {
    show([at("assigned")]);
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Decline" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sends the decline with its reason", async () => {
    show([at("assigned")]);
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox"), "Away until the 14th.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("decline_assignment", {
        p_assignment_id: "job-1",
        p_reason: "Away until the 14th.",
      }),
    );
  });

  it("says delivered work is with the reviewer, not that it is done", async () => {
    show([at("delivered")]);
    expect(await screen.findByText("With the reviewer")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("shows the reviewer's reason on work that needs another version", async () => {
    // Before this there was nowhere for it to go: the assignment was
    // already closed when the rejection arrived.
    show([at("rework", { stage_reason: "The first three seconds are dead." })]);
    expect(await screen.findByText("Needs another version")).toBeInTheDocument();
    expect(screen.getByText("The first three seconds are dead.")).toBeInTheDocument();
  });

  it("counts rework as outstanding and delivered as not", async () => {
    show([at("rework"), at("delivered", { id: "job-9", title: "Other" })]);
    await screen.findByText("Needs another version");
    // One of the two is still owed.
    const open = screen.getByText("Open").parentElement;
    expect(open).toHaveTextContent("1");
  });

  it("offers nothing to do on finished work", async () => {
    show([at("approved")]);
    expect(await screen.findByText("Done")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });
});
