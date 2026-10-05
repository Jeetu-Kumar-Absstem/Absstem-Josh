create table if not exists companies (
  id serial primary key,
  company_code text not null unique,
  legal_name text not null,
  display_name text,
  gstin text,
  pan text,
  address_line1 text,
  address_line2 text,
  address_line3 text,
  city text,
  state text,
  state_code text,
  pincode text,
  country text,
  contact_email text,
  contact_phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(company_code)) > 0)
);

insert into companies (company_code, legal_name, display_name)
values
  ('AT', 'Absstem Technologies LLP', 'Absstem Technologies (AT)'),
  ('AI', 'Absstem Industrial Solutions Private Limited', 'Absstem Industrial (AI)')
on conflict (company_code) do nothing;

create or replace function company_id_by_code(p_company_code text)
returns integer
language sql
stable
as $$
  select c.id
  from companies c
  where c.company_code = p_company_code
  limit 1;
$$;

create table if not exists user_company_memberships (
  id serial primary key,
  user_id integer not null references erp_users(id) on delete cascade,
  company_id integer not null references companies(id) on delete cascade,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create index if not exists idx_user_company_memberships_user_id on user_company_memberships(user_id);
create index if not exists idx_user_company_memberships_company_id on user_company_memberships(company_id);

create table if not exists company_profiles_v2 (
  company_id integer primary key references companies(id) on delete cascade,
  company_name text not null,
  address_line1 text,
  address_line2 text,
  address_line3 text,
  city text,
  state text,
  state_code text,
  pincode text,
  country text,
  gstin text,
  pan text,
  contact_name text,
  contact_email text,
  contact_phone text,
  bank_name text,
  bank_branch text,
  account_name text,
  account_no text,
  ifsc text,
  invoice_declaration text,
  updated_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into company_profiles_v2 (
  company_id,
  company_name,
  address_line1,
  address_line2,
  address_line3,
  city,
  state,
  state_code,
  pincode,
  country,
  gstin,
  pan,
  contact_name,
  contact_email,
  contact_phone,
  bank_name,
  bank_branch,
  account_name,
  account_no,
  ifsc,
  invoice_declaration,
  updated_by,
  created_at,
  updated_at
)
select
  company_id_by_code('AI') as company_id,
  cp.company_name,
  cp.address_line1,
  cp.address_line2,
  cp.address_line3,
  cp.city,
  cp.state,
  cp.state_code,
  cp.pincode,
  cp.country,
  cp.gstin,
  cp.pan,
  cp.contact_name,
  cp.contact_email,
  cp.contact_phone,
  cp.bank_name,
  cp.bank_branch,
  cp.account_name,
  cp.account_no,
  cp.ifsc,
  cp.invoice_declaration,
  cp.updated_by,
  cp.created_at,
  cp.updated_at
from company_profiles cp
where cp.id = 1
  and company_id_by_code('AI') is not null
  and not exists (
    select 1 from company_profiles_v2 x where x.company_id = company_id_by_code('AI')
  );

insert into company_profiles_v2 (company_id, company_name)
select company_id_by_code('AT'), 'Absstem Technologies LLP'
where company_id_by_code('AT') is not null
  and not exists (select 1 from company_profiles_v2 x where x.company_id = company_id_by_code('AT'));

create table if not exists company_template_overrides (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  template_key text not null,
  template_id integer not null references document_templates(id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, template_key)
);

create index if not exists idx_company_template_overrides_company_id on company_template_overrides(company_id);

create table if not exists document_sequences_company (
  company_id integer not null references companies(id) on delete cascade,
  document_type text not null,
  year_2 char(2) not null,
  current_number integer not null default 0,
  primary key (company_id, document_type, year_2)
);

create or replace function next_company_document_number(p_company_id integer, p_document_type text)
returns text
language plpgsql
as $$
declare
  y char(2);
  n integer;
  prefix text;
begin
  if p_company_id is null then
    raise exception 'company_id is required';
  end if;

  y := to_char(current_date, 'YY');

  insert into document_sequences_company (company_id, document_type, year_2, current_number)
  values (p_company_id, p_document_type, y, 0)
  on conflict (company_id, document_type, year_2) do nothing;

  update document_sequences_company
  set current_number = current_number + 1
  where company_id = p_company_id and document_type = p_document_type and year_2 = y
  returning current_number into n;

  if p_document_type = 'QUOTE' then
    prefix := 'Q';
  else
    prefix := p_document_type;
  end if;

  return prefix || y || lpad(n::text, 6, '0');
end;
$$;

