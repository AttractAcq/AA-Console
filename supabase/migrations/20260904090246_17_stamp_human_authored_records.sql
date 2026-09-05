-- ============================================================
-- AA Console · 17 · Attribute human-authored records correctly
--
-- mark_record_edited only fired on UPDATE, so a record created by typing
-- into an empty card was indistinguishable from agent output. The worker
-- writes with the service role (auth.uid() is null) and a person writes
-- through the API (auth.uid() is set), which is a clean discriminator.
-- ============================================================

create or replace function mark_record_edited()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.body is not null and auth.uid() is not null then
      new.edited_by = auth.uid();
      new.edited_at = now();
    end if;
    return new;
  end if;

  if new.body is distinct from old.body and auth.uid() is not null then
    new.edited_by = auth.uid();
    new.edited_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists car_mark_edited on client_agent_records;
create trigger car_mark_edited before insert or update on client_agent_records
  for each row execute function mark_record_edited();

-- correct the row already written through the UI
update client_agent_records
   set edited_at = coalesce(edited_at, updated_at)
 where body is not null and edited_at is null and job_id is null;;
