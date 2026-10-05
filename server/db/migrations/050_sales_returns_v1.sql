create table if not exists sales_returns (
  id serial primary key,
  return_number text not null unique,
  credit_note_number text unique,
  customer_id integer not null references customers(id) on delete restrict,
  dispatch_id integer references dispatches(id) on delete set null,
  customer_invoice_id integer references customer_invoices(id) on delete set null,
  return_status text not null default 'draft',
  return_date date not null default current_date,
  remarks text,
  subtotal_invoice numeric(18, 2) not null default 0,
  tax_total_invoice numeric(18, 2) not null default 0,
  grand_total_invoice numeric(18, 2) not null default 0,
  credit_note_amount numeric(18, 2) not null default 0,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (return_status in ('draft', 'posted', 'cancelled')),
  check (credit_note_amount >= 0)
);

create table if not exists sales_return_lines (
  id serial primary key,
  sales_return_id integer not null references sales_returns(id) on delete cascade,
  line_no integer not null,
  dispatch_line_id integer references dispatch_lines(id) on delete set null,
  invoice_line_id integer references invoice_lines(id) on delete set null,
  sales_order_line_id integer references sales_order_lines(id) on delete set null,
  product_id integer references products(id) on delete set null,
  item_code text,
  item_name text,
  line_description text,
  uom text,
  qty_return numeric(18, 4) not null default 0,
  unit_price_invoice numeric(18, 2) not null default 0,
  gst_pct numeric(9, 2) not null default 0,
  line_total_invoice numeric(18, 2) not null default 0,
  tax_total_invoice numeric(18, 2) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sales_return_id, line_no),
  check (qty_return >= 0)
);

create index if not exists idx_sales_return_lines_return_id on sales_return_lines(sales_return_id);
create index if not exists idx_sales_return_lines_invoice_line_id on sales_return_lines(invoice_line_id);

create table if not exists sales_return_serials (
  id serial primary key,
  sales_return_line_id integer not null references sales_return_lines(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (sales_return_line_id, serial_no)
);

create index if not exists idx_sales_return_serials_line_id on sales_return_serials(sales_return_line_id);
