-- Enum additions must commit before any migration uses the new values.
alter type lead_stage add value if not exists 'profile_visit';
alter type lead_stage add value if not exists 'follower';
alter type lead_stage add value if not exists 'qualified';
