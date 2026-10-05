do $$
begin
  create unique index if not exists idx_finance_books_company_id_id_unique
    on finance_books(company_id, id);

  update finance_book_entries e
  set company_id = fb.company_id
  from finance_books fb
  where e.finance_book_id = fb.id
    and e.company_id <> fb.company_id;

  alter table finance_book_entries drop constraint if exists finance_book_entries_finance_book_id_fkey;
  alter table finance_book_entries drop constraint if exists finance_book_entries_company_book_fkey;
  alter table finance_book_entries
    add constraint finance_book_entries_company_book_fkey
    foreign key (company_id, finance_book_id)
    references finance_books(company_id, id)
    on delete cascade;

  create or replace function trg_check_finance_book_company_match()
  returns trigger
  language plpgsql
  as $fn$
  begin
    if new.finance_book_id is null then
      return new;
    end if;

    perform 1
    from finance_books fb
    where fb.id = new.finance_book_id
      and fb.company_id = new.company_id;

    if not found then
      raise exception 'FINANCE_BOOK_COMPANY_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_customer_receipts_finance_book_company_match on customer_receipts;
  create trigger trg_customer_receipts_finance_book_company_match
  before insert or update of finance_book_id, company_id
  on customer_receipts
  for each row
  execute function trg_check_finance_book_company_match();

  drop trigger if exists trg_vendor_payments_finance_book_company_match on vendor_payments;
  create trigger trg_vendor_payments_finance_book_company_match
  before insert or update of finance_book_id, company_id
  on vendor_payments
  for each row
  execute function trg_check_finance_book_company_match();

  create or replace function trg_check_vendor_payment_allocation_company_match()
  returns trigger
  language plpgsql
  as $fn$
  begin
    perform 1
    from vendor_payments vp
    join purchase_invoices pi on pi.id = new.purchase_invoice_id
    where vp.id = new.vendor_payment_id
      and vp.company_id = pi.company_id;

    if not found then
      raise exception 'VENDOR_PAYMENT_ALLOCATION_COMPANY_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_vendor_payment_allocations_company_match on vendor_payment_allocations;
  create trigger trg_vendor_payment_allocations_company_match
  before insert or update of vendor_payment_id, purchase_invoice_id
  on vendor_payment_allocations
  for each row
  execute function trg_check_vendor_payment_allocation_company_match();

  create or replace function trg_check_customer_receipt_allocation_company_match()
  returns trigger
  language plpgsql
  as $fn$
  begin
    perform 1
    from customer_receipts cr
    join customer_invoices ci on ci.id = new.customer_invoice_id
    where cr.id = new.customer_receipt_id
      and cr.company_id = ci.company_id;

    if not found then
      raise exception 'CUSTOMER_RECEIPT_ALLOCATION_COMPANY_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_customer_receipt_allocations_company_match on customer_receipt_allocations;
  create trigger trg_customer_receipt_allocations_company_match
  before insert or update of customer_receipt_id, customer_invoice_id
  on customer_receipt_allocations
  for each row
  execute function trg_check_customer_receipt_allocation_company_match();
end $$;
