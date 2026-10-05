-- 177: Tally Sales Voucher → Josh Invoice Import (Parallel Operation Mode)

-- Allow invoices created directly from Tally without a sales order linkage
alter table customer_invoices alter column sales_order_id drop not null;

alter table customer_invoices
  add column if not exists invoice_source text not null default 'erp',
  add column if not exists tally_voucher_number text,
  add column if not exists tally_voucher_type text,
  add column if not exists tally_voucher_date date,
  add column if not exists tally_import_log_id bigint references tally_import_logs(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_invoices_invoice_source_check'
  ) then
    alter table customer_invoices
      add constraint customer_invoices_invoice_source_check
      check (invoice_source in ('erp', 'tally_import'));
  end if;
end $$;

create unique index if not exists idx_customer_invoices_company_tally_voucher_unique
  on customer_invoices(company_id, tally_voucher_number, tally_voucher_date)
  where tally_voucher_number is not null and invoice_source = 'tally_import';

create index if not exists idx_customer_invoices_tally_source
  on customer_invoices(company_id, invoice_source, invoice_date desc)
  where invoice_source = 'tally_import';

comment on column customer_invoices.invoice_source is 'erp = native Josh workflow; tally_import = created from Tally voucher during parallel operation';
comment on column customer_invoices.tally_voucher_number is 'Original Tally voucher / invoice number for cross-system reconciliation';
