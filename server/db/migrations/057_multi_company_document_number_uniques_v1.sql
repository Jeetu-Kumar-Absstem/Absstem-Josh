do $$
begin
  alter table supplier_claim_receipts add column if not exists company_id integer;

  update supplier_claim_receipts scr
  set company_id = sc.company_id
  from supplier_claims sc
  where sc.id = scr.supplier_claim_id
    and scr.company_id is null;

  alter table supplier_claim_receipts alter column company_id set not null;
  alter table supplier_claim_receipts drop constraint if exists supplier_claim_receipts_company_id_fkey;
  alter table supplier_claim_receipts
    add constraint supplier_claim_receipts_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  create index if not exists idx_supplier_claim_receipts_company_id on supplier_claim_receipts(company_id);

  alter table quote_headers drop constraint if exists quote_headers_quote_number_key;
  create unique index if not exists idx_quote_headers_company_quote_number_unique
    on quote_headers(company_id, quote_number)
    where quote_number is not null;

  alter table sales_orders drop constraint if exists sales_orders_so_number_key;
  create unique index if not exists idx_sales_orders_company_so_number_unique
    on sales_orders(company_id, so_number);

  alter table dispatches drop constraint if exists dispatches_dispatch_number_key;
  create unique index if not exists idx_dispatches_company_dispatch_number_unique
    on dispatches(company_id, dispatch_number);

  alter table customer_invoices drop constraint if exists customer_invoices_invoice_number_key;
  create unique index if not exists idx_customer_invoices_company_invoice_number_unique
    on customer_invoices(company_id, invoice_number);

  alter table customer_receipts drop constraint if exists customer_receipts_receipt_number_key;
  create unique index if not exists idx_customer_receipts_company_receipt_number_unique
    on customer_receipts(company_id, receipt_number);

  alter table sales_returns drop constraint if exists sales_returns_return_number_key;
  create unique index if not exists idx_sales_returns_company_return_number_unique
    on sales_returns(company_id, return_number);

  alter table purchase_orders drop constraint if exists purchase_orders_po_number_key;
  create unique index if not exists idx_purchase_orders_company_po_number_unique
    on purchase_orders(company_id, po_number);

  alter table purchase_invoices drop constraint if exists purchase_invoices_purchase_invoice_number_key;
  create unique index if not exists idx_purchase_invoices_company_purchase_invoice_number_unique
    on purchase_invoices(company_id, purchase_invoice_number);

  alter table goods_receipts drop constraint if exists goods_receipts_grn_number_key;
  create unique index if not exists idx_goods_receipts_company_grn_number_unique
    on goods_receipts(company_id, grn_number);

  alter table quality_controls drop constraint if exists quality_controls_qc_number_key;
  create unique index if not exists idx_quality_controls_company_qc_number_unique
    on quality_controls(company_id, qc_number);

  alter table purchase_returns drop constraint if exists purchase_returns_return_number_key;
  create unique index if not exists idx_purchase_returns_company_return_number_unique
    on purchase_returns(company_id, return_number);

  alter table purchase_returns drop constraint if exists purchase_returns_debit_note_number_key;
  create unique index if not exists idx_purchase_returns_company_debit_note_number_unique
    on purchase_returns(company_id, debit_note_number)
    where debit_note_number is not null;

  alter table supplier_claims drop constraint if exists supplier_claims_claim_number_key;
  create unique index if not exists idx_supplier_claims_company_claim_number_unique
    on supplier_claims(company_id, claim_number);

  alter table supplier_claim_receipts drop constraint if exists supplier_claim_receipts_receipt_number_key;
  create unique index if not exists idx_supplier_claim_receipts_company_receipt_number_unique
    on supplier_claim_receipts(company_id, receipt_number);

  alter table stock_adjustments drop constraint if exists stock_adjustments_adjustment_number_key;
  create unique index if not exists idx_stock_adjustments_company_adjustment_number_unique
    on stock_adjustments(company_id, adjustment_number);

  alter table job_cards drop constraint if exists job_cards_job_card_number_key;
  create unique index if not exists idx_job_cards_company_job_card_number_unique
    on job_cards(company_id, job_card_number);

  alter table stock_transfers drop constraint if exists stock_transfers_transfer_number_key;
  create unique index if not exists idx_stock_transfers_company_transfer_number_unique
    on stock_transfers(company_id, transfer_number);

  alter table service_warranty_cases drop constraint if exists service_warranty_cases_case_number_key;
  create unique index if not exists idx_service_warranty_cases_company_case_number_unique
    on service_warranty_cases(company_id, case_number);

  alter table amc_contracts drop constraint if exists amc_contracts_contract_number_key;
  create unique index if not exists idx_amc_contracts_company_contract_number_unique
    on amc_contracts(company_id, contract_number);
end $$;

