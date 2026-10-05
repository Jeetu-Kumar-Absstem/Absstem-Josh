create table if not exists customer_return_rework_jobs (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  source_type text not null,
  source_id integer not null,
  source_line_id integer not null,
  product_id integer not null references products(id) on delete restrict,
  qty_planned numeric(18, 4) not null default 0,
  job_card_id integer references job_cards(id) on delete set null,
  remarks text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_type in ('sales_return', 'service_warranty')),
  check (qty_planned >= 0)
);

create index if not exists idx_customer_return_rework_jobs_company_id on customer_return_rework_jobs(company_id);
create index if not exists idx_customer_return_rework_jobs_job_card_id on customer_return_rework_jobs(job_card_id);
create index if not exists idx_customer_return_rework_jobs_source on customer_return_rework_jobs(company_id, source_type, source_id, source_line_id);
