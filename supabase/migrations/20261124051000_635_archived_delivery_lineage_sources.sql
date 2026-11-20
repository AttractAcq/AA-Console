-- Preserve the source fingerprints behind already-recorded lineage links
-- when a lead and its outcome events move into the Archive. The active row
-- wins if an archive snapshot overlaps during a transition.
begin;
create or replace view public.delivery_source_catalog_v6
with (security_invoker=true) as
WITH current_or_archived_leads AS (
  SELECT l.* FROM public.client_leads l
  UNION ALL
  SELECT snapshot.*
  FROM public.archived_leads a
  CROSS JOIN LATERAL jsonb_populate_record(null::public.client_leads,a.lead) snapshot
  WHERE snapshot.id=a.id AND snapshot.client_id=a.client_id
    AND NOT EXISTS (SELECT 1 FROM public.client_leads live WHERE live.id=a.id)
), current_or_archived_events AS (
  SELECT e.* FROM public.lead_events e
  JOIN public.client_leads l ON l.id=e.lead_id AND l.client_id=e.client_id
  UNION ALL
  SELECT snapshot.*
  FROM public.archived_leads a
  CROSS JOIN LATERAL jsonb_populate_recordset(
    null::public.lead_events,
    CASE WHEN jsonb_typeof(a.events)='array' THEN a.events ELSE '[]'::jsonb END
  ) snapshot
  WHERE snapshot.lead_id=a.id AND snapshot.client_id=a.client_id
    AND snapshot.id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.client_leads live WHERE live.id=a.id)
)
 SELECT 'opportunity'::text AS entity_kind,
    o.id::text AS source_key,
    o.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to((to_jsonb(o.*) - ARRAY['updated_at'::text, 'status'::text, 'status_note'::text, 'archived_at'::text])::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM market_opportunities o
UNION ALL
 SELECT 'source_model'::text AS entity_kind,
    r.id::text AS source_key,
    r.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to((to_jsonb(r.*) - ARRAY['updated_at'::text, 'created_at'::text, 'job_id'::text])::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_agent_records r
UNION ALL
 SELECT 'offer'::text AS entity_kind,
    o.id::text AS source_key,
    o.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to(jsonb_build_object('service_name', o.service_name, 'latest_version', v.id, 'latest_hash', v.content_hash)::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM service_offers o
     LEFT JOIN LATERAL ( SELECT v_1.id,
            v_1.content_hash
           FROM service_offer_versions v_1
          WHERE v_1.offer_id = o.id AND v_1.client_id = o.client_id
          ORDER BY v_1.version DESC
         LIMIT 1) v ON true
UNION ALL
 SELECT 'offer_version'::text AS entity_kind,
    v.id::text AS source_key,
    v.client_id,
    NULL::uuid AS campaign_id,
    v.content_hash AS fingerprint
   FROM service_offer_versions v
UNION ALL
 SELECT 'campaign'::text AS entity_kind,
    c.id::text AS source_key,
    c.client_id,
    c.id AS campaign_id,
    encode(sha256(convert_to((campaign_plan_fingerprint(c.*) || ':'::text) || COALESCE(c.offer_version_id::text, ''::text), 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_campaigns c
UNION ALL
 SELECT 'route_package'::text AS entity_kind,
    p.id::text AS source_key,
    p.client_id,
    p.campaign_id,
    encode(sha256(convert_to((((p.plan_fingerprint || ':'::text) || p.route) || ':'::text) || COALESCE(p.paid_platform, ''::text), 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM campaign_route_packages_v6 p
UNION ALL
 SELECT 'content_asset'::text AS entity_kind,
    a.id::text AS source_key,
    a.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to((to_jsonb(a.*) - ARRAY['updated_at'::text, 'created_at'::text, 'review_status'::text, 'archived_at'::text, 'job_id'::text])::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_media_assets a
UNION ALL
 SELECT 'proof_source'::text AS entity_kind,
    p.id::text AS source_key,
    p.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to(jsonb_build_object('source', to_jsonb(p.*) - ARRAY['created_at'::text, 'updated_at'::text], 'usage_rights', p.usage_rights, 'expires_on', p.expires_on, 'permission_basis', p.permission_basis)::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_proof_assets p
UNION ALL
 SELECT 'proof_artifact'::text AS entity_kind,
    v.id::text AS source_key,
    v.client_id,
    NULL::uuid AS campaign_id,
    v.content_hash AS fingerprint
   FROM proof_artifact_versions v
UNION ALL
 SELECT 'destination'::text AS entity_kind,
    (d.client_id::text || ':'::text) || d.destination_key AS source_key,
    d.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to(jsonb_build_object('key', d.destination_key, 'enabled', d.enabled, 'account_ref', d.account_ref)::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_proof_destinations d
UNION ALL
 SELECT 'page'::text AS entity_kind,
    p.id::text AS source_key,
    p.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to((to_jsonb(p.*) - ARRAY['updated_at'::text, 'created_at'::text, 'status'::text, 'published_url'::text, 'job_id'::text, 'archived_at'::text])::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_pages p
UNION ALL
 SELECT 'magnet_version'::text AS entity_kind,
    v.id::text AS source_key,
    v.client_id,
    m.campaign_id,
    v.content_sha256 AS fingerprint
   FROM lead_magnet_versions v
     JOIN lead_magnets m ON m.id = v.magnet_id AND m.client_id = v.client_id
UNION ALL
 SELECT 'sales_agent'::text AS entity_kind,
    a.id::text AS source_key,
    a.client_id,
    NULL::uuid AS campaign_id,
    encode(sha256(convert_to((to_jsonb(a.*) - ARRAY['updated_at'::text, 'created_at'::text, 'status'::text, 'archived_at'::text, 'job_id'::text])::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM client_sales_agents a
UNION ALL
 SELECT 'approval'::text AS entity_kind,
    r.id::text AS source_key,
    r.client_id,
    NULL::uuid AS campaign_id,
    r.payload_hash AS fingerprint
   FROM approval_requests_v6 r
  WHERE r.client_id IS NOT NULL
UNION ALL
 SELECT 'distribution_attempt'::text AS entity_kind,
    x.id::text AS source_key,
    x.client_id,
    x.campaign_id,
    encode(sha256(convert_to(jsonb_build_object('approval_id', x.approval_id, 'version', x.artifact_version_hash, 'action', x.action_key, 'manifest_id', x.manifest_id)::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM campaign_action_executions x
UNION ALL
 SELECT 'lead'::text AS entity_kind,
    l.id::text AS source_key,
    l.client_id,
    l.source_client_campaign_id AS campaign_id,
    encode(sha256(convert_to(jsonb_build_object('id', l.id, 'source_client_campaign_id', l.source_client_campaign_id, 'source_post_id', l.source_post_id, 'source_click_id', l.source_click_id, 'source_utm', l.source_utm, 'consent_given_at', l.consent_given_at)::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM current_or_archived_leads l
UNION ALL
 SELECT 'outcome'::text AS entity_kind,
    e.id::text AS source_key,
    e.client_id,
    l.source_client_campaign_id AS campaign_id,
    encode(sha256(convert_to(jsonb_build_object('lead_id', e.lead_id, 'kind', e.kind, 'body', e.body, 'occurred_at', e.occurred_at)::text, 'UTF8'::name)), 'hex'::text) AS fingerprint
   FROM current_or_archived_events e
     JOIN current_or_archived_leads l ON l.id = e.lead_id AND l.client_id = e.client_id
  WHERE e.kind = 'outcome'::text
UNION ALL
 SELECT 'google_search_copy'::text AS entity_kind,
    g.id::text AS source_key,
    g.client_id,
    g.campaign_id,
    g.copy_hash AS fingerprint
   FROM campaign_google_search_copy_versions_v7 g;

comment on view public.delivery_source_catalog_v6 is
  'Service-only current source fingerprints for delivery lineage. Lead and outcome nodes use the active row or archived snapshot without changing their source key/fingerprint; immutable versions preserve prior observations.';
revoke all on public.delivery_source_catalog_v6 from public,anon,authenticated;
grant select on public.delivery_source_catalog_v6 to service_role;
commit;
