alter table customer_contacts
  add column if not exists salutation text;

alter table customers
  add column if not exists merged_into_customer_id integer references customers(id) on delete set null,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_by integer references erp_users(id) on delete set null;

create index if not exists idx_customers_merged_into_customer_id
  on customers(merged_into_customer_id);

