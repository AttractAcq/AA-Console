-- Public proof access is capability-scoped. Raw tokens are never readable by console clients.
create table public.proof_capture_links (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id) on delete cascade,
 config_id uuid not null references public.proof_capture_configs(id) on delete cascade,
 token_hash text not null unique, expires_at timestamptz not null, revoked_at timestamptz,
 max_submissions int not null default 1 check(max_submissions between 1 and 100), submissions int not null default 0,
 created_by uuid references public.profiles(id), created_at timestamptz not null default now()
);
create table public.proof_capture_submissions (
 id uuid primary key, client_id uuid not null references public.clients(id) on delete cascade,
 link_id uuid not null references public.proof_capture_links(id), proof_id uuid not null references public.client_proof_assets(id),
 submitted_name text not null, job_reference text, consent_text text not null, file_mime text,
 created_at timestamptz not null default now(), unique(link_id,id)
);
create table public.proof_request_deliveries (
 id uuid primary key, client_id uuid not null references public.clients(id) on delete cascade,
 config_id uuid not null references public.proof_capture_configs(id), link_id uuid not null references public.proof_capture_links(id),
 event_key text not null, recipient text not null, channel text not null check(channel in ('email','sms','whatsapp')),
 subject text not null, message text not null, capture_url text not null,
 template_sid text, template_variables jsonb,
 scheduled_at timestamptz not null default now(), approved_by uuid references public.profiles(id), approved_at timestamptz,
 status text not null default 'pending_approval' check(status in ('pending_approval','approved','sending','sent','failed','cancelled','uncertain')),
 attempts int not null default 0, lease_until timestamptz, provider_id text, error text,
 created_at timestamptz not null default now(), sent_at timestamptz, unique(client_id,event_key)
);
alter table public.client_proof_assets add column capture_file_mime text;

alter table public.proof_capture_links enable row level security;
alter table public.proof_capture_submissions enable row level security;
alter table public.proof_request_deliveries enable row level security;
-- Delivery URL contains a bearer capability: only admin/assigned manager can see it.
create policy proof_deliveries_read on public.proof_request_deliveries for select to authenticated
 using(public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
create policy proof_submissions_read on public.proof_capture_submissions for select to authenticated
 using(public.can_access_client(client_id));
grant select on public.proof_capture_submissions,public.proof_request_deliveries to authenticated;
grant all on public.proof_capture_links,public.proof_capture_submissions,public.proof_request_deliveries to service_role;

create function public.accept_proof_capture_submission(
 p_token_hash text,p_submission_id uuid,p_name text,p_job_reference text,p_body text,
 p_storage_path text,p_mime text,p_category text,p_kind text,p_consent text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare l public.proof_capture_links%rowtype; c public.proof_capture_configs%rowtype; existing uuid; pid uuid;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 select * into l from public.proof_capture_links where token_hash=p_token_hash for update;
 if not found or l.revoked_at is not null or l.expires_at<=now() then raise exception 'Capture link unavailable'; end if;
 select proof_id into existing from public.proof_capture_submissions where id=p_submission_id and link_id=l.id;
 if found then return existing; end if;
 if l.submissions>=l.max_submissions then raise exception 'Capture link unavailable'; end if;
 select * into c from public.proof_capture_configs where id=l.config_id and client_id=l.client_id;
 if not found then raise exception 'Capture link unavailable'; end if;
 if nullif(btrim(p_name),'') is null or length(p_name)>200 or nullif(btrim(p_body),'') is null or length(p_body)>20000
   or nullif(btrim(p_consent),'') is null or length(p_consent)>2000 then raise exception 'Name, evidence and permission confirmation required'; end if;
 if p_storage_path is not null and p_storage_path <> l.client_id::text||'/capture/'||l.id::text||'/'||p_submission_id::text then raise exception 'Invalid upload path'; end if;
 if p_storage_path is not null and not exists(select 1 from storage.objects where bucket_id='proof' and name=p_storage_path) then raise exception 'Upload missing'; end if;
 pid:=gen_random_uuid();
 insert into public.client_proof_assets(id,client_id,media_type,title,body,storage_path,source,usage_rights,permission_basis,capture_method,source_category,source_kind,capture_file_mime)
 values(pid,l.client_id,case when p_mime like 'image/%' then 'image'::public.media_type when p_mime like 'video/%' then 'video'::public.media_type else 'text'::public.media_type end,
 left(c.name||' · '||p_name,300),p_body,p_storage_path,p_name,'not_cleared',p_consent,c.method,p_category,p_kind,p_mime);
 insert into public.proof_capture_submissions(id,client_id,link_id,proof_id,submitted_name,job_reference,consent_text,file_mime)
 values(p_submission_id,l.client_id,l.id,pid,p_name,left(p_job_reference,500),p_consent,p_mime);
 update public.proof_capture_links set submissions=submissions+1 where id=l.id;
 return pid;
end $$;
revoke all on function public.accept_proof_capture_submission(text,uuid,text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.accept_proof_capture_submission(text,uuid,text,text,text,text,text,text,text,text) to service_role;

create function public.decide_proof_delivery(p_delivery_id uuid,p_approve boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries%rowtype;
begin
 select * into d from public.proof_request_deliveries where id=p_delivery_id for update;
 if not found or auth.role() is distinct from 'authenticated' or not(coalesce(public.is_admin(),false) or coalesce(auth.uid()=public.active_video_approval_manager(d.client_id),false)) then raise exception 'Not permitted'; end if;
 if d.status not in ('pending_approval','approved','failed') then raise exception 'This delivery can no longer be changed'; end if;
 update public.proof_request_deliveries set status=case when p_approve then 'approved' else 'cancelled' end,
 approved_by=case when p_approve then auth.uid() end,approved_at=case when p_approve then now() end,error=null where id=d.id;
end $$;
revoke all on function public.decide_proof_delivery(uuid,boolean) from public,anon;
grant execute on function public.decide_proof_delivery(uuid,boolean) to authenticated;

create function public.claim_proof_delivery() returns public.proof_request_deliveries
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 -- A crash after an external send must not cause an unconfirmed duplicate SMS.
 update public.proof_request_deliveries set status='uncertain',error='Delivery confirmation was interrupted; check provider history before sending again.' where status='sending' and lease_until<now();
 select * into d from public.proof_request_deliveries where status='approved' and approved_by is not null
 and scheduled_at<=now() order by scheduled_at for update skip locked limit 1;
 if not found then return null; end if;
 if not exists(select 1 from public.proof_capture_links where id=d.link_id and revoked_at is null and expires_at>now() and submissions<max_submissions) then
 update public.proof_request_deliveries set status='cancelled',error='Capture link expired, revoked or already completed.' where id=d.id; return null; end if;
 update public.proof_request_deliveries set status='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes' where id=d.id returning * into d;
 return d;
end $$;
revoke all on function public.claim_proof_delivery() from public,anon,authenticated;
grant execute on function public.claim_proof_delivery() to service_role;
