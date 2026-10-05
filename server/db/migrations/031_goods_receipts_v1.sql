create table if not exists goods_receipts (
  id serial primary key,
  grn_number text not null unique,
  vendor_id integer not null references vendors(id),
  purchase_order_id integer references purchase_orders(id) on delete set null,
  receipt_status text not null default 'draft',
  receipt_date date not null default current_date,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (receipt_status in ('draft', 'posted', 'cancelled'))
);

create index if not exists idx_goods_receipts_vendor_id on goods_receipts(vendor_id);
create index if not exists idx_goods_receipts_purchase_order_id on goods_receipts(purchase_order_id);

create table if not exists goods_receipt_lines (
  id serial primary key,
  goods_receipt_id integer not null references goods_receipts(id) on delete cascade,
  purchase_order_line_id integer references purchase_order_lines(id) on delete set null,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty_received numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (goods_receipt_id, line_no),
  check (qty_received >= 0)
);

create index if not exists idx_goods_receipt_lines_goods_receipt_id on goods_receipt_lines(goods_receipt_id);
create index if not exists idx_goods_receipt_lines_po_line_id on goods_receipt_lines(purchase_order_line_id);

create table if not exists goods_receipt_serials (
  id serial primary key,
  goods_receipt_line_id integer not null references goods_receipt_lines(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (goods_receipt_line_id, serial_no),
  unique (serial_no)
);

create index if not exists idx_goods_receipt_serials_line_id on goods_receipt_serials(goods_receipt_line_id);
