create table if not exists customer_receipts (
  id serial primary key,
  receipt_number text not null unique,
  customer_id integer not null references customers(id),
  distributor_id integer references distributors(id),
  receipt_status text not null default 'draft',
  receipt_date date not null default current_date,
  base_currency_id integer not null references currencies(id),
  receipt_currency_id integer not null references currencies(id),
  receipt_amount_base numeric(14, 2) not null default 0,
  receipt_amount_invoice numeric(14, 2) not null default 0,
  allocated_amount_base numeric(14, 2) not null default 0,
  allocated_amount_invoice numeric(14, 2) not null default 0,
  unallocated_amount_base numeric(14, 2) not null default 0,
  unallocated_amount_invoice numeric(14, 2) not null default 0,
  payment_mode text,
  reference_no text,
  bank_name text,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (receipt_status in ('draft', 'posted', 'cancelled'))
);

create index if not exists idx_customer_receipts_customer_id on customer_receipts(customer_id);
create index if not exists idx_customer_receipts_distributor_id on customer_receipts(distributor_id);

create table if not exists customer_receipt_allocations (
  id serial primary key,
  customer_receipt_id integer not null references customer_receipts(id) on delete cascade,
  customer_invoice_id integer not null references customer_invoices(id) on delete cascade,
  allocated_base numeric(14, 2) not null default 0,
  allocated_invoice numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_customer_receipt_allocations_receipt_invoice_unique
on customer_receipt_allocations(customer_receipt_id, customer_invoice_id);

create index if not exists idx_customer_receipt_allocations_invoice_id
on customer_receipt_allocations(customer_invoice_id);
