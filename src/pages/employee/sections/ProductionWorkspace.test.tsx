import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tables, inserted, updates, upload } = vi.hoisted(() => ({
  tables: new Map<string, unknown>(),
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  upload: vi.fn(),
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
  },
}));

import { ProductionWorkspace } from "./ProductionWorkspace";

const JOB_WITH_BRIEF = {
  id: "job-1",
  title: "Shade Guide Still",
  due_date: "2026-09-30",
  compensation: 250,
  completed_at: null,
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

  // Otherwise a delivered job sits in the open queue forever and nobody can
  // tell what is still outstanding.
  it("closes the assignment on delivery", async () => {
    show();
    await deliver(/Shade Guide Still/);
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.table).toBe("job_assignments");
    expect(typeof updates[0]?.patch.completed_at).toBe("string");
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

  // The file is delivered either way; a failure to close the job is worth
  // saying rather than swallowing, but it is not a failed delivery.
  it("reports a delivery whose job could not be closed", async () => {
    tables.set("job_assignments:updateError", { message: "denied" });
    show();
    await deliver(/Shade Guide Still/);
    expect(await screen.findByText(/could not be marked done/i)).toBeInTheDocument();
    expect(inserted).toHaveLength(1);
  });
});
