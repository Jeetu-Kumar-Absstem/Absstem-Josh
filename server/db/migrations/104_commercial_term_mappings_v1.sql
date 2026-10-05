create table if not exists commercial_term_mappings (
  id serial primary key,
  commercial_type text not null,
  commercial_value text not null,
  term_master_id integer not null references terms_master(id) on delete cascade,
  override_description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (commercial_type, commercial_value, term_master_id),
  check (commercial_type in ('payment_term', 'freight_term', 'incoterm', 'tax_mode'))
);

create index if not exists idx_commercial_term_mappings_lookup
  on commercial_term_mappings(commercial_type, commercial_value, is_active);

insert into commercial_term_mappings (commercial_type, commercial_value, term_master_id, override_description, is_active)
select
  'payment_term',
  pt.id::text,
  tm.id,
  pt.term_name,
  true
from payment_terms pt
join terms_master tm on upper(trim(tm.caption)) = 'PAYMENT TERMS'
where pt.is_active = true
on conflict (commercial_type, commercial_value, term_master_id) do update
set
  override_description = excluded.override_description,
  is_active = excluded.is_active,
  updated_at = now();

insert into commercial_term_mappings (commercial_type, commercial_value, term_master_id, override_description, is_active)
select
  'freight_term',
  ft.id::text,
  tm.id,
  ft.term_name,
  true
from freight_terms ft
join terms_master tm on upper(trim(tm.caption)) in ('FREIGHT', 'FREIGHT TERMS')
where ft.is_active = true
on conflict (commercial_type, commercial_value, term_master_id) do update
set
  override_description = excluded.override_description,
  is_active = excluded.is_active,
  updated_at = now();

insert into commercial_term_mappings (commercial_type, commercial_value, term_master_id, override_description, is_active)
select
  'tax_mode',
  src.tax_mode,
  tm.id,
  src.description,
  true
from (
  values
    ('domestic', 'GST as per the commercial table. Final levy shall be reflected as IGST or CGST/SGST at invoice stage based on place of supply.'),
    ('export', 'GST as applicable for export supply. Final levy shall be applied at invoice stage as per statutory requirements.')
) src(tax_mode, description)
join terms_master tm on upper(trim(tm.caption)) in ('GST', 'TAX', 'TAXES')
on conflict (commercial_type, commercial_value, term_master_id) do update
set
  override_description = excluded.override_description,
  is_active = excluded.is_active,
  updated_at = now();
