-- P1b: E-invoice / IRN metadata readiness (manual capture + future GSP).

alter table customer_invoices
  add column if not exists einvoice_status text not null default 'none',
  add column if not exists einvoice_mode text,
  add column if not exists einvoice_provider text,
  add column if not exists einvoice_generated_at timestamptz,
  add column if not exists einvoice_generated_by integer references erp_users(id),
  add column if not exists einvoice_cancelled_at timestamptz,
  add column if not exists einvoice_cancel_reason text,
  add column if not exists einvoice_error text,
  add column if not exists signed_invoice_payload text,
  add column if not exists eway_bill_no text,
  add column if not exists eway_bill_date date,
  add column if not exists eway_valid_till timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_invoices_einvoice_status_check'
  ) then
    alter table customer_invoices
      add constraint customer_invoices_einvoice_status_check
      check (einvoice_status in ('none', 'pending', 'generated', 'cancelled', 'failed'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'customer_invoices_einvoice_mode_check'
  ) then
    alter table customer_invoices
      add constraint customer_invoices_einvoice_mode_check
      check (einvoice_mode is null or einvoice_mode in ('manual', 'gsp'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'customer_invoices_signed_qr_requires_irn_check'
  ) then
    alter table customer_invoices
      add constraint customer_invoices_signed_qr_requires_irn_check
      check (signed_qr_code is null or irn is not null);
  end if;
end $$;

create table if not exists einvoice_events (
  id serial primary key,
  company_id integer not null references companies(id) on delete restrict,
  customer_invoice_id integer not null references customer_invoices(id) on delete cascade,
  event_type text not null
    check (event_type in ('generate', 'cancel', 'manual_capture', 'payload_download', 'clear')),
  request_payload jsonb,
  response_payload jsonb,
  status text,
  error text,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_einvoice_events_invoice_created
  on einvoice_events (customer_invoice_id, created_at desc);

create index if not exists idx_einvoice_events_company_created
  on einvoice_events (company_id, created_at desc);

create table if not exists company_einvoice_settings (
  id serial primary key,
  company_id integer not null unique references companies(id) on delete cascade,
  provider text,
  seller_gstin text,
  base_url text,
  is_enabled boolean not null default false,
  credential_env_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
