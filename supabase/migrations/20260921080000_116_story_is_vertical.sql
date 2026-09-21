-- A story is vertical.
--
-- Portrait is already the default everywhere, so the common case has always
-- been right — which is exactly why this is worth writing down. A default is
-- a rule nobody has to follow: Approve & Build offers Landscape beside
-- Portrait, and a landscape story is not a story. It is the same shape of
-- hole migration 112 closed for the video carousel: a constraint that existed
-- only in the shape of a default value.
--
-- A trigger rather than an argument check in build_brief_with_ai and
-- regenerate_asset. Two reasons. It covers every path that can ever queue a
-- render, including ones not written yet; and rewriting two working function
-- bodies to add one condition is how nine behaviours went missing from
-- save_campaign_plan_with_ideas.
--
-- Carousels are deliberately not constrained. A carousel is legitimately
-- square or portrait depending on the channel; only a story has one answer.
--
-- Nothing on file is a story, so no row needs fixing first.

create or replace function size_fits_format(p_format content_format, p_size text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case when p_format = 'story' then p_size = '1024x1536' else true end;
$$;

comment on function size_fits_format(content_format, text) is
  'Whether a render size can carry a content format. A story is full-screen vertical and has only one answer; everything else is free to be any supported size.';

create or replace function assert_render_size_fits_format()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_format content_format;
begin
  -- The brief is the authority on shape. A render with no brief behind it is
  -- not a story and is left alone.
  --
  -- Branched on the table because the two carry the brief differently, and
  -- a record field that does not exist on the row being written raises at
  -- execution. plpgsql resolves those lazily, so the untaken branch is never
  -- looked at.
  if tg_table_name = 'creative_generations' then
    select content_format into v_format from client_briefs where id = new.brief_id;
  else
    select b.content_format into v_format
      from creative_generations g
      join client_briefs b on b.id = g.brief_id
     where g.id = new.generation_id;
  end if;

  if v_format is not null and not size_fits_format(v_format, new.size) then
    raise exception 'A story is full-screen vertical. % cannot be rendered at %.', v_format, new.size;
  end if;
  return new;
end;
$$;

create trigger cg_size_fits_format
  before insert or update of size on creative_generations
  for each row execute function assert_render_size_fits_format();

create trigger cr_size_fits_format
  before insert or update of size on creative_renders
  for each row execute function assert_render_size_fits_format();

comment on function assert_render_size_fits_format() is
  'Refuses a story queued at anything but portrait, on every path that can queue one. Reads the shape off the brief, which is where it is decided.';
