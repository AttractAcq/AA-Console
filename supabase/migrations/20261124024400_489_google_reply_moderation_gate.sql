-- Matching bytes alone do not prove that Google approved a public reply.
begin;

create function public.guard_google_reply_confirmed_moderation_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
 if new.status='confirmed' and old.status is distinct from 'confirmed'
  and (new.provider_state is distinct from 'APPROVED'
   or new.observed_body_hash is distinct from new.body_hash) then
  raise exception 'A Google reply cannot be confirmed before approved moderation and exact readback.'
   using errcode='23514';
 end if;
 return new;
end $$;

create trigger google_reply_confirmed_moderation_v6
before update on public.google_reply_execution_attempts_v6
for each row execute function public.guard_google_reply_confirmed_moderation_v6();

revoke all on function public.guard_google_reply_confirmed_moderation_v6()
 from public,anon,authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (21,7,'google_review_reply','Google review reply',
 'verified','278 exact reply preview and AAL2 source decision',
 'verified','458 owner-requested sender; 486 owner-requested read-only check',
 'blocked','457 one-shot attempt; 485 later observation; 488 APPROVED moderation gate',
 'Audit historical approvals and posted replies, verify live account/scope and obtain an authorized provider receipt.');

select public.lock_down_definer_functions();
commit;
