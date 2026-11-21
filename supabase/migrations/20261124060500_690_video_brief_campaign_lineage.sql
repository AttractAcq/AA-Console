-- A video brief bound to a campaign route must actually originate from that
-- campaign's idea. A brief normally archives its source idea as part of the
-- content pipeline, so archived_at is not a validity check here. Recheck
-- during production so a later reassignment cannot silently move its source.
create function public.video_project_brief_campaign_guard_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare source_campaign uuid;
begin
  if new.brief_id is null or new.campaign_id is null then
    return new;
  end if;
  if tg_op='UPDATE' then
    if old.stage in ('attached','published')
      and new.stage in ('attached','published') then return new; end if;
  end if;
  select i.campaign_id into source_campaign
    from public.client_briefs b
    join public.client_ideas i on i.id=b.source_idea_id
      and i.client_id=b.client_id
    where b.id=new.brief_id and b.client_id=new.client_id;
  if source_campaign is distinct from new.campaign_id then
    raise exception 'Video brief must originate from the bound campaign.'
      using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.video_project_brief_campaign_guard_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_brief_campaign_guard_v1
  before insert or update on public.video_projects
  for each row execute function public.video_project_brief_campaign_guard_v1();

comment on function public.video_project_brief_campaign_guard_v1() is
  'Requires a bound campaign video brief to originate from an idea in that campaign during draft and production; attached historical assets retain their source snapshot.';
