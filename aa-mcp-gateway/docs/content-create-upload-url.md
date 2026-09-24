# content.create_upload_url

Production uploads image bytes without a service-role key in the bot environment.

## Flow

1. `content.create_upload_url` as `bot_production`, with `brief_id` and `content_type` (`image/png`, `image/jpeg`, or `image/webp`). Optional `filename` and `byte_size` (1–26214400).
2. The gateway calls Console `/internal/mcp/content/create-upload-url`. The RPC checks the bot, the client grant, that the brief exists, that `client_briefs.client_id` is `e4b4b001-81f6-4997-8429-ff21f4ee1fbe` (Attract Acquisition) or the brief's idea points at `client_campaigns.id` `457e0ca8-8af6-4ead-a39d-d5326c729882`, and that brief status is `draft`, `approved`, or `in_production` and not archived. It reserves `{client_id}/{pending_asset_id}.{ext}` in `client-media` for 30 minutes.
3. The Console runtime, which already holds `SUPABASE_SERVICE_ROLE_KEY`, calls Storage `createSignedUploadUrl` and returns `{ upload_url, storage_path, pending_asset_id, expires_at, content_type, headers }`. The URL is not a long-lived key. Supabase's upload token is single-use. The reservation TTL is 30 minutes even though the platform token may live longer; `content.submit_asset` rejects an expired or already-consumed reservation.
4. The bot `PUT`s the file to `upload_url` with `headers` (`content-type`, `cache-control`). Do not send the service role.
5. Existing `content.submit_asset` stays metadata-only. Required fields are unchanged: `client_id`, `idempotency_key`, `storage_path` (the path from step 3), `media_type: "image"`. Optional: `brief_id`, `title`, `assignment_id`. It inserts `client_media_assets` (`review_status=pending`) only after the object is in the bucket, then consumes the reservation.

`bot_chief_of_staff` may call the same tool as a read-check. The response is `{ client_id, brief_id, brief_status, eligible: true, read_check: true }` and never includes `upload_url` or `storage_path`. Marketing and every other bot are hard-denied.

## Smoke (one Harbour PNG)

The RPC requires the brief to exist, `client_briefs.client_id` to match the granted `client_id`, and one of:

- `client_briefs.client_id` = `e4b4b001-81f6-4997-8429-ff21f4ee1fbe` (Attract Acquisition), or
- `client_ideas.campaign_id` = `client_campaigns.id` `457e0ca8-8af6-4ead-a39d-d5326c729882` (organic launch, `status=planning`) via `client_briefs.source_idea_id`. Briefs have no `campaign_id` column.

Status must be `draft`, `approved`, or `in_production`, and `archived_at` must be null.

1. Apply migration `20260924110000_126_content_create_upload_url.sql` (Alex via Chief of Staff; do not apply it from this PR alone).
2. Deploy the gateway and the agent-runtime together. The runtime already has the service role; do not add it to the Production bot env.
3. As `bot_production`, `content.get_brief` or list the campaign's ideas/briefs and pick one draft `brief_id`.
4. `content.create_upload_url` with that `brief_id` and `content_type: "image/png"`.
5. `PUT` one PNG to `upload_url` using the returned `headers`.
6. `content.submit_asset` with the same `brief_id`, `storage_path`, and `media_type: "image"`.
7. Confirm a `client_media_assets` row with `review_status=pending` and that storage path. A second submit of the same reservation returns `upload_consumed`.

CoS can call the tool against the same brief and should see `eligible: true` with no URL.
