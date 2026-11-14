-- A held recruitment Meta request still needs to become stale when selected
-- media bytes or their current signoff change after campaign creation.
begin;
create or replace function public.recruitment_meta_build_snapshot_v6(p_campaign_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
  select jsonb_build_object(
    'campaign', jsonb_build_object(
      'id',c.id,'client_id',c.client_id,'name',c.name,
      'daily_budget',c.daily_budget,'target_countries',c.target_countries,
      'conversion_event',c.conversion_event,
      'meta_campaign_id',c.meta_campaign_id,
      'meta_ad_set_id',c.meta_ad_set_id,'meta_built_at',c.meta_built_at),
    'integrations',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',i.id,'status',i.status,'ad_account_id',i.ad_account_id,
        'meta_page_id',i.meta_page_id,'meta_pixel_id',i.meta_pixel_id,
        'credential_label',i.credential_label,
        'credential_secret_id',i.credential_secret_id) order by i.id),'[]'::jsonb)
      from public.client_integrations i
      where i.client_id=c.client_id and i.provider='meta'),
    'selected_ads',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'selection',jsonb_build_object(
          'asset_id',s.asset_id,'meta_image_hash',s.meta_image_hash,
          'meta_creative_id',s.meta_creative_id,'meta_ad_id',s.meta_ad_id),
        'media',jsonb_build_object(
          'id',a.id,'client_id',a.client_id,'brief_id',a.brief_id,
          'title',a.title,'media_type',a.media_type,
          'content_format',a.content_format,
          'storage_path',a.storage_path,'review_status',a.review_status,
          'human_approved_at',a.human_approved_at,
          'delivery_bytes_sha256',a.delivery_bytes_sha256,
          'current_inbox_signoff',public.ordinary_media_signoff_current_v6(a.id),
          'archived_at',a.archived_at,'purpose',a.purpose,
          'usage_rights',a.usage_rights),
        'storage',jsonb_build_object(
          'bucket','client-media','object_id',o.id,
          'version',o.version,'updated_at',o.updated_at),
        'brief',jsonb_build_object(
          'id',b.id,'client_id',b.client_id,'purpose',b.purpose,
          'status',b.status,'archived_at',b.archived_at,
          'current_inbox_signoff',public.recruitment_brief_signoff_current_v6(b.id),
          'hook',b.hook,'script',b.script,
          'compensation_text',b.compensation_text,
          'apply_url',b.apply_url,'call_to_action',b.call_to_action)
      ) order by s.asset_id),'[]'::jsonb)
      from public.recruitment_meta_campaign_ads s
      left join public.client_media_assets a on a.id=s.asset_id
      left join public.client_briefs b on b.id=a.brief_id
      left join storage.objects o on o.bucket_id='client-media'
        and o.name=a.storage_path
      where s.campaign_id=c.id)
  ) from public.recruitment_meta_campaigns c where c.id=p_campaign_id;
$$;
revoke all on function public.recruitment_meta_build_snapshot_v6(uuid)
  from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
