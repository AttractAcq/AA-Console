-- Deleting a recruitment ad, and everything that was made for it.
--
-- There was no way to remove one. A brief that turned out wrong, or a run made
-- while testing, stayed in the list for good — and the Recruitment tab is a
-- short list where three dead entries are most of what you see.
--
-- A plain delete of the brief is not enough. client_media_assets.brief_id is
-- ON DELETE SET NULL, so the generated image would survive with nothing
-- pointing at it: still sitting in Asset review, still awaiting a decision,
-- now with no way to tell what it was for. Deleting the ad has to mean the
-- image too, which is why this is one function rather than a delete button.
--
-- Recruitment only. Client briefs are somebody's paid work with a campaign and
-- an approval trail attached; they are not deleted from a list, and nothing
-- here will touch one.

create or replace function delete_recruitment_ad(p_brief_id uuid)
returns table (deleted_assets integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief client_briefs;
  v_count integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can delete a recruitment ad.';
  end if;

  select * into v_brief from client_briefs where id = p_brief_id for update;
  if not found then
    raise exception 'That ad no longer exists.';
  end if;
  if v_brief.purpose <> 'recruitment' then
    raise exception 'That is not a recruitment ad.';
  end if;

  -- The images first, while the brief is still there to find them by.
  delete from client_media_assets where brief_id = p_brief_id;
  get diagnostics v_count = row_count;

  -- creative_generations and creative_renders cascade from the brief.
  delete from client_briefs where id = p_brief_id;

  deleted_assets := v_count;
  return next;
end;
$$;

revoke execute on function delete_recruitment_ad(uuid) from public, anon;
grant execute on function delete_recruitment_ad(uuid) to authenticated, service_role;

comment on function delete_recruitment_ad(uuid) is
  'Admin-only. Deletes a recruitment brief and the images generated for it, together. Refuses anything that is not purpose=recruitment.';
