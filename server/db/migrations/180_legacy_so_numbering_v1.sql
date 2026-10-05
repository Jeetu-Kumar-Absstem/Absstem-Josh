-- Legacy commercial SO numbering: S26000073 (S + FY-start-YY + 6-digit serial).
-- Matches SalesOrderReport / legacy ERP format used for Tally chain-linking.

create or replace function next_company_document_number(p_company_id integer, p_document_type text)
returns text
language plpgsql
as $$
declare
  fy record;
  n integer;
  prefix text;
  legacy_so_prefix text;
  legacy_max integer;
begin
  if p_company_id is null then
    raise exception 'company_id is required';
  end if;

  select * into fy from indian_financial_year_bounds(current_date);

  insert into document_sequences_company (company_id, document_type, year_2, current_number)
  values (p_company_id, p_document_type, fy.fy_key, 0)
  on conflict (company_id, document_type, year_2) do nothing;

  if p_document_type = 'SO' then
    legacy_so_prefix := 'S' || left(fy.fy_key, 2);

    select coalesce(max(right(so.so_number, 6)::integer), 0)
      into legacy_max
    from sales_orders so
    where so.company_id = p_company_id
      and so.so_number ~ ('^' || legacy_so_prefix || '[0-9]{6}$');

    update document_sequences_company
    set current_number = greatest(current_number, legacy_max)
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = fy.fy_key;

    update document_sequences_company
    set current_number = current_number + 1
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = fy.fy_key
    returning current_number into n;

    return legacy_so_prefix || lpad(n::text, 6, '0');
  end if;

  update document_sequences_company
  set current_number = current_number + 1
  where company_id = p_company_id
    and document_type = p_document_type
    and year_2 = fy.fy_key
  returning current_number into n;

  if p_document_type = 'QUOTE' then
    prefix := 'Q';
  else
    prefix := p_document_type;
  end if;

  return prefix || '/' || fy.fy_label || '/' || lpad(n::text, 6, '0');
end;
$$;

comment on function next_company_document_number(integer, text) is
  'Company document numbers. SO uses legacy S26000073 format; other types use PREFIX/YY-YY/######.';

-- Align current FY SO counters with any legacy-format SOs already in the table.
insert into document_sequences_company (company_id, document_type, year_2, current_number)
select
  so.company_id,
  'SO'::text as document_type,
  fy.fy_key,
  coalesce(max(right(so.so_number, 6)::integer), 0) as current_number
from sales_orders so
cross join lateral indian_financial_year_bounds(coalesce(so.order_date, current_date)) fy
where so.so_number ~ ('^S' || left(fy.fy_key, 2) || '[0-9]{6}$')
group by so.company_id, fy.fy_key
on conflict (company_id, document_type, year_2) do update
set current_number = greatest(document_sequences_company.current_number, excluded.current_number);
