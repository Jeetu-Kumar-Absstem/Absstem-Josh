alter table quote_revisions
  add column if not exists merge_annexures boolean not null default true;

create table if not exists quote_revision_summaries (
  quote_revision_id integer primary key references quote_revisions(id) on delete cascade,
  executive_summary jsonb not null default '{}'::jsonb,
  scope_summary jsonb not null default '{}'::jsonb,
  is_locked boolean not null default false,
  locked_by integer references erp_users(id),
  locked_at timestamptz,
  updated_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_quote_revision_summaries_locked on quote_revision_summaries(is_locked);
