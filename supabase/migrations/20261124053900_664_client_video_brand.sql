-- V0: store optional, client-specific motion-graphics brand settings alongside
-- the existing admin-owned visual profile. Existing colours/fonts remain the
-- base for video; null overrides use the recorded AA defaults.
alter table public.client_brand_profiles
  add column video_tokens jsonb,
  add column narrator_voice_id text,
  add column video_rulebook_notes text;

alter table public.client_brand_profiles
  add constraint client_video_tokens_object_check
    check (video_tokens is null or jsonb_typeof(video_tokens) = 'object'),
  add constraint client_video_voice_id_length_check
    check (narrator_voice_id is null or length(narrator_voice_id) <= 128),
  add constraint client_video_rulebook_notes_length_check
    check (video_rulebook_notes is null or length(video_rulebook_notes) <= 4000);

comment on column public.client_brand_profiles.video_tokens is
  'Optional, validated motion-graphics token overrides. Exact shape: video-render/src/brand/tokens.ts. Null uses the client base profile and AA defaults.';
comment on column public.client_brand_profiles.narrator_voice_id is
  'Selected ElevenLabs narrator voice ID for later audio production; null means the brand default. This does not enable audio generation.';
comment on column public.client_brand_profiles.video_rulebook_notes is
  'Client-specific additions to the reviewed video visual grammar. Generated scenes remain subject to the global rulebook.';
