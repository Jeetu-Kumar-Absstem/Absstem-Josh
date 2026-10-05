-- 172: Product Master & SKU Specifications Architecture (Phase 12)

-- 1. Enhance products table with standard industrial item types, costs, safety stock & JSONB technical specifications
alter table products
  add column if not exists sku text,
  add column if not exists standard_cost numeric(18, 4) not null default 0,
  add column if not exists selling_price numeric(18, 4) not null default 0,
  add column if not exists min_safety_stock numeric(14, 4) not null default 0,
  add column if not exists reorder_quantity numeric(14, 4) not null default 0,
  add column if not exists preferred_vendor_id integer references vendors(id) on delete set null,
  add column if not exists specifications_json jsonb default '{}'::jsonb,
  add column if not exists technical_notes text;

-- Populate sku from item_code if sku is currently null
update products
set sku = item_code
where sku is null or length(trim(sku)) = 0;

-- Populate selling_price from list_price where selling_price is 0
update products
set selling_price = list_price
where selling_price = 0 and list_price > 0;

-- Ensure item_type default values if null or non-standard
update products
set item_type = 'finished_good'
where item_type is null or item_type = '';

-- Ensure uom default if null
update products
set uom = 'NOS'
where uom is null or uom = '';

-- 2. Indexes for fast multi-criteria queries & MRP / AVL Lookups
create index if not exists idx_products_sku on products(sku);
create index if not exists idx_products_item_type on products(item_type);
create index if not exists idx_products_hsn_no on products(hsn_no);
create index if not exists idx_products_preferred_vendor on products(preferred_vendor_id);
create index if not exists idx_products_specifications_json on products using gin(specifications_json);

-- 3. Screen permissions for Product Master Desk
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  r.id,
  'product_master_desk',
  true,
  r.role_key in ('super_admin', 'business_admin', 'design_engineer', 'engineering_approver', 'plant_head', 'purchase_manager'),
  r.role_key in ('super_admin', 'business_admin', 'design_engineer', 'engineering_approver', 'plant_head', 'purchase_manager'),
  r.role_key in ('super_admin', 'business_admin', 'engineering_approver', 'plant_head'),
  false,
  false
from roles r
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

comment on table products is 'Comprehensive Product Master and SKU Catalog for Industrial Equipment, Sub-assemblies, Raw Materials & Spare Parts';
