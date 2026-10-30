# Private Storage URL policy and retirement gap

Status: code policy implemented; B005 retirement acceptance remains open. This file describes the repo behavior at this change, not a successful live revocation test.

## Issuer inventory

| Purpose | Issuer and callers | Lifetime | Where the URL goes |
| --- | --- | ---: | --- |
| Browser media and text preview | `src/lib/media.ts:signPaths`, called by Media Library, Distribution Assets, Content Asset Table, Frame Strip, brief Concept Workspace, campaign content, Approvals and Engine Inbox, Proof Factory, Client Console, employee production and SMM approvals, Media edit/reel/video panels, motion design, recruitment, finished work and contact logo | 900 seconds | React state and DOM media elements; `fetchTextBodies` fetches text through it. No database write of the URL was found. |
| Browser single-object helper | `src/lib/supabase.ts:signedUrl` | 900 seconds | No current caller; the helper has no caller-supplied expiry parameter. |
| Browser brief reference preview | `src/components/briefs/ApproveAndBuildModal.tsx:uploadReference` | 900 seconds | React state and an `<img>` only. The build RPC receives the object path, not the signed URL. |
| Meta organic publisher | `agent-runtime/src/agents/publisher/index.ts:prepare` | 3600 seconds | Ephemeral adapter request for one media object or ordered carousel/story frames; Meta fetches the URL. The database stores provider publication IDs/URLs, not these Storage URLs. |
| Google Business proof placement | `agent-runtime/src/proof-distribution/placer.ts:resolvePayload` | 3600 seconds | Ephemeral `createLocalPost` body; Google fetches the image. The database stores the provider post ID/URL. |
| Higgsfield render reference | `agent-runtime/src/agents/video_build/index.ts:signedStillUrls` | 3600 seconds | Ephemeral image URL in a Higgsfield submission. The frame row stores the provider request ID, not the signed still URL. |
| Signed **upload** URL | `agent-runtime/src/mcp/content-route.ts:attachSignedUpload` | Supabase fixed two hours | Returned only to the authorized production bot for one PUT. It is a separate credential class; `createSignedUploadUrl` exposes no `expiresIn` parameter in the current SDK. The response must never be logged or persisted. |

The three read URL purposes use named constants; no page, job payload or arbitrary caller can increase their expiry through the shared helpers. Provider fetches retain the existing one-hour budget because the actual fetch latency and provider retry behavior have not been measured. A shorter budget may break asynchronously fetched media. The runtime now withholds a provider error containing a signed Storage URL before it reaches job events or failure rows; never record adapter request bodies or raw signed query tokens.

## Object cache policy

New private browser and runtime uploads in this repo specify `cacheControl: "60"`, and the signed upload route supplies `cache-control: max-age=60` to its caller. This is a one-minute HTTP object-cache lifetime for **newly uploaded** objects. Previously uploaded objects retain their existing cache metadata; this code does not rewrite them. Verify the response and CDN headers on test objects in staging before treating 60 seconds as an observed bound. Signed URL expiry and cached object lifetime are separate: a previously fetched response can remain available after the token expires, and deleting an object may take time to invalidate a CDN cache. See the [Supabase Smart CDN guide](https://supabase.com/docs/guides/storage/cdn/smart-cdn) and [Storage serving and revocation guide](https://supabase.com/docs/guides/storage/serving/downloads).

The shared `uploadThen` helper is used for proof, SOPs, contracts and lead magnets. Direct uploads cover client media and public proof capture. A future upload path must adopt this cache policy rather than relying on Supabase's usual one-hour default. The only signed PUT route currently returns the cache header as data; the receiving bot must actually send it on upload, which needs a staging wire test.

## Long-lived page limitation

Browser panels load preview URLs when their data is loaded and currently do not refresh those URLs on expiry. A reviewer who leaves an Approvals, Media, Client or employee page open longer than 15 minutes can see a broken preview on its next fetch. A page reload or remount signs fresh URLs if the user still has Storage permission. A cached image may remain visible after access is removed. An automatic re-sign-on-focus/expiry hook across all preview panels is follow-up work before claiming polished long-lived review behavior; it must recheck current authorization and must never extend the old bearer URL.

## Retirement and emergency procedure to prove in staging

1. Use a designated test principal and object in each relevant private bucket. Record the object path, tenant, active identity and test timestamps **without recording any signed URL**. Mint a preview URL, fetch once, then retire or unassign the principal.
2. Confirm the retired principal cannot list/download the object or mint another URL; verify unrelated client and assigned active identities separately. Measure the old URL's response before and after token expiry, both with a warm CDN/browser cache and an uncached request. Include `cf-cache-status`, `Cache-Control` and observed expiry in a restricted evidence record.
3. For immediate sensitive-object retirement, require an exact-version decision in the Approval Inbox for the affected object and replacement path. Mark dependent media/proof metadata unavailable, then delete or move/rename the old Storage object through the Storage API. Upload a replacement at a new path if content should remain available. Repair all metadata/lineage references to that new path, with a checked compensating step if Storage succeeds but the DB update fails.
4. Verify the old signed URL stops returning bytes after CDN invalidation, fresh signing of the old path fails, and all dependent preview surfaces show an unavailable state until the replacement is ready. A user may retain a local browser/offline copy; deletion cannot erase that copy. Escalate to object/bucket CDN purge or signing-key revocation only if the observed residual window is unacceptable, following the Supabase procedure and its impact on other URLs.
5. Repeat for client media and proof objects; validate the active/retired identity matrix and production configuration before B005 is accepted. This code change alone does not satisfy those checks.

Supabase documents `createSignedUrl`/`createSignedUrls` expiry as seconds ([single](https://supabase.com/docs/reference/javascript/file-buckets-createsignedurl), [batch](https://supabase.com/docs/reference/javascript/file-buckets-createsignedurls)), upload `cacheControl` as a file option ([upload](https://supabase.com/docs/reference/javascript/file-buckets-upload)), and signed upload URLs as valid for two hours ([signed upload](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl)).
