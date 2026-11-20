-- Freeze the client's video design inputs when an operator starts the
-- storyboard. A later Brand & Design edit cannot change a critic-approved
-- still or the final MP4 for this project version.
alter table public.video_projects
  add column brand_snapshot jsonb
    check(brand_snapshot is null or jsonb_typeof(brand_snapshot)='object'),
  add column brand_snapshot_sha256 text
    check(brand_snapshot_sha256 is null
      or brand_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint video_project_brand_snapshot_pair_v1
    check((brand_snapshot is null)=(brand_snapshot_sha256 is null));

create function public.video_project_brand_snapshot_guard_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare b public.client_brand_profiles%rowtype;
  v_snapshot jsonb;
begin
  if old.stage='draft' and new.stage='queued' then
    if old.brand_snapshot is not null or old.brand_snapshot_sha256 is not null then
      raise exception 'Draft brand snapshot already exists.' using errcode='23514';
    end if;
    select * into b from public.client_brand_profiles
      where client_id=old.client_id for share;
    v_snapshot:=case when b.client_id is null then '{}'::jsonb else
      jsonb_build_object(
        'colour_primary',b.colour_primary,
        'colour_secondary',b.colour_secondary,
        'colour_accent',b.colour_accent,
        'colour_background',b.colour_background,
        'colour_text',b.colour_text,
        'font_heading',b.font_heading,
        'font_body',b.font_body,
        'imagery_style',b.imagery_style,
        'never_do',b.never_do,
        'video_rulebook_notes',b.video_rulebook_notes,
        'narrator_voice_id',b.narrator_voice_id,
        'video_tokens',b.video_tokens) end;
    new.brand_snapshot:=v_snapshot;
    new.brand_snapshot_sha256:=encode(
      sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  elsif new.brand_snapshot is distinct from old.brand_snapshot
    or new.brand_snapshot_sha256 is distinct from old.brand_snapshot_sha256 then
    raise exception 'Started video brand snapshot is immutable.'
      using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.video_project_brand_snapshot_guard_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_brand_snapshot_guard_v1
  before update on public.video_projects for each row
  execute function public.video_project_brand_snapshot_guard_v1();

comment on column public.video_projects.brand_snapshot is
  'Exact client video brand inputs captured on draft-to-queued transition. Null on historical projects means brand identity is unverified and rendering must hold.';
