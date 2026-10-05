-- 166: Commercial & Sales Order Pipeline (Phase 6: CRM, Quote-to-Order & Dispatch)

-- Ensure customers table has all required CRM & statutory columns
alter table customers
  add column if not exists company_id bigint references companies(id) on delete cascade,
  add column if not exists pan_no text,
  add column if not exists billing_address text,
  add column if not exists shipping_address text,
  add column if not exists credit_limit numeric(14, 2) not null default 0,
  add column if not exists credit_days integer not null default 0,
  add column if not exists payment_terms text;

create index if not exists idx_customers_company_active
  on customers (company_id, is_active);

-- Commercial Sales Pipeline Deals (leads & commercial negotiations)
create table if not exists sales_pipelines (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  deal_code text not null,
  title text not null,
  customer_id integer references customers(id) on delete set null,
  lead_id integer references leads(id) on delete set null,
  assigned_to bigint references erp_users(id) on delete set null,
  stage text not null default 'inquiry',
  expected_value numeric(14, 2) not null default 0,
  currency text not null default 'INR',
  probability_pct integer not null default 20,
  target_closing_date date,
  actual_closing_date date,
  quote_id integer references quote_headers(id) on delete set null,
  sales_order_id integer references sales_orders(id) on delete set null,
  loss_reason text,
  competitor_name text,
  remarks text,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_pipelines_stage_check check (
    stage in ('inquiry', 'quoted', 'negotiation', 'won', 'lost')
  ),
  constraint sales_pipelines_probability_check check (
    probability_pct >= 0 and probability_pct <= 100
  ),
  constraint sales_pipelines_code_unique unique (company_id, deal_code)
);

create index if not exists idx_sales_pipelines_company_stage
  on sales_pipelines (company_id, stage, target_closing_date);

create index if not exists idx_sales_pipelines_customer
  on sales_pipelines (customer_id);

-- Link sales_orders to quotes, customer POs, and manufacturing work orders
alter table sales_orders
  add column if not exists company_id bigint references companies(id) on delete cascade,
  add column if not exists quote_id integer references quote_headers(id) on delete set null,
  add column if not exists customer_po_number text,
  add column if not exists customer_po_date date,
  add column if not exists payment_terms text,
  add column if not exists delivery_schedule date,
  add column if not exists shipping_address text,
  add column if not exists billing_address text,
  add column if not exists work_order_id bigint references work_orders(id) on delete set null;

-- Link sales_order_lines to Master BOM and Finished Goods Product
alter table sales_order_lines
  add column if not exists manufacturing_bom_id bigint references manufacturing_boms(id) on delete set null,
  add column if not exists component_specification_id bigint references component_specifications(id) on delete set null,
  add column if not exists custom_specs jsonb,
  add column if not exists uom text;

-- Enhance dispatches table with tracking & inventory deduction linkage
alter table dispatches
  add column if not exists company_id bigint references companies(id) on delete cascade,
  add column if not exists work_order_id bigint references work_orders(id) on delete set null,
  add column if not exists dispatch_note_no text,
  add column if not exists carrier_name text,
  add column if not exists driver_contact text,
  add column if not exists total_packages integer default 1,
  add column if not exists gross_weight_kg numeric(10, 3) default 0,
  add column if not exists stock_deducted boolean not null default false;

-- Screen permissions for commercial_desk
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'commercial_desk', true, true, true, false, false, false
from roles r
where r.role_key in ('super_admin', 'sales_manager', 'sales_executive', 'commercial_head', 'operations_manager', 'plant_head', 'finance_manager')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true;
