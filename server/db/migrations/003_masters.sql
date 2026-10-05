create table if not exists countries (
  id serial primary key,
  iso_code char(2) not null unique,
  country_name text not null,
  is_active boolean not null default true
);

create table if not exists currencies (
  id serial primary key,
  currency_code char(3) not null unique,
  currency_name text not null,
  symbol text,
  decimal_precision smallint not null default 2,
  is_active boolean not null default true
);

create table if not exists incoterms (
  id serial primary key,
  incoterm_code text not null unique,
  incoterm_name text not null,
  is_active boolean not null default true
);

create table if not exists payment_terms (
  id serial primary key,
  term_code text not null unique,
  term_name text not null,
  credit_days integer,
  is_active boolean not null default true
);

create table if not exists freight_terms (
  id serial primary key,
  term_code text not null unique,
  term_name text not null,
  is_active boolean not null default true
);

create table if not exists tax_codes (
  id serial primary key,
  tax_code text not null unique,
  tax_name text not null,
  tax_rate numeric(7, 4) not null default 0,
  is_active boolean not null default true
);

create table if not exists document_sequences (
  document_type text not null,
  year_2 char(2) not null,
  current_number integer not null default 0,
  primary key (document_type, year_2)
);

create or replace function next_document_number(p_document_type text)
returns text
language plpgsql
as $$
declare
  y char(2);
  n integer;
  prefix text;
begin
  y := to_char(current_date, 'YY');
  insert into document_sequences (document_type, year_2, current_number)
  values (p_document_type, y, 0)
  on conflict (document_type, year_2) do nothing;

  update document_sequences
  set current_number = current_number + 1
  where document_type = p_document_type and year_2 = y
  returning current_number into n;

  if p_document_type = 'QUOTE' then
    prefix := 'Q';
  else
    prefix := p_document_type;
  end if;

  return prefix || y || lpad(n::text, 6, '0');
end;
$$;

create table if not exists distributors (
  id serial primary key,
  distributor_code text unique,
  company_name text not null,
  country_id integer references countries(id),
  contact_email citext,
  contact_phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customers (
  id serial primary key,
  customer_code text unique,
  customer_name text not null,
  address_line1 text,
  address_line2 text,
  address_line3 text,
  city text,
  state text,
  pincode text,
  country_id integer references countries(id),
  gstin text,
  email citext,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customer_contacts (
  id serial primary key,
  customer_id integer not null references customers(id) on delete cascade,
  full_name text not null,
  email citext,
  phone text,
  designation text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_customers_country_id on customers(country_id);
create index if not exists idx_customer_contacts_customer_id on customer_contacts(customer_id);
