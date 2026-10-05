create table if not exists customer_company_links (
  id serial primary key,
  customer_id integer not null references customers(id) on delete cascade,
  company_id integer not null references companies(id) on delete cascade,
  ownership_type text not null default 'legacy_shared',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, company_id),
  check (ownership_type in ('owned', 'shared', 'legacy_shared'))
);

create index if not exists idx_customer_company_links_customer_id
  on customer_company_links(customer_id);

create index if not exists idx_customer_company_links_company_id
  on customer_company_links(company_id);

insert into customer_company_links (customer_id, company_id, ownership_type, is_active)
select distinct x.customer_id, x.company_id, 'legacy_shared', true
from (
  select customer_id, company_id from leads where customer_id is not null and company_id is not null
  union
  select converted_customer_id as customer_id, company_id from leads where converted_customer_id is not null and company_id is not null
  union
  select customer_id, company_id from quote_headers where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from sales_orders where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from dispatches where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from customer_invoices where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from customer_receipts where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from sales_returns where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from service_warranty_cases where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from amc_contracts where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from customer_collection_actions where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from customer_collection_disputes where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from customer_ar_adjustments where customer_id is not null and company_id is not null
  union
  select customer_id, company_id from customer_credit_releases where customer_id is not null and company_id is not null
) x
on conflict (customer_id, company_id) do nothing;
