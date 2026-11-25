import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FacelessReelStoryboard, type ReelPreview } from "./FacelessReelStoryboard";

const { rpc, from, urls } = vi.hoisted(() => ({
  rpc:vi.fn(), from:vi.fn(), urls:new Map<string,string>(),
}));
vi.mock("../../lib/supabase", () => ({supabase:{rpc,from}}));
vi.mock("../../lib/useSignedPreviewPaths", () => ({useSignedPreviewPaths:() => urls}));
const preview: ReelPreview = { client_id:"client",brief_id:"brief",reviewed_updated_at:"v1",
  project_id:null,file_bytes:null,file_sha256:null,storage_path:null,filed_at:null };

describe("faceless storyboard from a saved brief", () => {
  it("requires the reviewed revision before creating the draft", async () => {
    const reload = vi.fn();
    rpc.mockResolvedValue({error:null,data:"project"});
    const {rerender} = render(<FacelessReelStoryboard preview={preview} updatedAt="changed" reload={reload}/>);
    expect(screen.getByRole("button",{name:"Approve brief and save storyboard"})).toBeDisabled();
    rerender(<FacelessReelStoryboard preview={preview} updatedAt="v1" reload={reload}/>);
    fireEvent.click(screen.getByRole("button",{name:"Approve brief and save storyboard"}));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("prepare_faceless_reel_preview_v1",{
      p_client_id:"client",p_brief_id:"brief",p_expected_updated_at:"v1",
    });
  });

  it("reopens a filed private draft with its source campaign and seven scenes", async () => {
    const scenes = Array.from({length:7},(_,n)=>({position:n+1,props:{caption:"Scene "+(n+1)},duration_sec:n===3?5:4}));
    from.mockImplementation(() => {
      const chain = {select:()=>chain,eq:()=>chain,single:async()=>({data:{
        id:"project",source_digest:"digest",source_snapshot:[{campaign_id:"campaign"}]}, error:null}),
        order:async()=>({data:scenes,error:null})}; return chain;
    });
    urls.set("stored-draft","signed-preview");
    render(<FacelessReelStoryboard updatedAt="v2" reload={vi.fn()} preview={{...preview,project_id:"project",
      storage_path:"stored-draft",filed_at:"today"}}/>);
    expect(await screen.findByRole("link",{name:"Source campaign"})).toHaveAttribute("href","/clients/client/delivery/campaign-factory/campaign");
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByLabelText("Faceless reel draft")).toHaveAttribute("src","signed-preview");
    expect(screen.queryByRole("button",{name:/Approve|Edit scene/})).toBeNull();
  });
});
