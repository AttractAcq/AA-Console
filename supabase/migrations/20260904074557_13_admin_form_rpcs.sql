-- ============================================================
-- AA Console · 13 · RPCs the forms need
-- Two forms cannot be a plain insert:
--   · Add Member optionally creates a login, which means auth.users
--   · Add Integration must put the credential in Vault, never a column
-- ============================================================

-- ---------- Add Avatar / Editor / SMM ----------
create or replace function admin_create_team_member(
  p_name       text,
  p_initials   text,
  p_category   team_category,
  p_engagement engagement_type default 'contractor',
  p_username   text default null,
  p_password   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid;
  v_member uuid;
begin
  if not is_admin() then
    raise exception 'Admins only';
  end if;

  -- A member with no login can never reach the Employee console, so the
  -- account is created here rather than as a separate follow-up step.
  if p_username is not null and length(trim(p_username)) > 0 then
    if p_password is null or length(p_password) < 3 then
      raise exception 'A username needs a password of at least 3 characters';
    end if;
    v_user := create_console_user(
      case when position('@' in p_username) > 0
           then lower(p_username)
           else lower(p_username) || '@attractacq.com' end,
      p_password, 'employee', p_name, p_category
    );
  end if;

  insert into team_members (user_id, category, name, initials, engagement)
  values (v_user, p_category, p_name, p_initials, p_engagement)
  on conflict (user_id) do update
    set category = excluded.category, name = excluded.name,
        initials = excluded.initials, engagement = excluded.engagement
  returning id into v_member;

  return v_member;
end;
$$;

-- ---------- Add Integration ----------
create or replace function admin_store_integration_credential(
  p_client_id    uuid,
  p_provider     text,
  p_label        text,
  p_secret       text,
  p_access_level text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret uuid;
  v_row    uuid;
begin
  if not is_admin() then
    raise exception 'Admins only';
  end if;

  -- The raw credential goes to Vault and nowhere else; the table only
  -- ever holds the reference.
  v_secret := vault.create_secret(
    p_secret,
    'integration:' || p_client_id::text || ':' || p_provider || ':' || coalesce(p_label, 'default'),
    'AA Console integration credential'
  );

  insert into client_integrations (client_id, provider, credential_label, credential_secret_id, access_level)
  values (p_client_id, p_provider, p_label, v_secret, p_access_level)
  on conflict (client_id, provider, credential_label) do update
    set credential_secret_id = excluded.credential_secret_id,
        access_level = excluded.access_level,
        updated_at = now()
  returning id into v_row;

  return v_row;
end;
$$;

revoke execute on function admin_create_team_member(text, text, team_category, engagement_type, text, text) from anon, public;
revoke execute on function admin_store_integration_credential(uuid, text, text, text, text) from anon, public;
grant  execute on function admin_create_team_member(text, text, team_category, engagement_type, text, text) to authenticated;
grant  execute on function admin_store_integration_credential(uuid, text, text, text, text) to authenticated;;
