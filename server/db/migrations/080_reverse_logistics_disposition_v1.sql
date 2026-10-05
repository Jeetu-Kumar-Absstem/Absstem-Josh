alter table sales_return_lines
add column if not exists qty_accepted numeric(18, 4) not null default 0,
add column if not exists qty_scrapped numeric(18, 4) not null default 0,
add column if not exists disposition_date date,
add column if not exists disposition_remarks text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sales_return_lines_disposition_check'
  ) then
    alter table sales_return_lines
    add constraint sales_return_lines_disposition_check
    check (qty_accepted >= 0 and qty_scrapped >= 0 and (qty_accepted + qty_scrapped) <= qty_return);
  end if;
end $$;

alter table service_warranty_case_lines
add column if not exists qty_accepted numeric(18, 4) not null default 0,
add column if not exists qty_scrapped numeric(18, 4) not null default 0,
add column if not exists disposition_date date,
add column if not exists disposition_remarks text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'service_warranty_case_lines_disposition_check'
  ) then
    alter table service_warranty_case_lines
    add constraint service_warranty_case_lines_disposition_check
    check (qty_accepted >= 0 and qty_scrapped >= 0);
  end if;
end $$;
