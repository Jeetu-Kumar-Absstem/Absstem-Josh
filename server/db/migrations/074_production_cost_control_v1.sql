create table if not exists production_cost_profiles (
  company_id integer primary key references companies(id) on delete cascade,
  material_rate_basis text not null default 'latest_purchase_invoice',
  default_labor_hours_per_output numeric(18, 4) not null default 0,
  default_labor_hour_rate numeric(18, 4) not null default 0,
  default_overhead_rate_per_output numeric(18, 4) not null default 0,
  remarks text,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (material_rate_basis in ('latest_purchase_invoice', 'purchase_order_estimate')),
  check (default_labor_hours_per_output >= 0),
  check (default_labor_hour_rate >= 0),
  check (default_overhead_rate_per_output >= 0)
);

insert into production_cost_profiles (company_id)
select c.id
from companies c
on conflict (company_id) do nothing;

alter table job_cards
  add column if not exists actual_labor_hours numeric(18, 4) not null default 0,
  add column if not exists labor_hour_rate numeric(18, 4) not null default 0,
  add column if not exists overhead_absorption_amount numeric(18, 2) not null default 0;

alter table job_cards drop constraint if exists job_cards_actual_labor_hours_check;
alter table job_cards
  add constraint job_cards_actual_labor_hours_check
  check (actual_labor_hours >= 0);

alter table job_cards drop constraint if exists job_cards_labor_hour_rate_check;
alter table job_cards
  add constraint job_cards_labor_hour_rate_check
  check (labor_hour_rate >= 0);

alter table job_cards drop constraint if exists job_cards_overhead_absorption_amount_check;
alter table job_cards
  add constraint job_cards_overhead_absorption_amount_check
  check (overhead_absorption_amount >= 0);
