import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { handleFileReviewedText } from "./file-reviewed-text.js";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const body = { clientId: id(1), requestId: id(2), briefId: id(3), rightsId: id(4), revision: "2026-11-25T10:11:12Z" };
const source = "Testing exact bytes – including a newline.\n";
const path = "private/text.txt";
const object = { id: id(5), version: "v1", updated_at: body.revision };

async function file(mode: "success" | "changed" | "mismatch" | "retry" | "denied") {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const download = vi.fn().mockResolvedValue({ data: new Blob([mode === "mismatch" ? source.trim() : source]), error: null });
  const rpc = vi.fn(async (name, args) => {
    if (name === "active_video_approval_manager") return { data: null, error: null };
    if (args.p_verified_object) return mode === "changed"
      ? { error: { message: "version changed" } } : { data: { asset_id: body.requestId } };
    if (mode === "retry") return { data: { asset_id: body.requestId } };
    return { data: { path, script: source, object: upload.mock.calls.length ? object : null } };
  });
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () =>
    ({ data: { role: mode === "denied" ? "employee" : "admin", is_bot: false }, error: null }) };
  const sb = { auth: { getUser: async () => ({ data: { user: { id: id(6) } } }) },
    from: () => chain, rpc, storage: { from: () => ({ upload, download }) } } as unknown as SupabaseClient;
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST"; req.headers = { authorization: "Bearer fixture" };
  const writeHead = vi.fn(), end = vi.fn();
  await handleFileReviewedText(req, { writeHead, end } as unknown as ServerResponse, sb);
  return { status: writeHead.mock.calls[0]?.[0], upload, download, rpc };
}

it("files the cleared bytes after comparing the downloaded private file", async () => {
  const { status, rpc, upload } = await file("success");
  expect(status).toBe(200);
  expect(upload).toHaveBeenCalledWith(path, Buffer.from(source), expect.objectContaining({ upsert: false }));
  expect(rpc).toHaveBeenLastCalledWith("file_reviewed_proof_text", expect.objectContaining({
    p_verified_object: object, p_actor_id: id(6), p_rights_id: body.rightsId, p_revision: body.revision,
  }));
});
it("stops before filing if a byte differs", async () => {
  const { status, rpc } = await file("mismatch");
  expect(status).toBe(409);
  expect(rpc.mock.calls.some(([,args]) => args.p_verified_object)).toBe(false);
});
it("reports a concurrent version change", async () => expect((await file("changed")).status).toBe(409));
it("resumes a committed filing without another upload", async () => {
  const result = await file("retry");
  expect(result.status).toBe(200); expect(result.upload).not.toHaveBeenCalled();
});
it("denies other operators before reading a source", async () => {
  const result = await file("denied");
  expect(result.status).toBe(403); expect(result.upload).not.toHaveBeenCalled();
  expect(result.rpc.mock.calls.some(([name]) => name === "file_reviewed_proof_text")).toBe(false);
});
