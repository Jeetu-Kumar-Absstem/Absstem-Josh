create table if not exists supplier_claims (
  id serial primary key,
  claim_number text not null unique,
  quality_control_id integer not null references quality_controls(id) on delete restrict,
  vendor_id integer not null references vendors(id) on delete restrict,
  claim_status text not null default 'open',
  claim_date date not null default current_date,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (claim_status in ('open', 'closed', 'cancelled'))
);

create index if not exists idx_supplier_claims_qc_id on supplier_claims(quality_control_id);
create index if not exists idx_supplier_claims_vendor_id on supplier_claims(vendor_id);

create table if not exists supplier_claim_lines (
  id serial primary key,
  supplier_claim_id integer not null references supplier_claims(id) on delete cascade,
  quality_hold_action_id integer not null unique references quality_hold_actions(id) on delete restrict,
  quality_control_line_id integer not null references quality_control_lines(id) on delete restrict,
  line_no integer not null,
  product_id integer references products(id) on delete set null,
  item_code text,
  item_name text,
  line_description text,
  uom text,
  serial_no_required boolean not null default false,
  qty_claimed numeric(18, 4) not null default 0,
  qty_received numeric(18, 4) not null default 0,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_claim_id, line_no),
  check (qty_claimed > 0),
  check (qty_received >= 0),
  check (qty_received <= qty_claimed)
);

create index if not exists idx_supplier_claim_lines_claim_id on supplier_claim_lines(supplier_claim_id);
create index if not exists idx_supplier_claim_lines_qc_line_id on supplier_claim_lines(quality_control_line_id);

create table if not exists supplier_claim_receipts (
  id serial primary key,
  supplier_claim_id integer not null references supplier_claims(id) on delete cascade,
  supplier_claim_line_id integer not null references supplier_claim_lines(id) on delete cascade,
  receipt_number text not null unique,
  receipt_date date not null default current_date,
  qty_received numeric(18, 4) not null default 0,
  reference_no text,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (qty_received > 0)
);

create index if not exists idx_supplier_claim_receipts_claim_id on supplier_claim_receipts(supplier_claim_id);
create index if not exists idx_supplier_claim_receipts_line_id on supplier_claim_receipts(supplier_claim_line_id);

create table if not exists supplier_claim_receipt_serials (
  id serial primary key,
  supplier_claim_receipt_id integer not null references supplier_claim_receipts(id) on delete cascade,
  serial_no text not null unique,
  created_at timestamptz not null default now(),
  unique (supplier_claim_receipt_id, serial_no)
);

create index if not exists idx_supplier_claim_receipt_serials_receipt_id on supplier_claim_receipt_serials(supplier_claim_receipt_id);
