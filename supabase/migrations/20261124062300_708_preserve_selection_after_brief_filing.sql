-- A filed brief advances one idea through production. Keep the other exact
-- selections usable. Existing stale plans still require human review.
begin;

create or replace function public.advance_campaign_planned_idea_epoch_v7()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_campaign uuid; new_campaign uuid;
begin
  if tg_op<>'INSERT' then old_campaign:=old.campaign_id; end if;
  if tg_op<>'DELETE' then new_campaign:=new.campaign_id; end if;
  if tg_op='UPDATE' and new_campaign is not distinct from old_campaign and
    (to_jsonb(new)-array['status','job_id','created_at','updated_at',
      'approved_request_id','approved_content_hash']) is not distinct from
    (to_jsonb(old)-array['status','job_id','created_at','updated_at',
      'approved_request_id','approved_content_hash']) then return new; end if;
  -- Filing a job's exact brief archives its source in a nested AFTER INSERT
  -- trigger. Keep that single lifecycle transition out of the revision counter.
  if tg_op='UPDATE' and pg_trigger_depth()>1 and old.archived_at is null
    and new.archived_at is not null and new.status='briefed'
    and (to_jsonb(new)-array['archived_at','updated_at']) =
        (to_jsonb(old)-array['archived_at','updated_at'])
    and exists (select 1 from public.client_briefs b where b.client_id=new.client_id
      and b.source_idea_id=new.id and b.job_id=new.job_id and b.created_at=new.archived_at)
    then return new; end if;
  update public.client_campaigns set planned_idea_epoch=planned_idea_epoch+1
    where id=old_campaign;
  if new_campaign is distinct from old_campaign then
    update public.client_campaigns set planned_idea_epoch=planned_idea_epoch+1
      where id=new_campaign;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.campaign_planned_idea_hash_v7(p_campaign_id uuid)
returns text language sql stable security invoker set search_path=pg_catalog,public as $$
  select md5(coalesce((select jsonb_agg(
    -- Retain the original JSON shape of every reviewed active idea. Archive
    -- edits outside a verified brief filing still advance planned_idea_epoch.
    (to_jsonb(i) || jsonb_build_object('archived_at',null))-array['status','job_id','created_at','updated_at',
      'approved_request_id','approved_content_hash'] order by i.campaign_position)::text
    from public.client_ideas i where i.campaign_id=p_campaign_id),'[]'))
$$;

create or replace function public.campaign_planned_ideas_match_spec_v7(p_campaign_id uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype; s public.campaign_content_spec_versions_v7%rowtype;
begin
  select * into c from public.client_campaigns where id=p_campaign_id;
  if c.id is null or c.content_spec_id is null or c.content_spec_hash is null
    or c.content_ideas_generated_at is null then return false; end if;
  select * into s from public.campaign_content_spec_versions_v7 where id=c.content_spec_id;
  if s.id is null or s.campaign_id<>c.id or s.client_id<>c.client_id
    or s.content_hash<>c.content_spec_hash
    or jsonb_array_length(s.pieces)<>c.content_count
    or (select count(*) from public.client_ideas i where i.campaign_id=c.id)<>c.content_count
    then return false; end if;
  return not exists(
    select 1 from jsonb_array_elements(s.pieces) with ordinality p(piece,pos)
    left join public.client_ideas i on i.campaign_id=c.id and i.client_id=c.client_id
      and i.campaign_position=p.pos
    where i.id is null or (i.archived_at is not null and
      (i.status<>'briefed' or not exists (
        select 1 from public.client_briefs b where b.client_id=i.client_id
          and b.source_idea_id=i.id and b.job_id=i.job_id and b.created_at=i.archived_at)))
      or i.media_type::text is distinct from (p.piece->>'media_type')
      or i.content_format::text is distinct from (p.piece->>'content_format')
      or i.acquisition_route is distinct from (p.piece->>'route')
      or (p.piece->>'platform'<>'google_ads' and
        i.target_platform::text is distinct from (p.piece->>'platform'))
      or (p.piece->>'platform'='google_ads' and i.target_platform is not null));
end $$;

commit;
