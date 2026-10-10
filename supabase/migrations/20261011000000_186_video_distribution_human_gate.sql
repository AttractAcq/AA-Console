-- The Bot distribution RPC checks review_status. A production Bot can set that
-- field without completing the owner/SMM/client video sign-offs. Enforce the
-- human gate on the scheduled row so every writer follows the same contract.
create or replace function guard_scheduled_video_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_asset client_media_assets%rowtype;
begin
  if new.asset_id is null then return new; end if;
  select * into v_asset from client_media_assets where id = new.asset_id;
  if v_asset.id is null then raise exception 'Scheduled asset not found.'; end if;
  if v_asset.media_type = 'video' and (v_asset.review_status <> 'approved'
      or v_asset.human_approved_at is null) then
    raise exception 'Finish human video approval before scheduling this asset.';
  end if;
  return new;
end;
$$;

create trigger sp_guard_video_approval before insert or update
  on scheduled_posts for each row execute function guard_scheduled_video_approval();
