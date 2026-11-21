-- A campaign video may be drafted before its brief is selected, but it must
-- not enter production without the exact brief. The existing lineage trigger
-- verifies that a supplied brief originates from this campaign's idea.
create function public.video_project_campaign_brief_start_guard_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if new.campaign_id is not null and new.brief_id is null
    and new.stage<>'draft' then
    if tg_op='INSERT' then
      raise exception 'A campaign video needs an approved brief before production.'
        using errcode='23514';
    elsif old.stage='draft' then
      raise exception 'A campaign video needs an approved brief before production.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.video_project_campaign_brief_start_guard_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_campaign_brief_start_guard_v1
  before insert or update on public.video_projects
  for each row execute function public.video_project_campaign_brief_start_guard_v1();

comment on function public.video_project_campaign_brief_start_guard_v1() is
  'Holds a campaign-bound video at draft until it has a brief; existing campaign/brief lineage and current status checks remain separate.';
