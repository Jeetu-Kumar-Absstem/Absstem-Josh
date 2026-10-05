create table if not exists vendors (
  id serial primary key,
  vendor_code text unique,
  company_name text not null,
  country_id integer references countries(id),
  gstin text,
  contact_name text,
  contact_email citext,
  contact_phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
