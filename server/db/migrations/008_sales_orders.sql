create table if not exists sales_orders (
  id serial primary key,
  so_number text not null unique,
  quote_revision_id integer references quote_revisions(id),
  customer_id integer not null references customers(id),
  distributor_id integer references distributors(id),
  order_status text not null default 'draft',
  base_currency_id integer not null references currencies(id),
  order_currency_id integer not null references currencies(id),
  order_date date not null default current_date,
  subtotal_base numeric(18, 2) not null default 0,
  subtotal_order numeric(18, 2) not null default 0,
  tax_total_base numeric(18, 2) not null default 0,
  tax_total_order numeric(18, 2) not null default 0,
  grand_total_base numeric(18, 2) not null default 0,
  grand_total_order numeric(18, 2) not null default 0,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sales_order_lines (
  id serial primary key,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  qty numeric(18, 4) not null default 1,
  unit_price_base numeric(18, 4) not null default 0,
  unit_price_order numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total_base numeric(18, 2) not null default 0,
  line_total_order numeric(18, 2) not null default 0,
  unique (sales_order_id, line_no),
  check (qty > 0)
);

create index if not exists idx_sales_order_lines_sales_order_id on sales_order_lines(sales_order_id);

create table if not exists sales_order_revisions (
  id serial primary key,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  revision_no integer not null,
  revision_status text not null default 'draft',
  change_summary text,
  changed_by integer references erp_users(id),
  changed_at timestamptz not null default now(),
  unique (sales_order_id, revision_no)
);

create table if not exists payment_milestones (
  id serial primary key,
  sales_order_id integer not null references sales_orders(id) on delete cascade,
  milestone_name text not null,
  milestone_percent numeric(7, 4),
  milestone_amount_base numeric(18, 2),
  milestone_amount_order numeric(18, 2),
  due_type text not null default 'date',
  due_date date,
  status text not null default 'pending',
  check (milestone_percent is null or (milestone_percent >= 0 and milestone_percent <= 100))
);

create index if not exists idx_payment_milestones_sales_order_id on payment_milestones(sales_order_id);
