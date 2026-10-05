-- 162: Generic component specifications + Approved Vendor List (AVL)

create table if not exists component_specifications (
  id bigserial primary key,
  company_id bigint references companies(id) on delete cascade,
  spec_code text not null,
  spec_name text not null,
  geometry text,
  material text,
  pressure_rating text,
  uom text,
  notes text,
  is_active boolean not null default true,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint component_specifications_code_unique unique (company_id, spec_code)
);

create index if not exists component_specifications_company_idx
  on component_specifications (company_id, is_active);

create table if not exists component_specification_avl (
  id bigserial primary key,
  component_specification_id bigint not null references component_specifications(id) on delete cascade,
  vendor_id bigint references vendors(id) on delete set null,
  product_id bigint references products(id) on delete set null,
  vendor_name text,
  brand_name text,
  is_preferred boolean not null default false,
  is_active boolean not null default true,
  freight_percentage numeric(8, 4) not null default 0,
  import_duty_percentage numeric(8, 4) not null default 0,
  lead_time_days integer not null default 0,
  unit_price_hint numeric(14, 4),
  remarks text,
  created_by bigint references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint component_specification_avl_vendor_or_product check (
    vendor_id is not null or product_id is not null or coalesce(vendor_name, '') <> ''
  ),
  constraint component_specification_avl_freight_check check (freight_percentage >= 0),
  constraint component_specification_avl_duty_check check (import_duty_percentage >= 0),
  constraint component_specification_avl_lead_check check (lead_time_days >= 0)
);

create unique index if not exists component_specification_avl_unique_vendor_product
  on component_specification_avl (component_specification_id, coalesce(vendor_id, 0), coalesce(product_id, 0), coalesce(lower(brand_name), ''));

create index if not exists component_specification_avl_spec_idx
  on component_specification_avl (component_specification_id, is_active);

create index if not exists component_specification_avl_vendor_idx
  on component_specification_avl (vendor_id)
  where vendor_id is not null;

alter table manufacturing_bom_lines
  add column if not exists component_specification_id bigint references component_specifications(id) on delete set null;

create index if not exists manufacturing_bom_lines_spec_idx
  on manufacturing_bom_lines (component_specification_id)
  where component_specification_id is not null;
