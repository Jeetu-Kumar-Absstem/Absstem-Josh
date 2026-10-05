create table if not exists dispatches (
  id serial primary key,
  dispatch_number text not null unique,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  customer_id integer not null references customers(id),
  distributor_id integer references distributors(id),
  dispatch_status text not null default 'draft',
  dispatch_date date not null default current_date,
  transporter_name text,
  lr_no text,
  vehicle_no text,
  eway_ref text,
  tracking_ref text,
  consignee_name text,
  consignee_address text,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (dispatch_status in ('draft', 'ready', 'dispatched', 'delivered', 'cancelled'))
);

create unique index if not exists idx_dispatches_sales_order_id_unique
on dispatches(sales_order_id);

create table if not exists dispatch_lines (
  id serial primary key,
  dispatch_id integer not null references dispatches(id) on delete cascade,
  sales_order_line_id integer not null references sales_order_lines(id) on delete cascade,
  line_no integer not null,
  item_code text,
  item_name text,
  line_description text,
  qty_ordered numeric(14, 3) not null default 0,
  qty_dispatch numeric(14, 3) not null default 0,
  gst_pct numeric(7, 4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_dispatch_lines_dispatch_so_line_unique
on dispatch_lines(dispatch_id, sales_order_line_id);

create table if not exists customer_invoices (
  id serial primary key,
  invoice_number text not null unique,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  customer_id integer not null references customers(id),
  distributor_id integer references distributors(id),
  invoice_status text not null default 'draft',
  invoice_date date not null default current_date,
  base_currency_id integer not null references currencies(id),
  invoice_currency_id integer not null references currencies(id),
  subtotal_base numeric(14, 2) not null default 0,
  subtotal_invoice numeric(14, 2) not null default 0,
  tax_total_base numeric(14, 2) not null default 0,
  tax_total_invoice numeric(14, 2) not null default 0,
  grand_total_base numeric(14, 2) not null default 0,
  grand_total_invoice numeric(14, 2) not null default 0,
  attention_to text,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (invoice_status in ('draft', 'issued', 'paid', 'cancelled'))
);

create unique index if not exists idx_customer_invoices_sales_order_id_unique
on customer_invoices(sales_order_id);

create table if not exists invoice_lines (
  id serial primary key,
  customer_invoice_id integer not null references customer_invoices(id) on delete cascade,
  sales_order_line_id integer references sales_order_lines(id) on delete set null,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  qty numeric(14, 3) not null default 0,
  unit_price_base numeric(14, 2) not null default 0,
  unit_price_invoice numeric(14, 2) not null default 0,
  gst_pct numeric(7, 4) not null default 0,
  line_total_base numeric(14, 2) not null default 0,
  line_total_invoice numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
