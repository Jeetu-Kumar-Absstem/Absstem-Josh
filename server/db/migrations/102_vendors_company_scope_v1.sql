alter table vendors
  add column if not exists company_id integer;

update vendors
set company_id = coalesce(company_id, company_id_by_code('AI'))
where company_id is null;

alter table vendors
  alter column company_id set default company_id_by_code('AI');

alter table vendors
  alter column company_id set not null;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'vendors_company_id_fkey'
      and table_name = 'vendors'
  ) then
    alter table vendors
      add constraint vendors_company_id_fkey
      foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

alter table vendors
  drop constraint if exists vendors_vendor_code_key;

drop index if exists idx_vendors_vendor_code_unique;

create unique index if not exists idx_vendors_company_vendor_code_unique
  on vendors(company_id, vendor_code)
  where vendor_code is not null and length(trim(vendor_code)) > 0;

create index if not exists idx_vendors_company_id
  on vendors(company_id);
