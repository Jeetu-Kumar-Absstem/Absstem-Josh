alter table quote_headers
  add column if not exists ship_to_customer_site_id integer references customer_sites(id) on delete set null,
  add column if not exists bill_to_name text,
  add column if not exists bill_to_address text,
  add column if not exists ship_to_name text,
  add column if not exists ship_to_address text;

alter table sales_orders
  add column if not exists ship_to_customer_site_id integer references customer_sites(id) on delete set null,
  add column if not exists bill_to_name text,
  add column if not exists bill_to_address text,
  add column if not exists ship_to_name text,
  add column if not exists ship_to_address text;

alter table dispatches
  add column if not exists ship_to_customer_site_id integer references customer_sites(id) on delete set null,
  add column if not exists bill_to_name text,
  add column if not exists bill_to_address text,
  add column if not exists ship_to_name text,
  add column if not exists ship_to_address text;
