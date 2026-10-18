-- A legacy site publisher commits pages directly to GitHub Pages. Until its
-- exact-version approval executor exists, a v6 campaign page must not enter
-- either the admin or MCP publish path.
create function public.assert_page_publish_allowed_v6(p_page_id uuid)
returns void language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if not exists (select 1 from public.client_pages where id = p_page_id) then
    raise exception 'Page not found.';
  end if;
  if exists (
    select 1 from public.campaign_artifacts a
    join public.client_campaigns c on c.id = a.campaign_id
    where a.page_id = p_page_id and a.kind = 'landing_page'
      and c.acquisition_mode in ('organic', 'paid')
  ) then
    raise exception 'V6 campaign page publishing requires exact-version human approval and its executor. This page is not publishable yet.';
  end if;
end;
$$;
revoke all on function public.assert_page_publish_allowed_v6(uuid)
  from public, anon, authenticated;
grant execute on function public.assert_page_publish_allowed_v6(uuid)
  to service_role;

-- A page that is already live cannot be attached to a v6 campaign after the
-- publisher check. This closes the reverse route into external publication.
create function public.guard_live_page_campaign_link_v6()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.kind = 'landing_page' and new.page_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'v6-page-publish:' || new.page_id::text, 0));
  end if;
  if new.kind = 'landing_page' and new.page_id is not null
     and exists (select 1 from public.client_campaigns c
       where c.id = new.campaign_id and c.client_id = new.client_id
         and c.acquisition_mode in ('organic', 'paid'))
     and exists (select 1 from public.client_pages p
       where p.id = new.page_id and p.client_id = new.client_id
         and (p.published_url is not null or p.publish_status in ('publishing', 'published'))) then
    raise exception 'A live page cannot be attached to a v6 campaign without an exact-version approval executor.';
  end if;
  return new;
end;
$$;
create trigger guard_live_page_campaign_link_v6
  before insert or update of campaign_id, client_id, kind, page_id
  on public.campaign_artifacts
  for each row execute function public.guard_live_page_campaign_link_v6();

create function public.guard_v6_page_publishing()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.publish_status = 'publishing' then
    perform pg_advisory_xact_lock(hashtextextended(
      'v6-page-publish:' || new.id::text, 0));
  end if;
  if new.publish_status = 'publishing' and
     exists (select 1 from public.campaign_artifacts a
       join public.client_campaigns c on c.id = a.campaign_id
       where a.page_id = new.id and a.kind = 'landing_page'
         and c.acquisition_mode in ('organic', 'paid')) then
    raise exception 'V6 campaign page publishing requires exact-version human approval and its executor.';
  end if;
  return new;
end;
$$;
create trigger guard_v6_page_publishing
  before update of publish_status on public.client_pages
  for each row execute function public.guard_v6_page_publishing();
