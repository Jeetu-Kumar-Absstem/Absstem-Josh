alter table quote_revision_summaries
  add column if not exists configurator_context jsonb not null default '{}'::jsonb;
