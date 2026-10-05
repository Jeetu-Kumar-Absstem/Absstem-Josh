-- Switch company document numbering to Indian Financial Year (Apr–Mar).
-- Example: INV/26-27/000001
-- year_2 key becomes FY compact form e.g. '2627' (was calendar YY char(2)).

alter table document_sequences_company
  alter column year_2 type text using year_2::text;

create or replace function indian_financial_year_bounds(p_on date default current_date)
returns table (fy_start_year integer, fy_end_year integer, fy_key text, fy_label text)
language plpgsql
as $$
declare
  d date := coalesce(p_on, current_date);
  start_year integer;
begin
  if extract(month from d) >= 4 then
    start_year := extract(year from d)::integer;
  else
    start_year := extract(year from d)::integer - 1;
  end if;
  fy_start_year := start_year;
  fy_end_year := start_year + 1;
  fy_key := lpad((start_year % 100)::text, 2, '0') || lpad(((start_year + 1) % 100)::text, 2, '0');
  fy_label := lpad((start_year % 100)::text, 2, '0') || '-' || lpad(((start_year + 1) % 100)::text, 2, '0');
  return next;
end;
$$;

create or replace function next_company_document_number(p_company_id integer, p_document_type text)
returns text
language plpgsql
as $$
declare
  fy record;
  n integer;
  prefix text;
begin
  if p_company_id is null then
    raise exception 'company_id is required';
  end if;

  select * into fy from indian_financial_year_bounds(current_date);

  insert into document_sequences_company (company_id, document_type, year_2, current_number)
  values (p_company_id, p_document_type, fy.fy_key, 0)
  on conflict (company_id, document_type, year_2) do nothing;

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

  -- Statutory-friendly format: PREFIX/YY-YY/######
  return prefix || '/' || fy.fy_label || '/' || lpad(n::text, 6, '0');
end;
$$;
