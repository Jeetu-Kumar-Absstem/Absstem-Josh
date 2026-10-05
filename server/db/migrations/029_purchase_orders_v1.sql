create table if not exists purchase_orders (
  id serial primary key,
  po_number text not null unique,
  vendor_id integer not null references vendors(id),
  po_status text not null default 'draft',
  base_currency_id integer not null references currencies(id),
  order_currency_id integer not null references currencies(id),
  po_date date not null default current_date,
  subtotal_base numeric(18, 2) not null default 0,
  subtotal_order numeric(18, 2) not null default 0,
  tax_total_base numeric(18, 2) not null default 0,
  tax_total_order numeric(18, 2) not null default 0,
  grand_total_base numeric(18, 2) not null default 0,
  grand_total_order numeric(18, 2) not null default 0,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (po_status in ('draft', 'confirmed', 'closed', 'cancelled'))
);

create index if not exists idx_purchase_orders_vendor_id on purchase_orders(vendor_id);

create table if not exists purchase_order_lines (
  id serial primary key,
  purchase_order_id integer not null references purchase_orders(id) on delete cascade,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty numeric(18, 4) not null default 1,
  unit_price_base numeric(18, 4) not null default 0,
  unit_price_order numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total_base numeric(18, 2) not null default 0,
  line_total_order numeric(18, 2) not null default 0,
  unique (purchase_order_id, line_no),
  check (qty > 0)
);

create index if not exists idx_purchase_order_lines_purchase_order_id on purchase_order_lines(purchase_order_id);
