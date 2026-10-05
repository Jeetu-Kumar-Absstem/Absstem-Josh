-- Phase 1: Commissioning gatekeeper — site readiness → dispatch; commission sign-off → warranty + milestone unlock

-- ---------------------------------------------------------------------------
-- 1) Site readiness checklists (dispatch blocked until Approved)
-- ---------------------------------------------------------------------------
create table if not exists site_readiness_checklists (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  customer_id integer not null references customers(id) on delete restrict,
  status text not null default 'Draft',
  electrical_ready boolean not null default false,
  civil_ready boolean not null default false,
  pneumatic_ready boolean not null default false,
  rejection_reason text,
  approved_by integer references erp_users(id) on delete set null,
  approved_at timestamptz,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_readiness_checklists_status_check
    check (status in ('Draft', 'Client_Submitted', 'Approved', 'Rejected')),
  constraint site_readiness_checklists_so_unique unique (sales_order_id)
);

create index if not exists site_readiness_checklists_company_status_idx
  on site_readiness_checklists (company_id, status);

create index if not exists site_readiness_checklists_customer_idx
  on site_readiness_checklists (customer_id);

-- ---------------------------------------------------------------------------
-- 2) Commissioning tickets (field completion + signed PDF via Drive registry)
-- ---------------------------------------------------------------------------
create table if not exists commissioning_tickets (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  customer_id integer not null references customers(id) on delete restrict,
  assigned_engineer_id integer references erp_users(id) on delete set null,
  scheduled_date date,
  status text not null default 'Pending',
  piping_infrastructure_status text,
  welding_finish_notes text,
  client_signoff_date date,
  drive_file_id bigint references drive_files(id) on delete set null,
  completed_at timestamptz,
  completed_by integer references erp_users(id) on delete set null,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commissioning_tickets_status_check
    check (status in ('Pending', 'In_Progress', 'Completed')),
  constraint commissioning_tickets_complete_requires_signoff
    check (
      status <> 'Completed'
      or (client_signoff_date is not null)
    )
);

create index if not exists commissioning_tickets_company_status_idx
  on commissioning_tickets (company_id, status);

create index if not exists commissioning_tickets_so_idx
  on commissioning_tickets (sales_order_id);

create index if not exists commissioning_tickets_engineer_idx
  on commissioning_tickets (assigned_engineer_id);

-- One active commissioning ticket per SO (completed history can accumulate if needed later;
-- for v1 enforce single open ticket via partial unique on non-completed is optional —
-- keep one row per SO for simplicity)
create unique index if not exists commissioning_tickets_so_unique
  on commissioning_tickets (sales_order_id);

-- ---------------------------------------------------------------------------
-- 3) Payment milestones: event-tied due types + locked billing status
-- ---------------------------------------------------------------------------
alter table payment_milestones
  add column if not exists unlocked_at timestamptz,
  add column if not exists unlocked_by integer references erp_users(id) on delete set null,
  add column if not exists unlock_event text;

do $$
begin
  -- Widen due_type semantics (was free text default 'date')
  if exists (
    select 1 from information_schema.columns
    where table_name = 'payment_milestones' and column_name = 'due_type'
  ) then
    update payment_milestones
    set due_type = 'date'
    where due_type is null or btrim(due_type) = '' or due_type not in ('date', 'dispatch', 'commissioning');
  end if;

  update payment_milestones
  set status = 'pending'
  where status is null
     or btrim(status) = ''
     or lower(status) not in ('locked', 'pending', 'ready_to_bill', 'billed', 'cancelled');
end $$;

alter table payment_milestones
  drop constraint if exists payment_milestones_due_type_check;

alter table payment_milestones
  add constraint payment_milestones_due_type_check
  check (due_type in ('date', 'dispatch', 'commissioning'));

-- Allow locked / ready_to_bill alongside existing pending/billed
alter table payment_milestones
  drop constraint if exists payment_milestones_status_check;

alter table payment_milestones
  add constraint payment_milestones_status_check
  check (status in ('locked', 'pending', 'ready_to_bill', 'billed', 'cancelled'));

-- Existing commissioning-named milestones: lock until sign-off (safe for already-billed)
update payment_milestones
set status = 'locked',
    due_type = 'commissioning'
where lower(coalesce(milestone_name, '')) ~ 'commission'
  and coalesce(status, 'pending') in ('pending')
  and coalesce(due_type, 'date') = 'date';

-- ---------------------------------------------------------------------------
-- 4) Screen permissions for field service desk
-- ---------------------------------------------------------------------------
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  sp.role_id,
  'field_service',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'service_tickets'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
