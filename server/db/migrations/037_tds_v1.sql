create table if not exists tds_sections (
  id serial primary key,
  section_code text not null unique,
  section_name text not null,
  default_rate numeric(9, 4) not null default 0,
  threshold_amount numeric(18, 2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (default_rate >= 0),
  check (threshold_amount >= 0)
);

alter table vendors
add column if not exists pan_no text,
add column if not exists tds_enabled boolean not null default false,
add column if not exists tds_section_id integer references tds_sections(id) on delete set null,
add column if not exists lower_deduction_rate numeric(9, 4),
add column if not exists tds_exempt boolean not null default false;

alter table vendor_payments
add column if not exists tds_section_id integer references tds_sections(id) on delete set null,
add column if not exists tds_base_amount numeric(18, 2) not null default 0,
add column if not exists tds_rate numeric(9, 4) not null default 0,
add column if not exists tds_amount numeric(18, 2) not null default 0,
add column if not exists net_payment_amount numeric(18, 2) not null default 0;
