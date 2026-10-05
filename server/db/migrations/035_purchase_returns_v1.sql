create table if not exists purchase_returns (
  id serial primary key,
  return_number text not null unique,
  debit_note_number text unique,
  vendor_id integer not null references vendors(id),
  goods_receipt_id integer references goods_receipts(id) on delete set null,
  purchase_invoice_id integer references purchase_invoices(id) on delete set null,
  return_status text not null default 'draft',
  return_date date not null default current_date,
  base_currency_id integer not null references currencies(id),
  return_currency_id integer not null references currencies(id),
  subtotal_base numeric(18, 2) not null default 0,
  subtotal_invoice numeric(18, 2) not null default 0,
  tax_total_base numeric(18, 2) not null default 0,
  tax_total_invoice numeric(18, 2) not null default 0,
  grand_total_base numeric(18, 2) not null default 0,
  grand_total_invoice numeric(18, 2) not null default 0,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (return_status in ('draft', 'posted', 'cancelled'))
);

create index if not exists idx_purchase_returns_vendor_id on purchase_returns(vendor_id);
create index if not exists idx_purchase_returns_goods_receipt_id on purchase_returns(goods_receipt_id);
create index if not exists idx_purchase_returns_purchase_invoice_id on purchase_returns(purchase_invoice_id);

create table if not exists purchase_return_lines (
  id serial primary key,
  purchase_return_id integer not null references purchase_returns(id) on delete cascade,
  goods_receipt_line_id integer references goods_receipt_lines(id) on delete set null,
  purchase_invoice_line_id integer references purchase_invoice_lines(id) on delete set null,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty_return numeric(18, 4) not null default 1,
  unit_price_base numeric(18, 4) not null default 0,
  unit_price_invoice numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total_base numeric(18, 2) not null default 0,
  line_total_invoice numeric(18, 2) not null default 0,
  unique (purchase_return_id, line_no),
  check (qty_return > 0)
);

create index if not exists idx_purchase_return_lines_purchase_return_id on purchase_return_lines(purchase_return_id);
create index if not exists idx_purchase_return_lines_goods_receipt_line_id on purchase_return_lines(goods_receipt_line_id);
create index if not exists idx_purchase_return_lines_purchase_invoice_line_id on purchase_return_lines(purchase_invoice_line_id);

create table if not exists purchase_return_serials (
  id serial primary key,
  purchase_return_line_id integer not null references purchase_return_lines(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (purchase_return_line_id, serial_no)
);

create index if not exists idx_purchase_return_serials_line_id on purchase_return_serials(purchase_return_line_id);
