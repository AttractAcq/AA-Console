-- Keep the briefer's original source identifiable after a reviewer excludes
-- it from artwork. Existing briefs retain their previous production behavior.
begin;
alter table public.client_briefs add column excluded_artwork_proof_id uuid
  references public.client_proof_assets(id);
alter table public.client_briefs add constraint independent_artwork_brief check (
  excluded_artwork_proof_id is null or
  (media_type='image' and content_format='single' and purpose='client' and proof_asset_id is null)
);

create function public.exclude_brief_artwork_proof(p_client_id uuid, p_brief_id uuid,
  p_revision timestamptz, p_proof_id uuid) returns void language plpgsql security invoker
set search_path=pg_catalog,public as $$
declare
  b public.client_briefs%rowtype;
  section text;
  before_section text;
  after_section text;
  loc integer;
  note constant text := 'Use an independent illustration. No proof asset supplies the artwork.';
begin
  if auth.role() is distinct from 'authenticated'
    or not exists(select 1 from public.profiles where id=auth.uid() and not is_bot)
    then raise exception 'A signed-in human editor is required.' using errcode='42501'; end if;
  select * into strict b from public.client_briefs where id=p_brief_id and client_id=p_client_id
    and purpose='client' and media_type='image' and content_format='single'
    and archived_at is null and status='draft' for update;
  if b.excluded_artwork_proof_id is not null and b.excluded_artwork_proof_id=p_proof_id then return; end if;
  if b.updated_at is distinct from p_revision or p_proof_id is null or b.proof_asset_id is distinct from p_proof_id
    or not exists(select 1 from public.client_proof_assets where id=p_proof_id and client_id=b.client_id)
    or exists(select 1 from public.proof_production_requests where idea_id=b.source_idea_id and client_id=b.client_id)
    or exists(select 1 from public.creative_generations where brief_id=b.id)
    or exists(select 1 from public.job_assignments where brief_id=b.id)
    or nullif(btrim(b.proof),'') is null then raise exception 'Refresh the draft and review its proof source before changing the artwork.'; end if;
  section := '## Proof'||chr(10)||chr(10)||b.proof;
  loc := strpos(b.body,section);
  before_section := left(b.body,loc-1);
  after_section := substr(b.body,loc+length(section));
  if loc is null or loc=0 or (before_section<>'' and right(before_section,2)<>(chr(10)||chr(10)))
    or (after_section<>'' and left(after_section,5)<>(chr(10)||chr(10)||'## '))
    or strpos(after_section,section)>0 then raise exception 'The saved Proof section differs from the worker document.'; end if;
  update public.client_briefs set proof=note, proof_asset_id=null, excluded_artwork_proof_id=p_proof_id,
    body=before_section||'## Proof'||chr(10)||chr(10)||note||after_section where id=b.id;
  if not found then raise exception 'Editing this brief is unavailable.' using errcode='42501'; end if;
end $$;
revoke all on function public.exclude_brief_artwork_proof(uuid,uuid,timestamptz,uuid) from public,anon,service_role;
grant execute on function public.exclude_brief_artwork_proof(uuid,uuid,timestamptz,uuid) to authenticated;
commit;
