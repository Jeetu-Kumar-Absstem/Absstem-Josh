create table if not exists service_warranty_cases (
  id serial primary key,
  case_number text not null unique,
  case_status text not null default 'open',
  case_date date not null default current_date,
  customer_id integer not null references customers(id) on delete restrict,
  sales_order_id integer references sales_orders(id) on delete set null,
  dispatch_id integer not null references dispatches(id) on delete restrict,
  customer_invoice_id integer references customer_invoices(id) on delete set null,
  issue_type text not null default 'warranty',
  reported_by text,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (case_status in ('open', 'closed', 'cancelled')),
  check (issue_type in ('warranty', 'service', 'field_return'))
);

create index if not exists idx_service_warranty_cases_customer_id on service_warranty_cases(customer_id);
create index if not exists idx_service_warranty_cases_dispatch_id on service_warranty_cases(dispatch_id);

create table if not exists service_warranty_case_lines (
  id serial primary key,
  service_warranty_case_id integer not null references service_warranty_cases(id) on delete cascade,
  dispatch_line_id integer not null references dispatch_lines(id) on delete restrict,
  sales_order_line_id integer references sales_order_lines(id) on delete set null,
  line_no integer not null,
  product_id integer references products(id) on delete set null,
  item_code text,
  item_name text,
  line_description text,
  uom text,
  serial_no_required boolean not null default false,
  qty_eligible numeric(18, 4) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_warranty_case_id, line_no),
  unique (service_warranty_case_id, dispatch_line_id),
  check (qty_eligible > 0)
);

create index if not exists idx_service_warranty_case_lines_case_id on service_warranty_case_lines(service_warranty_case_id);
create index if not exists idx_service_warranty_case_lines_product_id on service_warranty_case_lines(product_id);

create table if not exists service_warranty_movements (
  id serial primary key,
  service_warranty_case_id integer not null references service_warranty_cases(id) on delete cascade,
  service_warranty_case_line_id integer not null references service_warranty_case_lines(id) on delete cascade,
  movement_type text not null,
  movement_date date not null default current_date,
  qty numeric(18, 4) not null default 0,
  reference_no text,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (movement_type in ('field_return', 'replacement_issue')),
  check (qty > 0)
);

create index if not exists idx_service_warranty_movements_case_id on service_warranty_movements(service_warranty_case_id);
create index if not exists idx_service_warranty_movements_line_id on service_warranty_movements(service_warranty_case_line_id);

create table if not exists service_warranty_movement_serials (
  id serial primary key,
  service_warranty_movement_id integer not null references service_warranty_movements(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (service_warranty_movement_id, serial_no)
);

create index if not exists idx_service_warranty_movement_serials_move_id on service_warranty_movement_serials(service_warranty_movement_id);
