create table if not exists offboarding_audits (
  id serial primary key,
  offboarded_user_id integer not null references erp_users(id) on delete restrict,
  replacement_user_id integer not null references erp_users(id) on delete restrict,
  performed_by integer not null references erp_users(id) on delete restrict,
  include_closed boolean not null default false,
  reassign_reportees boolean not null default true,
  scopes jsonb not null default '{}'::jsonb,
  before_counts jsonb not null default '{}'::jsonb,
  after_counts jsonb not null default '{}'::jsonb,
  moved_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_offboarding_audits_created_at on offboarding_audits(created_at);
create index if not exists idx_offboarding_audits_offboarded_user_id on offboarding_audits(offboarded_user_id);
create index if not exists idx_offboarding_audits_replacement_user_id on offboarding_audits(replacement_user_id);
create index if not exists idx_offboarding_audits_performed_by on offboarding_audits(performed_by);
