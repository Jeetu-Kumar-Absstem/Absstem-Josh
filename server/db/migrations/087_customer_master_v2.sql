alter table customers
  add column if not exists legal_name text,
  add column if not exists website text,
  add column if not exists industry text;

create table if not exists customer_sites (
  id serial primary key,
  customer_id integer not null references customers(id) on delete cascade,
  site_code text,
  site_name text not null,
  site_type text not null default 'plant',
  address_line1 text,
  address_line2 text,
  address_line3 text,
  city text,
  state text,
  pincode text,
  country_id integer references countries(id),
  gst_status text not null default 'pending',
  can_quote boolean not null default true,
  can_dispatch boolean not null default true,
  can_bill boolean not null default true,
  is_default_quote_site boolean not null default false,
  is_default_ship_to boolean not null default false,
  is_default_bill_to boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (site_type in ('plant', 'ho', 'branch', 'warehouse', 'billing_office')),
  check (gst_status in ('pending', 'available', 'not_required'))
);

create unique index if not exists idx_customer_sites_code_unique
  on customer_sites(customer_id, lower(site_code))
  where site_code is not null;

create index if not exists idx_customer_sites_customer_id
  on customer_sites(customer_id, is_active);

alter table customer_contacts
  add column if not exists site_id integer references customer_sites(id) on delete set null,
  add column if not exists department text,
  add column if not exists is_active boolean not null default true;

create table if not exists customer_contact_roles (
  id serial primary key,
  customer_contact_id integer not null references customer_contacts(id) on delete cascade,
  role_key text not null,
  created_at timestamptz not null default now(),
  unique (customer_contact_id, role_key),
  check (role_key in (
    'sales_enquiry',
    'quote_recipient',
    'technical_discussion',
    'dispatch_logistics',
    'invoice_recipient',
    'payment_followup',
    'service_warranty'
  ))
);

create index if not exists idx_customer_contact_roles_contact
  on customer_contact_roles(customer_contact_id);

create table if not exists customer_tax_registrations (
  id serial primary key,
  customer_id integer not null references customers(id) on delete cascade,
  state text,
  gstin text,
  registration_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_customer_tax_registrations_gstin_unique
  on customer_tax_registrations(lower(gstin))
  where gstin is not null;

create index if not exists idx_customer_tax_registrations_customer
  on customer_tax_registrations(customer_id, is_active);

create table if not exists customer_site_tax_links (
  id serial primary key,
  site_id integer not null references customer_sites(id) on delete cascade,
  tax_registration_id integer not null references customer_tax_registrations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id)
);

create index if not exists idx_customer_site_tax_links_tax
  on customer_site_tax_links(tax_registration_id);

alter table quote_headers
  add column if not exists customer_site_id integer references customer_sites(id) on delete set null;

create index if not exists idx_quote_headers_customer_site_id
  on quote_headers(customer_site_id);
