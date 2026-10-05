create table if not exists product_categories (
  id serial primary key,
  category_name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_groups (
  id serial primary key,
  category_id integer references product_categories(id),
  group_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_id, group_name)
);

create table if not exists products (
  id serial primary key,
  category_id integer references product_categories(id),
  group_id integer references product_groups(id),
  brand text,
  item_code text not null unique,
  item_name text not null,
  item_type text,
  uom text,
  hsn_no text,
  list_price numeric(18, 2) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  variance_pct numeric(5, 2),
  last_purchase_price numeric(18, 2),
  last_purchase_date date,
  description text,
  serial_no_required boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_products_group_id on products(group_id);
create index if not exists idx_products_category_id on products(category_id);

create table if not exists product_attributes (
  id serial primary key,
  product_id integer not null references products(id) on delete cascade,
  sort_order smallint not null,
  caption text,
  spec_value text,
  created_at timestamptz not null default now(),
  unique (product_id, sort_order)
);

create index if not exists idx_product_attributes_product_id on product_attributes(product_id);
