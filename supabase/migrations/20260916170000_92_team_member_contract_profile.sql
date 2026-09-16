-- Structured contract-ready profile on team_members.
--
-- Add Information on Editors and Avatars (and SMM, same overview) used to be
-- two free-text blobs: personal_info and contact_info. Contracts need named
-- fields — given/family name, email, phone, a postal address, company and a
-- tax identifier — not a paragraph an operator has to re-parse.
--
-- The original columns stay. Existing text is not wiped; it is copied into
-- the new columns where we can do so without guessing (email at minimum)
-- and any remainder is kept on profile_notes so nothing on file disappears.

alter table team_members
  add column if not exists given_name text,
  add column if not exists family_name text,
  add column if not exists preferred_name text,
  add column if not exists legal_name text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists address_city text,
  add column if not exists address_region text,
  add column if not exists address_postal_code text,
  add column if not exists address_country text,
  add column if not exists company_name text,
  add column if not exists tax_id text,
  add column if not exists profile_notes text;

comment on column team_members.given_name is
  'First / given name for contracts and correspondence.';
comment on column team_members.family_name is
  'Surname / family name for contracts and correspondence.';
comment on column team_members.preferred_name is
  'The name they go by, when it differs from given_name.';
comment on column team_members.legal_name is
  'Full legal name as it should appear on a contract, when that is not given + family.';
comment on column team_members.email is
  'Contact email for this team member. Independent of their console login.';
comment on column team_members.phone is
  'Contact phone, ideally with country code.';
comment on column team_members.address_line1 is
  'Street address line 1.';
comment on column team_members.address_line2 is
  'Street address line 2 (apartment, suite, building).';
comment on column team_members.address_city is
  'City / town.';
comment on column team_members.address_region is
  'Region / state / province.';
comment on column team_members.address_postal_code is
  'Postal / ZIP code.';
comment on column team_members.address_country is
  'Country, written in full.';
comment on column team_members.company_name is
  'Company through which they invoice, when not in a personal name.';
comment on column team_members.tax_id is
  'VAT, GST, or other tax identifier used on invoices.';
comment on column team_members.profile_notes is
  'Anything that does not fit a named field, including leftover free-text from personal_info / contact_info.';
comment on column team_members.personal_info is
  'Legacy free-text personal notes. Kept for compatibility; new writes go to the structured columns.';
comment on column team_members.contact_info is
  'Legacy free-text contact notes. Kept for compatibility; new writes go to the structured columns.';

-- Best-effort copy of existing blobs. Never overwrites a structured value
-- that is already set, and never nulls personal_info / contact_info.
do $$
declare
  r record;
  v_email text;
  v_phone text;
  v_given text;
  v_family text;
  v_personal_rest text;
  v_contact_rest text;
  v_notes text;
  v_blob text;
  v_words text[];
  v_phone_cand text;
begin
  for r in
    select id, personal_info, contact_info, email, phone, given_name, family_name, profile_notes
      from team_members
     where personal_info is not null or contact_info is not null
  loop
    v_email := r.email;
    v_phone := r.phone;
    v_given := r.given_name;
    v_family := r.family_name;
    v_personal_rest := coalesce(r.personal_info, '');
    v_contact_rest := coalesce(r.contact_info, '');

    if v_email is null then
      v_email := substring(v_contact_rest from '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}');
      if v_email is null then
        v_email := substring(v_personal_rest from '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}');
        if v_email is not null then
          v_personal_rest := trim(both from regexp_replace(v_personal_rest, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '', ''));
        end if;
      else
        v_contact_rest := trim(both from regexp_replace(v_contact_rest, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', '', ''));
      end if;
    end if;

    if v_phone is null then
      v_phone_cand := substring(v_contact_rest from '(\+|00)?[0-9][0-9 ()\.\-]{5,18}[0-9]');
      if v_phone_cand is not null
         and length(regexp_replace(v_phone_cand, '[^0-9]', '', 'g')) >= 7 then
        v_phone := trim(both from v_phone_cand);
        v_contact_rest := trim(both from replace(v_contact_rest, v_phone_cand, ''));
      end if;
    end if;

    -- A short, single-line, letter-ish personal_info is almost certainly a name.
    v_blob := trim(both from v_personal_rest);
    if v_given is null
       and v_blob <> ''
       and v_blob !~ E'[\n@0-9]'
       and char_length(v_blob) <= 80 then
      v_words := regexp_split_to_array(v_blob, E'\\s+');
      if array_length(v_words, 1) between 1 and 4 then
        v_given := v_words[1];
        if array_length(v_words, 1) > 1 then
          v_family := array_to_string(v_words[2:array_length(v_words, 1)], ' ');
        end if;
        v_personal_rest := '';
      end if;
    end if;

    v_personal_rest := trim(both from regexp_replace(v_personal_rest, E'[\\n\\r]+', E'\n', 'g'));
    v_contact_rest := trim(both from regexp_replace(v_contact_rest, E'[\\n\\r]+', E'\n', 'g'));
    v_notes := r.profile_notes;
    if v_notes is null then
      v_notes := nullif(trim(both from concat_ws(E'\n\n',
        nullif(v_personal_rest, ''),
        nullif(v_contact_rest, '')
      )), '');
    end if;

    update team_members
       set email = coalesce(email, v_email),
           phone = coalesce(phone, v_phone),
           given_name = coalesce(given_name, v_given),
           family_name = coalesce(family_name, v_family),
           profile_notes = coalesce(profile_notes, v_notes)
     where id = r.id;
  end loop;
end $$;
