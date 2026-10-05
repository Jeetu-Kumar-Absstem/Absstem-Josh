create table if not exists engineering_requests (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  request_type text not null check (request_type in ('client_datasheet', 'npd', 'drawing', 'technical_data', 'bom_release')),
  request_title text not null,
  request_status text not null default 'new' check (request_status in ('new', 'in_review', 'waiting_input', 'ready', 'closed', 'cancelled')),
  request_priority text not null default 'normal' check (request_priority in ('critical', 'high', 'normal', 'low')),
  source_desk text not null default 'engineering' check (source_desk in ('sales', 'engineering', 'manufacturing', 'quality', 'service', 'purchase', 'admin', 'other')),
  requester_user_id integer references erp_users(id) on delete set null,
  assigned_to_user_id integer references erp_users(id) on delete set null,
  customer_name text,
  product_code text,
  product_name text,
  reference_no text,
  requested_due_date date,
  request_details text,
  attachment_note text,
  payload jsonb not null default '{}'::jsonb,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists engineering_requests_company_created_idx
  on engineering_requests (company_id, created_at desc);

create index if not exists engineering_requests_company_status_idx
  on engineering_requests (company_id, request_status);

create index if not exists engineering_requests_company_type_idx
  on engineering_requests (company_id, request_type);

create index if not exists engineering_requests_company_due_idx
  on engineering_requests (company_id, requested_due_date);
