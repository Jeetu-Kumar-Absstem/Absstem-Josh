alter table quote_headers
  add column if not exists service_warranty_case_id integer references service_warranty_cases(id) on delete set null,
  add column if not exists amc_contract_id integer references amc_contracts(id) on delete set null,
  add column if not exists quote_origin text not null default 'standard';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'quote_headers_quote_origin_check'
  ) then
    alter table quote_headers
      add constraint quote_headers_quote_origin_check
      check (quote_origin in ('standard', 'service_aftermarket', 'amc_aftermarket'));
  end if;
end $$;

create index if not exists idx_quote_headers_service_case_id on quote_headers(service_warranty_case_id);
create index if not exists idx_quote_headers_amc_contract_id on quote_headers(amc_contract_id);
create index if not exists idx_quote_headers_quote_origin on quote_headers(quote_origin);
