alter table customers
  add column if not exists credit_limit numeric(14, 2),
  add column if not exists credit_control_mode text not null default 'warning',
  add column if not exists is_credit_hold boolean not null default false,
  add column if not exists credit_hold_reason text;

alter table customers
  drop constraint if exists customers_credit_control_mode_check;

alter table customers
  add constraint customers_credit_control_mode_check
  check (credit_control_mode in ('warning', 'soft_block', 'hard_block'));

create table if not exists customer_credit_releases (
  id serial primary key,
  company_id integer references companies(id) on delete restrict,
  distributor_id integer references distributors(id) on delete restrict,
  customer_id integer not null references customers(id) on delete restrict,
  release_status text not null default 'requested',
  requested_exposure numeric(14, 2) not null default 0,
  approved_upto_amount numeric(14, 2),
  expires_on date not null,
  reason text not null,
  remarks text,
  requested_by integer references erp_users(id),
  approved_by integer references erp_users(id),
  approved_at timestamptz,
  rejected_by integer references erp_users(id),
  rejected_at timestamptz,
  cancelled_by integer references erp_users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (release_status in ('requested', 'approved', 'rejected', 'cancelled')),
  check (approved_upto_amount is null or approved_upto_amount >= 0),
  check (requested_exposure >= 0)
);

create index if not exists idx_customer_credit_releases_customer_id
on customer_credit_releases(customer_id);

create index if not exists idx_customer_credit_releases_company_id
on customer_credit_releases(company_id);

create index if not exists idx_customer_credit_releases_distributor_id
on customer_credit_releases(distributor_id);

create index if not exists idx_customer_credit_releases_status
on customer_credit_releases(release_status);
