-- 190: Document numbering policy for AI cutover
-- - SO:    Clan legacy S26000073 (unchanged)
-- - QUOTE: Clan compact Q25000416 (calendar YY + 6-digit serial)
-- - INV:   Tally-style INV-{company_code}/YY-YY/{n} e.g. INV-AI/26-27/46
-- - other: PREFIX/YY-YY/###### (unchanged)

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
  company_code text;
  cal_yy text;
  seq_year text;
  inv_prefix text;
  inv_max integer;
  quote_max integer;
begin
  if p_company_id is null then
    raise exception 'company_id is required';
  end if;

  select * into fy from indian_financial_year_bounds(current_date);
  cal_yy := to_char(current_date, 'YY');

  -- Quote sequences key off calendar YY (Clan); everything else uses FY key.
  if p_document_type = 'QUOTE' then
    seq_year := cal_yy;
  else
    seq_year := fy.fy_key;
  end if;

  insert into document_sequences_company (company_id, document_type, year_2, current_number)
  values (p_company_id, p_document_type, seq_year, 0)
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
      and year_2 = seq_year;

    update document_sequences_company
    set current_number = current_number + 1
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = seq_year
    returning current_number into n;

    return legacy_so_prefix || lpad(n::text, 6, '0');
  end if;

  if p_document_type = 'QUOTE' then
    select coalesce(max(right(qh.quote_number, 6)::integer), 0)
      into quote_max
    from quote_headers qh
    where qh.company_id = p_company_id
      and qh.quote_number ~ ('^Q' || cal_yy || '[0-9]{6}$');

    update document_sequences_company
    set current_number = greatest(current_number, quote_max)
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = seq_year;

    update document_sequences_company
    set current_number = current_number + 1
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = seq_year
    returning current_number into n;

    return 'Q' || cal_yy || lpad(n::text, 6, '0');
  end if;

  if p_document_type = 'INV' then
    select upper(trim(c.company_code))
      into company_code
    from companies c
    where c.id = p_company_id
    limit 1;

    if company_code is null or company_code = '' then
      raise exception 'company_code is required for INV numbering';
    end if;

    inv_prefix := 'INV-' || company_code || '/' || fy.fy_label || '/';

    select coalesce(
      max(
        case
          when ci.invoice_number ~ ('^' || inv_prefix || '[0-9]+$')
            then substring(ci.invoice_number from length(inv_prefix) + 1)::integer
          else 0
        end
      ),
      0
    )
      into inv_max
    from customer_invoices ci
    where ci.company_id = p_company_id;

    update document_sequences_company
    set current_number = greatest(current_number, inv_max)
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = seq_year;

    update document_sequences_company
    set current_number = current_number + 1
    where company_id = p_company_id
      and document_type = p_document_type
      and year_2 = seq_year
    returning current_number into n;

    -- Match Tally style (INV-AI/26-27/46) — no forced 6-digit pad.
    return inv_prefix || n::text;
  end if;

  update document_sequences_company
  set current_number = current_number + 1
  where company_id = p_company_id
    and document_type = p_document_type
    and year_2 = seq_year
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
  'Company document numbers. SO=Clan S26000073; QUOTE=Clan Q25000416; INV=Tally INV-{code}/YY-YY/n; else PREFIX/YY-YY/######.';

-- Seed INV counters from existing Tally-style invoice numbers in the current FY.
insert into document_sequences_company (company_id, document_type, year_2, current_number)
select
  ci.company_id,
  'INV'::text as document_type,
  fy.fy_key,
  coalesce(
    max(
      case
        when ci.invoice_number ~ ('^INV-' || upper(trim(c.company_code)) || '/' || fy.fy_label || '/[0-9]+$')
          then substring(
            ci.invoice_number
            from length('INV-' || upper(trim(c.company_code)) || '/' || fy.fy_label || '/') + 1
          )::integer
        else 0
      end
    ),
    0
  ) as current_number
from customer_invoices ci
join companies c on c.id = ci.company_id
cross join lateral indian_financial_year_bounds(coalesce(ci.invoice_date, current_date)) fy
group by ci.company_id, fy.fy_key, fy.fy_label, c.company_code
on conflict (company_id, document_type, year_2) do update
set current_number = greatest(document_sequences_company.current_number, excluded.current_number);

-- Seed QUOTE counters from Clan-compact quote numbers for calendar years present.
insert into document_sequences_company (company_id, document_type, year_2, current_number)
select
  qh.company_id,
  'QUOTE'::text as document_type,
  substring(qh.quote_number from 2 for 2) as year_2,
  coalesce(max(right(qh.quote_number, 6)::integer), 0) as current_number
from quote_headers qh
where qh.quote_number ~ '^Q[0-9]{2}[0-9]{6}$'
group by qh.company_id, substring(qh.quote_number from 2 for 2)
on conflict (company_id, document_type, year_2) do update
set current_number = greatest(document_sequences_company.current_number, excluded.current_number);
