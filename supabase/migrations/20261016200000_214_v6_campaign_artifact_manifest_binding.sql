-- Record the exact campaign package active when a new artifact is linked.
-- Historical links remain NULL: their package cannot be inferred safely.
alter table public.campaign_artifacts
  add column manifest_id uuid;

alter table public.campaign_artifacts
  add constraint campaign_artifacts_manifest_identity_fk
  foreign key (manifest_id, campaign_id, client_id)
  references public.campaign_manifest_versions (id, campaign_id, client_id)
  on delete no action deferrable initially deferred;

create index campaign_artifacts_manifest_idx
  on public.campaign_artifacts (manifest_id) where manifest_id is not null;

create function public.bind_campaign_artifact_manifest_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_mode text;
begin
  if TG_OP = 'UPDATE' and new.campaign_id = old.campaign_id
      and new.client_id = old.client_id then
    if new.manifest_id is distinct from old.manifest_id then
      raise exception 'Campaign artifact package binding is immutable';
    end if;
    return new;
  end if;
  select acquisition_mode into v_mode
  from public.client_campaigns
  where id = new.campaign_id and client_id = new.client_id;

  if v_mode in ('organic', 'paid') then
    select id into new.manifest_id
    from public.campaign_manifest_versions
    where campaign_id = new.campaign_id and client_id = new.client_id
    order by version desc limit 1;
  else
    new.manifest_id := null;
  end if;
  return new;
end;
$$;

create trigger campaign_artifacts_bind_manifest_v6
  before insert or update of campaign_id, client_id, manifest_id
  on public.campaign_artifacts
  for each row execute function public.bind_campaign_artifact_manifest_v6();

comment on column public.campaign_artifacts.manifest_id is
  'Exact v6 package at link creation. NULL means legacy or no package existed yet; older links are never guessed.';
