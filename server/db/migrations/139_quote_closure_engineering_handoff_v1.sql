-- Quote win/loss closure reasons (global master) + engineering handoff link

create table if not exists quote_closure_reasons (
  id serial primary key,
  reason_code text not null unique,
  reason_name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists idx_quote_closure_reasons_is_active
  on quote_closure_reasons (is_active);

create index if not exists idx_quote_closure_reasons_sort
  on quote_closure_reasons (sort_order, reason_name);

insert into quote_closure_reasons (reason_code, reason_name, sort_order, is_active)
values
  ('lost_competitor', 'Lost to competitor', 10, true),
  ('price', 'Price', 20, true),
  ('project_cancelled', 'Project cancelled', 30, true),
  ('spec_change', 'Spec change', 40, true),
  ('won_elsewhere', 'Won elsewhere', 50, true),
  ('other', 'Other', 90, true)
on conflict (reason_code) do update
set
  reason_name = excluded.reason_name,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  updated_at = now();

alter table quote_headers
  add column if not exists closure_reason_id integer references quote_closure_reasons(id) on delete set null;

alter table quote_headers
  add column if not exists closure_remarks text;

create index if not exists idx_quote_headers_closure_reason
  on quote_headers (closure_reason_id)
  where closure_reason_id is not null;

alter table engineering_requests
  add column if not exists quote_header_id integer references quote_headers(id) on delete set null;

create index if not exists engineering_requests_quote_header_idx
  on engineering_requests (quote_header_id)
  where quote_header_id is not null;

alter table attachments
  drop constraint if exists attachments_owner_type_check;

alter table attachments
  add constraint attachments_owner_type_check
  check (
    owner_type in (
      'legacy',
      'template',
      'quote_document',
      'dispatch_pod',
      'company_profile',
      'quote_mail_attachment',
      'expense_receipt',
      'pilot_screenshot',
      'service_signed_report',
      'quote_customer_datasheet',
      'quote_engineering_datasheet'
    )
  );
