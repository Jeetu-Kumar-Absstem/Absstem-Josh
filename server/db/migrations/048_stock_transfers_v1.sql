create table if not exists stock_locations (
  id serial primary key,
  location_code text not null unique,
  location_name text not null,
  location_type text not null default 'warehouse',
  is_active boolean not null default true,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (location_type in ('warehouse', 'site', 'van', 'service'))
);

create table if not exists stock_transfers (
  id serial primary key,
  transfer_number text not null unique,
  transfer_status text not null default 'draft',
  transfer_date date not null default current_date,
  from_location_id integer not null references stock_locations(id) on delete restrict,
  to_location_id integer not null references stock_locations(id) on delete restrict,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (transfer_status in ('draft', 'posted', 'cancelled')),
  check (from_location_id <> to_location_id)
);

create table if not exists stock_transfer_lines (
  id serial primary key,
  stock_transfer_id integer not null references stock_transfers(id) on delete cascade,
  line_no integer not null,
  product_id integer not null references products(id) on delete restrict,
  item_code text,
  item_name text,
  uom text,
  serial_no_required boolean not null default false,
  qty numeric(18, 4) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stock_transfer_id, line_no),
  unique (stock_transfer_id, product_id),
  check (qty > 0)
);

create index if not exists idx_stock_transfer_lines_transfer_id on stock_transfer_lines(stock_transfer_id);

create table if not exists stock_transfer_line_serials (
  id serial primary key,
  stock_transfer_line_id integer not null references stock_transfer_lines(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (stock_transfer_line_id, serial_no)
);

create index if not exists idx_stock_transfer_line_serials_line_id on stock_transfer_line_serials(stock_transfer_line_id);
