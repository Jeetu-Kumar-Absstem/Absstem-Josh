create table if not exists customer_ar_adjustments (
  id serial primary key,
  company_id integer references companies(id) on delete restrict,
  distributor_id integer references distributors(id) on delete restrict,
  customer_id integer not null references customers(id) on delete restrict,
  customer_invoice_id integer not null references customer_invoices(id) on delete restrict,
  adjustment_type text not null,
  adjustment_status text not null default 'draft',
  adjustment_amount numeric(14, 2) not null default 0,
  reason text not null,
  remarks text,
  created_by integer references erp_users(id),
  posted_by integer references erp_users(id),
  posted_at timestamptz,
  cancelled_by integer references erp_users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (adjustment_type in ('commercial_credit_note', 'short_payment_adjustment', 'write_off')),
  check (adjustment_status in ('draft', 'posted', 'cancelled')),
  check (adjustment_amount >= 0)
);

create index if not exists idx_customer_ar_adjustments_company_id
on customer_ar_adjustments(company_id);

create index if not exists idx_customer_ar_adjustments_distributor_id
on customer_ar_adjustments(distributor_id);

create index if not exists idx_customer_ar_adjustments_customer_id
on customer_ar_adjustments(customer_id);

create index if not exists idx_customer_ar_adjustments_invoice_id
on customer_ar_adjustments(customer_invoice_id);

create index if not exists idx_customer_ar_adjustments_status
on customer_ar_adjustments(adjustment_status);
