alter table quote_headers
add column if not exists lead_id integer;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_name = 'quote_headers'
      and constraint_name = 'quote_headers_lead_id_fkey'
  ) then
    alter table quote_headers
      add constraint quote_headers_lead_id_fkey
      foreign key (lead_id) references leads(id) on delete set null;
  end if;
end $$;

create index if not exists idx_quote_headers_lead_id on quote_headers(lead_id);

alter table leads add column if not exists legacy_lead_no text;
alter table leads add column if not exists legacy_quote_no text;
alter table leads add column if not exists legacy_sales_order_no text;
alter table leads add column if not exists legacy_customer_code text;
alter table leads add column if not exists legacy_status_raw text;
alter table leads add column if not exists legacy_owner_raw text;
alter table leads add column if not exists legacy_follow_up_at timestamptz;
alter table leads add column if not exists legacy_created_at timestamptz;
alter table leads add column if not exists legacy_updated_at timestamptz;
alter table leads add column if not exists legacy_import_batch text;
alter table leads add column if not exists legacy_match_confidence text;
alter table leads add column if not exists close_reason text;
alter table leads add column if not exists converted_quote_id integer;
alter table leads add column if not exists converted_to_quote_at timestamptz;
alter table leads add column if not exists converted_customer_id integer;
alter table leads add column if not exists converted_sales_order_id integer;
alter table leads add column if not exists converted_to_order_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where table_name = 'leads'
      and constraint_name = 'leads_converted_quote_id_fkey'
  ) then
    alter table leads
      add constraint leads_converted_quote_id_fkey
      foreign key (converted_quote_id) references quote_headers(id) on delete set null;
  end if;

  if not exists (
    select 1
    from information_schema.table_constraints
    where table_name = 'leads'
      and constraint_name = 'leads_converted_customer_id_fkey'
  ) then
    alter table leads
      add constraint leads_converted_customer_id_fkey
      foreign key (converted_customer_id) references customers(id) on delete set null;
  end if;

  if not exists (
    select 1
    from information_schema.table_constraints
    where table_name = 'leads'
      and constraint_name = 'leads_converted_sales_order_id_fkey'
  ) then
    alter table leads
      add constraint leads_converted_sales_order_id_fkey
      foreign key (converted_sales_order_id) references sales_orders(id) on delete set null;
  end if;
end $$;

create unique index if not exists idx_leads_legacy_lead_no_unique
  on leads(legacy_lead_no)
  where legacy_lead_no is not null;

create index if not exists idx_leads_legacy_quote_no on leads(legacy_quote_no);
create index if not exists idx_leads_legacy_customer_code on leads(legacy_customer_code);
create index if not exists idx_leads_legacy_import_batch on leads(legacy_import_batch);
create index if not exists idx_leads_converted_quote_id on leads(converted_quote_id);
create index if not exists idx_leads_converted_sales_order_id on leads(converted_sales_order_id);

create table if not exists legacy_import_batches (
  import_key text primary key,
  source_folder text,
  dry_run boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create table if not exists legacy_users_staging (
  batch_key text not null references legacy_import_batches(import_key) on delete cascade,
  row_no integer not null,
  user_code text,
  full_name text,
  email text,
  phone text,
  user_group_name text,
  reporting_head_1 text,
  reporting_head_2 text,
  organisation_name text,
  active text,
  super_admin text,
  raw jsonb not null default '{}'::jsonb,
  primary key (batch_key, row_no)
);

create index if not exists idx_legacy_users_staging_batch_user_code
  on legacy_users_staging(batch_key, user_code);

create table if not exists legacy_customers_staging (
  batch_key text not null references legacy_import_batches(import_key) on delete cascade,
  row_no integer not null,
  customer_code text,
  customer_name text,
  city_name text,
  state_name text,
  phone_no text,
  email text,
  active text,
  account_manager text,
  raw jsonb not null default '{}'::jsonb,
  primary key (batch_key, row_no)
);

create index if not exists idx_legacy_customers_staging_batch_customer_code
  on legacy_customers_staging(batch_key, customer_code);

create table if not exists legacy_leads_staging (
  batch_key text not null references legacy_import_batches(import_key) on delete cascade,
  row_no integer not null,
  legacy_lead_no text,
  legacy_quote_no text,
  lead_manager_code text,
  lead_manager_name text,
  company_name text,
  prospect_code text,
  title text,
  contact_name text,
  city text,
  state text,
  country text,
  mobile_no text,
  email text,
  lead_source_name text,
  lead_date timestamptz,
  follow_up_date timestamptz,
  follow_up_remarks text,
  final_status_remarks text,
  category text,
  group_name text,
  item_name text,
  industry text,
  requirement text,
  created_by_code text,
  created_by_name text,
  created_at_legacy timestamptz,
  modified_by_code text,
  modified_by_name text,
  modified_at_legacy timestamptz,
  status_raw text,
  mailing_status text,
  raw jsonb not null default '{}'::jsonb,
  primary key (batch_key, row_no)
);

create index if not exists idx_legacy_leads_staging_batch_lead_no
  on legacy_leads_staging(batch_key, legacy_lead_no);
create index if not exists idx_legacy_leads_staging_batch_quote_no
  on legacy_leads_staging(batch_key, legacy_quote_no);

create table if not exists legacy_quotes_staging (
  batch_key text not null references legacy_import_batches(import_key) on delete cascade,
  row_no integer not null,
  quotation_no text,
  legacy_lead_no text,
  quotation_date timestamptz,
  customer_name text,
  customer_code text,
  contact_person text,
  contact_no text,
  contact_email text,
  salesperson_code text,
  salesperson_name text,
  group_name text,
  quantity numeric(18, 4),
  subtotal numeric(18, 2),
  gst_rate numeric(10, 4),
  gst_amount numeric(18, 2),
  total_price numeric(18, 2),
  city text,
  state text,
  quotation_remarks text,
  follow_up_date timestamptz,
  follow_up_remarks text,
  status_raw text,
  final_remarks text,
  raw jsonb not null default '{}'::jsonb,
  primary key (batch_key, row_no)
);

create index if not exists idx_legacy_quotes_staging_batch_quotation_no
  on legacy_quotes_staging(batch_key, quotation_no);
create index if not exists idx_legacy_quotes_staging_batch_lead_no
  on legacy_quotes_staging(batch_key, legacy_lead_no);

create table if not exists legacy_sales_orders_staging (
  batch_key text not null references legacy_import_batches(import_key) on delete cascade,
  row_no integer not null,
  so_no text,
  so_date timestamptz,
  customer_name text,
  customer_code text,
  salesperson_code text,
  salesperson_name text,
  group_name text,
  status_raw text,
  so_remarks text,
  city text,
  state text,
  job_no text,
  raw jsonb not null default '{}'::jsonb,
  primary key (batch_key, row_no)
);

create index if not exists idx_legacy_sales_orders_staging_batch_so_no
  on legacy_sales_orders_staging(batch_key, so_no);
create index if not exists idx_legacy_sales_orders_staging_batch_customer_code
  on legacy_sales_orders_staging(batch_key, customer_code);
