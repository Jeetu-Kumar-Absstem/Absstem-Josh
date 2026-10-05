create table if not exists p_and_f_terms (
  id serial primary key,
  term_code text not null unique,
  term_name text not null,
  is_active boolean not null default true
);

insert into p_and_f_terms (term_code, term_name, is_active)
values
  ('EXTRA', 'Extra at Actuals', true),
  ('INCL', 'Included in Price', true),
  ('BUYER', 'To Buyer Account', true)
on conflict (term_code) do update
set
  term_name = excluded.term_name,
  is_active = excluded.is_active;

alter table quote_revisions
add column if not exists p_and_f_term_id integer references p_and_f_terms(id);

do $$
declare
  check_name text;
begin
  if exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'commercial_term_mappings'
      and con.conname = 'commercial_term_mappings_commercial_type_check'
  ) then
    execute 'alter table commercial_term_mappings drop constraint commercial_term_mappings_commercial_type_check';
  end if;

  select con.conname
  into check_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'commercial_term_mappings'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) like '%commercial_type%payment_term%freight_term%incoterm%tax_mode%';

  if check_name is not null then
    execute format('alter table commercial_term_mappings drop constraint %I', check_name);
  end if;
end $$;

alter table commercial_term_mappings
add constraint commercial_term_mappings_commercial_type_check
check (commercial_type in ('payment_term', 'freight_term', 'p_and_f_term', 'incoterm', 'tax_mode'));

insert into commercial_term_mappings (commercial_type, commercial_value, term_master_id, override_description, is_active)
select
  'p_and_f_term',
  pf.id::text,
  tm.id,
  pf.term_name,
  true
from p_and_f_terms pf
join terms_master tm
  on upper(trim(tm.caption)) in ('P&F', 'P&F TERMS', 'PACKING & FORWARDING', 'PACKING AND FORWARDING')
where pf.is_active = true
on conflict (commercial_type, commercial_value, term_master_id) do update
set
  override_description = excluded.override_description,
  is_active = excluded.is_active,
  updated_at = now();
