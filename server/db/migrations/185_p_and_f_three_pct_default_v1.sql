-- Align P&F commercial master with Terms Library default ("3% Extra.").
insert into p_and_f_terms (term_code, term_name, is_active)
values ('3%', '3% Extra', true)
on conflict (term_code) do update
set
  term_name = excluded.term_name,
  is_active = excluded.is_active;

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
where pf.term_code = '3%'
on conflict (commercial_type, commercial_value, term_master_id) do update
set
  override_description = excluded.override_description,
  is_active = excluded.is_active,
  updated_at = now();
