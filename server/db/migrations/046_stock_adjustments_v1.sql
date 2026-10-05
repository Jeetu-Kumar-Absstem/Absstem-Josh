create table if not exists stock_adjustments (
  id serial primary key,
  adjustment_number text not null unique,
  adjustment_status text not null default 'draft',
  adjustment_mode text not null default 'physical_verification',
  adjustment_date date not null default current_date,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (adjustment_status in ('draft', 'posted', 'cancelled')),
  check (adjustment_mode in ('physical_verification', 'manual_adjustment'))
);

create table if not exists stock_adjustment_lines (
  id serial primary key,
  stock_adjustment_id integer not null references stock_adjustments(id) on delete cascade,
  line_no integer not null,
  product_id integer not null references products(id) on delete restrict,
  item_code text,
  item_name text,
  uom text,
  serial_no_required boolean not null default false,
  system_qty numeric(18, 4) not null default 0,
  counted_qty numeric(18, 4) not null default 0,
  adjustment_qty numeric(18, 4) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stock_adjustment_id, line_no),
  unique (stock_adjustment_id, product_id)
);

create index if not exists idx_stock_adjustment_lines_adjustment_id on stock_adjustment_lines(stock_adjustment_id);
create index if not exists idx_stock_adjustment_lines_product_id on stock_adjustment_lines(product_id);

create table if not exists stock_adjustment_line_serials (
  id serial primary key,
  stock_adjustment_line_id integer not null references stock_adjustment_lines(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (stock_adjustment_line_id, serial_no)
);

create index if not exists idx_stock_adjustment_line_serials_line_id on stock_adjustment_line_serials(stock_adjustment_line_id);
