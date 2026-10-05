create table if not exists amc_contracts (
  id serial primary key,
  contract_number text not null unique,
  contract_status text not null default 'draft',
  contract_date date not null default current_date,
  customer_id integer not null references customers(id) on delete restrict,
  sales_order_id integer references sales_orders(id) on delete set null,
  dispatch_id integer not null references dispatches(id) on delete restrict,
  customer_invoice_id integer references customer_invoices(id) on delete set null,
  start_date date not null,
  end_date date not null,
  visit_frequency_days integer not null default 90,
  planned_visits integer not null default 4,
  next_due_date date,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contract_status in ('draft', 'active', 'expired', 'closed', 'cancelled')),
  check (visit_frequency_days > 0),
  check (planned_visits > 0),
  check (end_date >= start_date)
);

create table if not exists amc_contract_lines (
  id serial primary key,
  amc_contract_id integer not null references amc_contracts(id) on delete cascade,
  dispatch_line_id integer not null references dispatch_lines(id) on delete restrict,
  line_no integer not null,
  product_id integer references products(id) on delete set null,
  item_code text,
  item_name text,
  uom text,
  qty_covered numeric(18, 4) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (amc_contract_id, line_no),
  unique (amc_contract_id, dispatch_line_id),
  check (qty_covered > 0)
);

create index if not exists idx_amc_contract_lines_contract_id on amc_contract_lines(amc_contract_id);

create table if not exists amc_visits (
  id serial primary key,
  amc_contract_id integer not null references amc_contracts(id) on delete cascade,
  visit_no integer not null,
  due_date date not null,
  visit_status text not null default 'scheduled',
  technician_name text,
  completed_at date,
  remarks text,
  service_warranty_case_id integer references service_warranty_cases(id) on delete set null,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (amc_contract_id, visit_no),
  check (visit_status in ('scheduled', 'completed', 'missed', 'cancelled'))
);

create index if not exists idx_amc_visits_contract_id on amc_visits(amc_contract_id);
