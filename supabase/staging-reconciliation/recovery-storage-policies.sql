-- Disposable-hosted restore supplement for captured staging Storage policies.
-- Source capture: 2026-11-17T12:52:19.675Z, ref vmmertwoboqiazcsougw.
-- Never apply to live staging. Verify capture freshness before a hosted restore.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $policies$
DECLARE
  targets jsonb := '[{"policyname":"contracts_obj_admin_all","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"ALL","qual":"((bucket_id = ''contracts''::text) AND is_admin())","with_check":"((bucket_id = ''contracts''::text) AND is_admin())"},{"policyname":"contracts_obj_client_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''contracts''::text) AND (EXISTS ( SELECT 1\n   FROM client_users cu\n  WHERE ((cu.user_id = auth.uid()) AND (cu.client_id = try_uuid((storage.foldername(objects.name))[1]))))))","with_check":null},{"policyname":"media_obj_admin_all","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"ALL","qual":"((bucket_id = ''client-media''::text) AND is_admin())","with_check":"((bucket_id = ''client-media''::text) AND is_admin())"},{"policyname":"media_obj_assigned_edit_source_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''client-media''::text) AND (EXISTS ( SELECT 1\n   FROM (client_media_assets a\n     JOIN job_assignments j ON ((j.source_asset_id = a.id)))\n  WHERE ((a.storage_path = objects.name) AND is_member(j.member_id)))))","with_check":null},{"policyname":"media_obj_client_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''client-media''::text) AND (EXISTS ( SELECT 1\n   FROM client_users cu\n  WHERE ((cu.user_id = auth.uid()) AND (cu.client_id = try_uuid((storage.foldername(objects.name))[1]))))))","with_check":null},{"policyname":"media_obj_employee_insert","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"INSERT","qual":null,"with_check":"((bucket_id = ''client-media''::text) AND can_access_client(try_uuid((storage.foldername(name))[1])))"},{"policyname":"media_obj_employee_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''client-media''::text) AND (owner = auth.uid()))","with_check":null},{"policyname":"media_obj_smm_own_delete","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"DELETE","qual":"((bucket_id = ''client-media''::text) AND (owner = auth.uid()) AND (auth.uid() = active_video_approval_manager(try_uuid((storage.foldername(name))[1]))) AND (name ~ ''^[0-9a-f-]{36}/[0-9a-f-]{36}[.](mp4|mov|m4v|webm)$''::text) AND (NOT (EXISTS ( SELECT 1\n   FROM client_media_assets a\n  WHERE (a.storage_path = objects.name)))))","with_check":null},{"policyname":"media_obj_smm_video_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''client-media''::text) AND (auth.uid() = active_video_approval_manager(try_uuid((storage.foldername(name))[1]))))","with_check":null},{"policyname":"proof_obj_admin_all","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"ALL","qual":"((bucket_id = ''proof''::text) AND is_admin())","with_check":"((bucket_id = ''proof''::text) AND is_admin())"},{"policyname":"proof_obj_client_insert","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"INSERT","qual":null,"with_check":"((bucket_id = ''proof''::text) AND can_access_client(try_uuid((storage.foldername(name))[1])))"},{"policyname":"proof_obj_client_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''proof''::text) AND can_access_client(try_uuid((storage.foldername(name))[1])))","with_check":null},{"policyname":"sops_obj_admin_all","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"ALL","qual":"((bucket_id = ''sops''::text) AND is_admin())","with_check":"((bucket_id = ''sops''::text) AND is_admin())"},{"policyname":"sops_obj_staff_read","permissive":"PERMISSIVE","roles":"{authenticated}","cmd":"SELECT","qual":"((bucket_id = ''sops''::text) AND (current_role_of() = ANY (ARRAY[''admin''::app_role, ''employee''::app_role])))","with_check":null}]'::jsonb;
  p record;
  actual record;
  roles_sql text;
  create_sql text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) THEN
    RAISE EXCEPTION 'storage.objects RLS must be enabled before policy restore';
  END IF;
  FOR p IN SELECT * FROM jsonb_to_recordset(targets) AS x(
    policyname text, permissive text, roles text, cmd text, qual text, with_check text) LOOP
    SELECT q.permissive,q.roles::text AS roles,q.cmd,q.qual,q.with_check INTO actual
      FROM pg_policies q WHERE q.schemaname='storage' AND q.tablename='objects' AND q.policyname=p.policyname;
    IF FOUND THEN
      IF actual.permissive IS DISTINCT FROM p.permissive OR actual.roles IS DISTINCT FROM p.roles
         OR actual.cmd IS DISTINCT FROM p.cmd OR actual.qual IS DISTINCT FROM p.qual
         OR actual.with_check IS DISTINCT FROM p.with_check THEN
        RAISE EXCEPTION 'Existing Storage policy differs: %',p.policyname;
      END IF;
      CONTINUE;
    END IF;
    roles_sql := (SELECT string_agg(format('%I',role_name),', ') FROM unnest(string_to_array(trim(both '{}' from p.roles),',')) AS role_name);
    create_sql := format('CREATE POLICY %I ON storage.objects AS %s FOR %s TO %s',p.policyname,p.permissive,p.cmd,roles_sql);
    IF p.qual IS NOT NULL THEN create_sql:=create_sql||format(' USING (%s)',p.qual); END IF;
    IF p.with_check IS NOT NULL THEN create_sql:=create_sql||format(' WITH CHECK (%s)',p.with_check); END IF;
    EXECUTE create_sql;
  END LOOP;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
        AND policyname IN (SELECT x.policyname FROM jsonb_to_recordset(targets) AS x(policyname text)))<>14 THEN
    RAISE EXCEPTION 'Storage policy restore count differs';
  END IF;
END
$policies$;
COMMIT;
