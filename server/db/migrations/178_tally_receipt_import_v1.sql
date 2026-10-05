-- 178: Tally Receipt Voucher → Josh Receipt Import (Parallel Operation Mode)

alter table customer_receipts
  add column if not exists receipt_source text not null default 'erp',
  add column if not exists tally_voucher_number text,
  add column if not exists tally_voucher_type text,
  add column if not exists tally_voucher_date date,
  add column if not exists tally_import_log_id bigint references tally_import_logs(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_receipts_receipt_source_check'
  ) then
    alter table customer_receipts
      add constraint customer_receipts_receipt_source_check
      check (receipt_source in ('erp', 'tally_import'));
  end if;
end $$;

create unique index if not exists idx_customer_receipts_company_tally_voucher_unique
  on customer_receipts(company_id, tally_voucher_number, tally_voucher_date)
  where tally_voucher_number is not null and receipt_source = 'tally_import';

create index if not exists idx_customer_receipts_tally_source
  on customer_receipts(company_id, receipt_source, receipt_date desc)
  where receipt_source = 'tally_import';

comment on column customer_receipts.receipt_source is 'erp = native Josh workflow; tally_import = created from Tally receipt voucher during parallel operation';
