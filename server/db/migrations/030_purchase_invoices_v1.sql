create table if not exists purchase_invoices (
  id serial primary key,
  purchase_invoice_number text not null unique,
  vendor_id integer not null references vendors(id),
  purchase_order_id integer references purchase_orders(id) on delete set null,
  invoice_status text not null default 'draft',
  invoice_date date not null default current_date,
  vendor_invoice_no text,
  base_currency_id integer not null references currencies(id),
  invoice_currency_id integer not null references currencies(id),
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
  check (invoice_status in ('draft', 'posted', 'cancelled'))
);

create index if not exists idx_purchase_invoices_vendor_id on purchase_invoices(vendor_id);
create index if not exists idx_purchase_invoices_purchase_order_id on purchase_invoices(purchase_order_id);

create table if not exists purchase_invoice_lines (
  id serial primary key,
  purchase_invoice_id integer not null references purchase_invoices(id) on delete cascade,
  purchase_order_line_id integer references purchase_order_lines(id) on delete set null,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  uom text,
  qty numeric(18, 4) not null default 1,
  unit_price_base numeric(18, 4) not null default 0,
  unit_price_invoice numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total_base numeric(18, 2) not null default 0,
  line_total_invoice numeric(18, 2) not null default 0,
  unique (purchase_invoice_id, line_no),
  check (qty > 0)
);

create index if not exists idx_purchase_invoice_lines_purchase_invoice_id on purchase_invoice_lines(purchase_invoice_id);
