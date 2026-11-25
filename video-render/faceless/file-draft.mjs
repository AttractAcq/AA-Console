// Trusted operator entry point. The browser never receives this service credential.
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [ref, client, brief] = process.argv.slice(2);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
if (ref !== "bancbdztffokwiifzoiv" || !uuid.test(client) || !uuid.test(brief)) {
  throw new Error("Specify the Console project ref, client UUID and enrolled brief UUID.");
}
const url = process.env.SUPABASE_URL;
if (url !== `https://${ref}.supabase.co` || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for this Console project.");
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false, autoRefreshToken:false } });
const base = path.dirname(fileURLToPath(import.meta.url));
function checked(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}
const enrolled = checked(await db.from("faceless_reel_previews_v1").select("project_id,storage_path,file_sha256")
  .eq("client_id",client).eq("brief_id",brief).single());
if (!enrolled.project_id) throw new Error("The reviewer must save the storyboard first.");
const project = checked(await db.from("video_projects").select("id,source_digest,brand_snapshot,ir_version,target_length_sec")
  .eq("client_id",client).eq("brief_id",brief).eq("id",enrolled.project_id)
  .eq("stage","draft").eq("draft_renderer","workspace-diagram-v1").single());
const rows = checked(await db.from("video_scenes").select("position,props,duration_sec")
  .eq("client_id",client).eq("project_id",project.id).order("position"));
const scenes = rows.map(s => ({position:s.position, caption:s.props.caption, duration_sec:s.duration_sec}));
if (scenes.length !== 7 || scenes.reduce((sum,s) => sum+s.duration_sec,0) !== project.target_length_sec) {
  throw new Error("The storyboard timing differs from the project.");
}
const bucket = db.storage.from("client-media");
const directory = `${client}/video/projects/${project.id}/ir-v${project.ir_version}`;
const name = `draft-${project.source_digest}.mp4`;
const key = directory+"/"+name;
if (enrolled.storage_path && enrolled.storage_path !== key) throw new Error("Existing receipt requires reconciliation.");
const existing = checked(await bucket.list(directory,{search:name})).some(o => o.name === name);
if (enrolled.storage_path && !existing) throw new Error("The filed preview object is missing.");
const folder = await mkdtemp(path.join(tmpdir(),"aa-motion-draft-"));
const item = rel => path.join(folder,rel);
const env = {PATH:process.env.PATH, HOME:process.env.HOME, TMPDIR:tmpdir(), DO_NOT_TRACK:"1", HYPERFRAMES_NO_TELEMETRY:"1", HYPERFRAMES_NO_UPDATE_CHECK:"1"};
const digest = data => createHash("sha256").update(data).digest("hex");
function run(command,args) {
  try {
    return execFileSync(command,args,{cwd:folder, env, stdio:["ignore","pipe","pipe"],maxBuffer:64*1024*1024});
  } catch {
    // Third-party stderr may contain storyboard text or private file paths.
    throw new Error("Local render or media probe failed. No publication action was taken.");
  }
}
function probe(file) {
  const {streams} = JSON.parse(run("ffprobe",["-v","error","-show_streams","-of","json",file]));
  const v = streams[0];
  if (streams.length !== 1 || v.codec_name !== "h264" || v.width !== 1080 || v.height !== 1920
    || v.avg_frame_rate !== "30/1" || Number(v.duration) !== project.target_length_sec
    || Number(v.nb_frames) !== 30*project.target_length_sec) throw new Error("The draft failed its media probe.");
  return v;
}
try {
  let localHash;
  if (!existing) {
    await writeFile(item("storyboard.json"),JSON.stringify({scenes,brand:project.brand_snapshot}),{mode:0o600});
    run(process.execPath,[path.join(base,"compile-workspace.mjs"),item("storyboard.json"),item("composition"),
      path.join(base,"node_modules/gsap/dist/gsap.min.js")]);
    run(process.execPath,[path.join(base,"node_modules/hyperframes/bin/hyperframes.mjs"),"render",item("composition"),
      "--output",item("draft.mp4"),"--fps","30","--workers","1"]);
    probe(item("draft.mp4"));
    const bytes = await readFile(item("draft.mp4"));
    localHash = digest(bytes);
    checked(await bucket.upload(key,bytes,{contentType:"video/mp4",upsert:false}));
  }
  // A retry reconciles a completed upload. No second render or overwrite.
  const bytes = Buffer.from(await checked(await bucket.download(key)).arrayBuffer());
  const hash = digest(bytes);
  if ((localHash && localHash !== hash) || (enrolled.file_sha256 && enrolled.file_sha256 !== hash)) {
    throw new Error("Downloaded bytes differ from their render receipt.");
  }
  await writeFile(item("readback.mp4"),bytes,{mode:0o600});
  const v = probe(item("readback.mp4"));
  checked(await db.rpc("file_faceless_reel_preview_v1",{p_client_id:client,p_project_id:project.id,
    p_source_digest:project.source_digest,p_ir_version:project.ir_version,p_sha256:hash,p_bytes:bytes.length,
    p_width:v.width,p_height:v.height,p_frames:Number(v.nb_frames),p_fps:30}));
  console.log(JSON.stringify({brief,project:project.id,revision:project.ir_version,sha256:hash,frames:Number(v.nb_frames),providerCalls:0}));
} finally {
  await rm(folder,{recursive:true,force:true});
}
