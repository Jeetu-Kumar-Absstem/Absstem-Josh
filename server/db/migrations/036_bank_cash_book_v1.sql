create table if not exists finance_books (
  id serial primary key,
  book_code text unique,
  book_name text not null,
  book_type text not null default 'bank',
  opening_balance numeric(18, 2) not null default 0,
  account_name text,
  account_no text,
  ifsc text,
  bank_name text,
  branch_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (book_type in ('bank', 'cash'))
);

create table if not exists finance_book_entries (
  id serial primary key,
  finance_book_id integer not null references finance_books(id) on delete cascade,
  entry_number text not null unique,
  entry_status text not null default 'draft',
  entry_date date not null default current_date,
  entry_type text not null default 'receipt',
  amount numeric(18, 2) not null default 0,
  counterparty_name text,
  reference_no text,
  remarks text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (entry_status in ('draft', 'posted', 'cancelled')),
  check (entry_type in ('receipt', 'payment')),
  check (amount >= 0)
);

create index if not exists idx_finance_book_entries_book_id on finance_book_entries(finance_book_id);

alter table customer_receipts
add column if not exists finance_book_id integer references finance_books(id) on delete set null;

alter table vendor_payments
add column if not exists finance_book_id integer references finance_books(id) on delete set null;
