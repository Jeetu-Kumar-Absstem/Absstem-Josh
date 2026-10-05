create table if not exists job_cards (
  id serial primary key,
  job_card_number text not null unique,
  job_status text not null default 'draft',
  job_date date not null default current_date,
  job_type text not null default 'service',
  service_warranty_case_id integer references service_warranty_cases(id) on delete set null,
  technician_name text,
  department text,
  site_name text,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (job_status in ('draft', 'open', 'closed', 'cancelled')),
  check (job_type in ('service', 'installation', 'internal_issue'))
);

create table if not exists job_card_lines (
  id serial primary key,
  job_card_id integer not null references job_cards(id) on delete cascade,
  line_no integer not null,
  product_id integer not null references products(id) on delete restrict,
  item_code text,
  item_name text,
  uom text,
  serial_no_required boolean not null default false,
  qty_requested numeric(18, 4) not null default 0,
  qty_consumed numeric(18, 4) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_card_id, line_no),
  unique (job_card_id, product_id),
  check (qty_requested >= 0),
  check (qty_consumed >= 0)
);

create index if not exists idx_job_card_lines_job_card_id on job_card_lines(job_card_id);

create table if not exists job_card_movements (
  id serial primary key,
  job_card_id integer not null references job_cards(id) on delete cascade,
  job_card_line_id integer not null references job_card_lines(id) on delete cascade,
  movement_type text not null,
  movement_date date not null default current_date,
  qty numeric(18, 4) not null default 0,
  reference_no text,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (movement_type in ('issue', 'return')),
  check (qty > 0)
);

create index if not exists idx_job_card_movements_job_card_id on job_card_movements(job_card_id);
create index if not exists idx_job_card_movements_line_id on job_card_movements(job_card_line_id);

create table if not exists job_card_movement_serials (
  id serial primary key,
  job_card_movement_id integer not null references job_card_movements(id) on delete cascade,
  serial_no text not null,
  created_at timestamptz not null default now(),
  unique (job_card_movement_id, serial_no)
);

create index if not exists idx_job_card_movement_serials_move_id on job_card_movement_serials(job_card_movement_id);
