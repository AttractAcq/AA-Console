-- B005/B004: captured proof contains the submitter's name, job reference and
-- consent wording. A creative/job assignment makes can_access_client() true,
-- but it must not grant direct access to that personal evidence.
--
-- Keep the existing client-account path and the proof workflow's current SMM
-- seat. Resolve both profile role and active seat at read time so retirement,
-- assignment transfer and profile changes immediately remove access. The
-- public capture retry and scheduled workers use service_role, whose table
-- grant and RLS bypass remain intact.
drop policy if exists proof_submissions_read on public.proof_capture_submissions;
create policy proof_submissions_read on public.proof_capture_submissions
  for select to authenticated using (
    coalesce(public.is_admin(), false)
    or (
      public.current_role_of() = 'client'::public.app_role
      and coalesce(public.is_client_user(client_id), false)
    )
    or (
      public.current_role_of() = 'employee'::public.app_role
      and coalesce(auth.uid() = public.active_video_approval_manager(client_id), false)
    )
  );

revoke all on public.proof_capture_submissions from public, anon;
grant select on public.proof_capture_submissions to authenticated;
grant all on public.proof_capture_submissions to service_role;
