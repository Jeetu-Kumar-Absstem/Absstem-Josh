-- 170: MRP II & Automated Purchase Planning Engine (Phase 10)

-- 1. MRP Planning Parameters (Safety Stock, Reorder Point, Lead Times)
create table if not exists mrp_planning_parameters (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  product_id integer references products(id) on delete cascade,
  component_specification_id bigint references component_specifications(id) on delete set null,
  item_code text not null,
  item_name text not null,
  uom text not null default 'NOS',
  safety_stock numeric(14, 4) not null default 0,
  reorder_point numeric(14, 4) not null default 0,
  reorder_qty numeric(14, 4) not null default 0,
  lead_time_days integer not null default 7,
  preferred_vendor_id integer references vendors(id) on delete set null,
  auto_reorder boolean not null default true,
  notes text,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mrp_parameters_safety_stock_non_neg check (safety_stock >= 0),
  constraint mrp_parameters_reorder_point_non_neg check (reorder_point >= 0),
  constraint mrp_parameters_lead_time_non_neg check (lead_time_days >= 0),
  constraint mrp_parameters_code_unique unique (company_id, item_code)
);

create index if not exists idx_mrp_planning_parameters_company
  on mrp_planning_parameters(company_id, auto_reorder);

-- 2. Enhance purchase_requisitions with company, vendor linkage & MRP flags
alter table purchase_requisitions
  add column if not exists company_id bigint references companies(id) on delete cascade,
  add column if not exists vendor_id integer references vendors(id) on delete set null,
  add column if not exists mrp_generated boolean not null default false,
  add column if not exists po_converted_id integer references purchase_orders(id) on delete set null;

create index if not exists idx_purchase_requisitions_company_status
  on purchase_requisitions(company_id, requisition_status);

-- 3. Supplier Performance Metrics (On-time delivery %, quality pass rate, lead times)
create table if not exists supplier_performance_metrics (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  vendor_id integer not null references vendors(id) on delete cascade,
  total_orders_placed integer not null default 0,
  on_time_deliveries integer not null default 0,
  delayed_deliveries integer not null default 0,
  on_time_delivery_rate_pct numeric(5, 2) not null default 100,
  quality_accepted_lots integer not null default 0,
  quality_rejected_lots integer not null default 0,
  quality_pass_rate_pct numeric(5, 2) not null default 100,
  average_lead_time_days numeric(6, 2) not null default 0,
  vendor_score numeric(5, 2) not null default 100,
  last_evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_metrics_unique unique (company_id, vendor_id)
);

create index if not exists idx_supplier_performance_vendor
  on supplier_performance_metrics(company_id, vendor_id);

-- 4. Screen permissions for mrp_planning_desk
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'mrp_planning_desk', true, true, true, false, false, false
from roles r
where r.role_key in ('super_admin', 'purchase_manager', 'procurement_executive', 'production_planner', 'cfo', 'commercial_head')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true;
