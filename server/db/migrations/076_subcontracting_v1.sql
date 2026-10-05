create table if not exists subcontract_orders (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  subcontract_number text not null,
  subcontract_status text not null default 'draft',
  vendor_id integer references vendors(id) on delete restrict,
  job_card_id integer references job_cards(id) on delete set null,
  order_date date not null default current_date,
  due_date date,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (subcontract_status in ('draft', 'sent', 'partial_received', 'received', 'closed', 'cancelled')),
  unique (company_id, subcontract_number)
);

create index if not exists idx_subcontract_orders_company_status on subcontract_orders(company_id, subcontract_status);
create index if not exists idx_subcontract_orders_vendor_id on subcontract_orders(vendor_id);
create index if not exists idx_subcontract_orders_due_date on subcontract_orders(due_date);

create table if not exists subcontract_order_lines (
  id serial primary key,
  subcontract_order_id integer not null references subcontract_orders(id) on delete cascade,
  line_no integer not null,
  product_id integer not null references products(id) on delete restrict,
  description text,
  uom text,
  qty_ordered numeric(18, 4) not null default 0,
  qty_sent numeric(18, 4) not null default 0,
  qty_received numeric(18, 4) not null default 0,
  unit_rate_base numeric(18, 4) not null default 0,
  amount_base numeric(18, 2) not null default 0,
  remarks text,
  check (qty_ordered >= 0),
  check (qty_sent >= 0),
  check (qty_received >= 0),
  check (unit_rate_base >= 0),
  check (amount_base >= 0),
  unique (subcontract_order_id, line_no)
);

create index if not exists idx_subcontract_order_lines_order_id on subcontract_order_lines(subcontract_order_id);
create index if not exists idx_subcontract_order_lines_product_id on subcontract_order_lines(product_id);

create table if not exists subcontract_movements (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  subcontract_order_id integer not null references subcontract_orders(id) on delete cascade,
  subcontract_order_line_id integer not null references subcontract_order_lines(id) on delete cascade,
  movement_type text not null,
  movement_date date not null default current_date,
  qty numeric(18, 4) not null,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (movement_type in ('send', 'receive')),
  check (qty > 0)
);

create index if not exists idx_subcontract_movements_order_id on subcontract_movements(subcontract_order_id);
create index if not exists idx_subcontract_movements_line_id on subcontract_movements(subcontract_order_line_id);
