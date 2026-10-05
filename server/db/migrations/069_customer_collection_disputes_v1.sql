create table if not exists customer_collection_disputes (
  id serial primary key,
  company_id integer references companies(id) on delete restrict,
  distributor_id integer references distributors(id) on delete restrict,
  customer_id integer not null references customers(id) on delete restrict,
  customer_invoice_id integer references customer_invoices(id) on delete restrict,
  dispute_status text not null default 'open',
  dispute_reason text not null,
  disputed_amount numeric(14, 2) not null default 0,
  opened_on date not null default current_date,
  expected_resolution_date date,
  remarks text,
  resolution_notes text,
  created_by integer references erp_users(id),
  resolved_by integer references erp_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (dispute_status in ('open', 'escalated', 'resolved')),
  check (disputed_amount >= 0)
);

create index if not exists idx_customer_collection_disputes_company_id
on customer_collection_disputes(company_id);

create index if not exists idx_customer_collection_disputes_distributor_id
on customer_collection_disputes(distributor_id);

create index if not exists idx_customer_collection_disputes_customer_id
on customer_collection_disputes(customer_id);

create index if not exists idx_customer_collection_disputes_invoice_id
on customer_collection_disputes(customer_invoice_id);

create index if not exists idx_customer_collection_disputes_status
on customer_collection_disputes(dispute_status);
