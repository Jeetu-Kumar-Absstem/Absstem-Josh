-- 165: Shop Floor & Inventory Consumption (Phase 5: Kitting, Issuance & Scrap)

create table if not exists work_orders (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  work_order_no text not null,
  manufacturing_bom_id bigint not null references manufacturing_boms(id) on delete restrict,
  finished_good_product_id bigint not null references products(id) on delete restrict,
  target_qty numeric(14, 4) not null default 1,
  completed_qty numeric(14, 4) not null default 0,
  scrapped_qty numeric(14, 4) not null default 0,
  status text not null default 'scheduled',
  priority text not null default 'normal',
  scheduled_start_date date,
  scheduled_end_date date,
  actual_start_at timestamptz,
  actual_completed_at timestamptz,
  job_card_id bigint references job_cards(id) on delete set null,
  batch_number text,
  remarks text,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_orders_status_check check (status in ('scheduled', 'in_production', 'completed', 'cancelled')),
  constraint work_orders_priority_check check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint work_orders_target_qty_positive check (target_qty > 0),
  constraint work_orders_completed_qty_non_negative check (completed_qty >= 0),
  constraint work_orders_no_unique_per_company unique (company_id, work_order_no)
);

create index if not exists work_orders_company_status_idx
  on work_orders (company_id, status, scheduled_start_date);

create index if not exists work_orders_bom_idx
  on work_orders (manufacturing_bom_id, finished_good_product_id);

create table if not exists work_order_kits (
  id bigserial primary key,
  work_order_id bigint not null references work_orders(id) on delete cascade,
  bom_line_id bigint references manufacturing_bom_lines(id) on delete set null,
  component_product_id bigint not null references products(id) on delete restrict,
  component_specification_id bigint references component_specifications(id) on delete set null,
  line_no integer not null default 1,
  item_code text not null,
  item_name text not null,
  uom text,
  qty_per_unit numeric(14, 4) not null default 1,
  required_qty numeric(14, 4) not null default 0,
  issued_qty numeric(14, 4) not null default 0,
  scrapped_qty numeric(14, 4) not null default 0,
  returned_qty numeric(14, 4) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_order_kits_req_qty_positive check (required_qty >= 0),
  constraint work_order_kits_issued_qty_non_negative check (issued_qty >= 0)
);

create index if not exists work_order_kits_wo_idx
  on work_order_kits (work_order_id, line_no);

create index if not exists work_order_kits_product_idx
  on work_order_kits (component_product_id);

create index if not exists work_order_kits_spec_idx
  on work_order_kits (component_specification_id)
  where component_specification_id is not null;

create table if not exists shop_floor_issuances (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  work_order_id bigint not null references work_orders(id) on delete cascade,
  work_order_kit_id bigint not null references work_order_kits(id) on delete restrict,
  product_id bigint not null references products(id) on delete restrict,
  qty_issued numeric(14, 4) not null,
  unit_cost_base numeric(14, 4) not null default 0,
  total_cost_base numeric(14, 4) not null default 0,
  issued_at timestamptz not null default now(),
  bin_location text,
  lot_number text,
  barcode_scanned text,
  issued_by bigint references erp_users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  constraint shop_floor_issuances_qty_positive check (qty_issued > 0)
);

create index if not exists shop_floor_issuances_wo_idx
  on shop_floor_issuances (work_order_id, issued_at);

create index if not exists shop_floor_issuances_company_prod_idx
  on shop_floor_issuances (company_id, product_id, issued_at);

create table if not exists shop_floor_scrap (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  work_order_id bigint not null references work_orders(id) on delete cascade,
  work_order_kit_id bigint references work_order_kits(id) on delete set null,
  product_id bigint not null references products(id) on delete restrict,
  qty_scrapped numeric(14, 4) not null,
  unit_cost_base numeric(14, 4) not null default 0,
  variance_cost_base numeric(14, 4) not null default 0,
  reason_code text not null default 'DAMAGED_IN_ASSEMBLY',
  stage_name text,
  scrapped_at timestamptz not null default now(),
  scrapped_by bigint references erp_users(id) on delete set null,
  remarks text,
  created_at timestamptz not null default now(),
  constraint shop_floor_scrap_qty_positive check (qty_scrapped > 0),
  constraint shop_floor_scrap_reason_check check (
    reason_code in (
      'DAMAGED_IN_ASSEMBLY', 'MACHINING_DEFECT', 'MATERIAL_FAIL',
      'OPERATOR_ERROR', 'TOOLING_WEAR', 'OBSOLETE', 'OTHER'
    )
  )
);

create index if not exists shop_floor_scrap_wo_idx
  on shop_floor_scrap (work_order_id, scrapped_at);

create index if not exists shop_floor_scrap_company_reason_idx
  on shop_floor_scrap (company_id, reason_code, scrapped_at);

-- Permissions for shop_floor desk
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'shop_floor', true, true, true, false, false, false
from roles r
where r.role_key in ('super_admin', 'production_manager', 'stores_manager', 'storekeeper', 'operations_manager', 'plant_head')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true;
