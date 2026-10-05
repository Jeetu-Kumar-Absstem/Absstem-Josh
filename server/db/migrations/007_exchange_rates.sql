create table if not exists exchange_rates (
  id serial primary key,
  from_currency_id integer not null references currencies(id),
  to_currency_id integer not null references currencies(id),
  rate_value numeric(18, 8) not null,
  rate_date date not null,
  source_type text not null default 'manual',
  entered_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  unique (from_currency_id, to_currency_id, rate_date, source_type),
  check (rate_value > 0)
);

create table if not exists exchange_rate_approvals (
  id serial primary key,
  exchange_rate_id integer not null references exchange_rates(id) on delete cascade,
  approval_status text not null default 'pending',
  approved_by integer references erp_users(id),
  approved_at timestamptz,
  remarks text
);

create index if not exists idx_exchange_rate_approvals_exchange_rate_id on exchange_rate_approvals(exchange_rate_id);

create table if not exists quote_currency_controls (
  id serial primary key,
  quote_revision_id integer not null unique references quote_revisions(id) on delete cascade,
  base_currency_id integer not null references currencies(id),
  quote_currency_id integer not null references currencies(id),
  approved_exchange_rate numeric(18, 8) not null,
  exchange_rate_id integer references exchange_rates(id),
  approved_by integer not null references erp_users(id),
  approved_at timestamptz not null,
  rate_source text not null default 'manual',
  override_reason text,
  check (approved_exchange_rate > 0)
);
