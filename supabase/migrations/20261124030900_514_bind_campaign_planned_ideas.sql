-- The sweep consumes the planner's saved ideas when they exist. Bind their
-- route to the approved per-piece specification and refuse shape drift.
begin;

create function public.bind_campaign_planned_ideas_v7(p_campaign_id uuid)
returns uuid[] language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype;
  spec public.campaign_content_spec_versions_v7%rowtype;
  piece jsonb; idea public.client_ideas%rowtype;
  position integer:=0; ids uuid[]:=array[]::uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the campaign runtime may bind planned ideas.' using errcode='42501'; end if;
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null or c.content_spec_id is null or c.content_spec_hash is null then
    raise exception 'Campaign content requirements are unavailable.' using errcode='23514'; end if;
  select * into spec from public.campaign_content_spec_versions_v7 where id=c.content_spec_id;
  if spec.id is null or spec.client_id<>c.client_id or spec.campaign_id<>c.id
    or spec.content_hash<>c.content_spec_hash then
    raise exception 'Campaign content requirements have changed.' using errcode='23514'; end if;
  if c.content_ideas_generated_at is null then return ids; end if;
  if (select count(*) from public.client_ideas where campaign_id=c.id and client_id=c.client_id)
      <>c.content_count then
    raise exception 'The planned idea batch is incomplete.' using errcode='23514'; end if;
  for piece in select value from jsonb_array_elements(spec.pieces) loop
    position:=position+1;
    select * into idea from public.client_ideas
      where campaign_id=c.id and client_id=c.client_id and campaign_position=position
      for update;
    if idea.id is null or idea.archived_at is not null
      or idea.media_type::text<>piece->>'media_type'
      or idea.content_format::text<>piece->>'content_format'
      or (piece->>'platform'<>'google_ads' and idea.target_platform::text is distinct from piece->>'platform')
      or (piece->>'platform'='google_ads' and idea.target_platform is not null)
      or (idea.acquisition_route is not null and idea.acquisition_route<>piece->>'route') then
      raise exception 'Planned idea % no longer matches the reviewed content requirements.',position
        using errcode='23514'; end if;
    if idea.acquisition_route is null then
      update public.client_ideas set acquisition_route=piece->>'route' where id=idea.id;
    end if;
    ids:=array_append(ids,idea.id);
  end loop;
  return ids;
end $$;
revoke all on function public.bind_campaign_planned_ideas_v7(uuid) from public,anon,authenticated;
grant execute on function public.bind_campaign_planned_ideas_v7(uuid) to service_role;

commit;
