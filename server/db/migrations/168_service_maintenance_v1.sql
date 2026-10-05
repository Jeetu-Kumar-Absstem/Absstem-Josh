-- 168: Service, Field Maintenance & Serialized Equipment Management (Phase 8)

-- 1. Installed Equipment / Serialized Assets
create table if not exists installed_equipment (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  serial_number text not null,
  product_id integer references products(id) on delete restrict,
  item_code text not null,
  item_name text not null,
  customer_id integer not null references customers(id) on delete restrict,
  sales_order_id integer references sales_orders(id) on delete set null,
  dispatch_id bigint references dispatches(id) on delete set null,
  work_order_id bigint references work_orders(id) on delete set null,
  manufacturing_bom_id bigint references manufacturing_boms(id) on delete set null,
  site_location text,
  site_address text,
  commissioning_date date,
  warranty_start_date date,
  warranty_end_date date,
  equipment_status text not null default 'operational', -- 'operational', 'under_maintenance', 'breakdown', 'decommissioned'
  notes text,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint installed_equipment_status_check check (
    equipment_status in ('operational', 'under_maintenance', 'breakdown', 'decommissioned')
  ),
  constraint installed_equipment_serial_unique unique (company_id, serial_number)
);

create index if not exists idx_installed_equipment_customer
  on installed_equipment(company_id, customer_id, equipment_status);

create index if not exists idx_installed_equipment_serial
  on installed_equipment(serial_number);

-- 2. Enhance amc_contracts for multi-asset link, value & renewal status
alter table amc_contracts
  add column if not exists company_id bigint references companies(id) on delete cascade,
  add column if not exists installed_equipment_id bigint references installed_equipment(id) on delete set null,
  add column if not exists contract_value numeric(14, 2) not null default 0,
  add column if not exists billing_frequency text default 'annual',
  add column if not exists renewal_status text default 'active';

alter table amc_contracts
  drop constraint if exists amc_contracts_contract_status_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'amc_contracts_contract_status_chk_v2'
  ) then
    alter table amc_contracts
      add constraint amc_contracts_contract_status_chk_v2
      check (contract_status in ('draft', 'active', 'expired', 'pending_renewal', 'closed', 'cancelled'));
  end if;
end $$;

-- 3. Enhance service_tickets to link installed_equipment directly and ensure priority/status support
alter table service_tickets
  add column if not exists installed_equipment_id bigint references installed_equipment(id) on delete set null,
  add column if not exists amc_contract_id integer references amc_contracts(id) on delete set null,
  add column if not exists resolution_notes text,
  add column if not exists is_under_warranty boolean not null default false,
  add column if not exists is_under_amc boolean not null default false,
  add column if not exists parts_cost_total numeric(14, 2) not null default 0;

-- 4. Service Ticket Parts Consumed (Spare Parts Issuance & Inventory Deduction)
create table if not exists service_ticket_parts (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  service_ticket_id bigint not null references service_tickets(id) on delete cascade,
  product_id integer not null references products(id) on delete restrict,
  item_code text not null,
  item_name text not null,
  uom text not null default 'NOS',
  qty_issued numeric(14, 4) not null default 1,
  unit_cost numeric(14, 4) not null default 0,
  total_cost numeric(14, 2) not null default 0,
  stock_deducted boolean not null default false,
  gl_entry_id bigint references general_ledger_entries(id) on delete set null,
  issued_by bigint references erp_users(id) on delete set null,
  issued_at timestamptz not null default now(),
  constraint service_ticket_parts_qty_positive check (qty_issued > 0)
);

create index if not exists idx_service_ticket_parts_ticket
  on service_ticket_parts(service_ticket_id);

-- 5. Screen Permissions for service_desk
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'service_desk', true, true, true, false, false, false
from roles r
where r.role_key in ('super_admin', 'service_manager', 'service_engineer', 'field_technician', 'cfo', 'commercial_head')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true;
