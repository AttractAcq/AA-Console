-- Ideation can now be confined to one content pillar, the same way it can be
-- seeded from one proof item. The idea bank records which, and 'pillar' was
-- not one of the three values it could say.
--
-- ALTER TYPE ... ADD VALUE only. The new value is not used anywhere in this
-- migration, which is what makes it safe inside a transaction: Postgres
-- refuses to USE a value added in the same transaction, not to add one.

alter type idea_source add value if not exists 'pillar';
