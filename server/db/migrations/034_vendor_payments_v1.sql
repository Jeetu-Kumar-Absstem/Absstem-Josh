create table if not exists vendor_payments (
  id serial primary key,
  payment_number text not null unique,
  vendor_id integer not null references vendors(id),
  payment_status text not null default 'draft',
  payment_date date not null default current_date,
  payment_currency_id integer not null references currencies(id),
  payment_amount numeric(18, 2) not null default 0,
  payment_mode text,
  reference_no text,
  bank_name text,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payment_status in ('draft', 'posted', 'cancelled')),
  check (payment_amount >= 0)
);

create index if not exists idx_vendor_payments_vendor_id on vendor_payments(vendor_id);

create table if not exists vendor_payment_allocations (
  id serial primary key,
  vendor_payment_id integer not null references vendor_payments(id) on delete cascade,
  purchase_invoice_id integer not null references purchase_invoices(id) on delete cascade,
  allocated_amount numeric(18, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_payment_id, purchase_invoice_id),
  check (allocated_amount >= 0)
);

create index if not exists idx_vendor_payment_allocations_payment_id on vendor_payment_allocations(vendor_payment_id);
create index if not exists idx_vendor_payment_allocations_invoice_id on vendor_payment_allocations(purchase_invoice_id);
