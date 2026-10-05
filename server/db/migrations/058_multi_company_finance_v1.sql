do $$
begin
  alter table vendor_payments add column if not exists company_id integer;

  update vendor_payments vp
  set company_id = pi.company_id
  from vendor_payment_allocations vpa
  join purchase_invoices pi on pi.id = vpa.purchase_invoice_id
  where vpa.vendor_payment_id = vp.id
    and vp.company_id is null;

  alter table finance_books add column if not exists company_id integer;
  update finance_books
  set company_id = company_id_by_code('AI')
  where company_id is null;

  update vendor_payments vp
  set company_id = fb.company_id
  from finance_books fb
  where vp.company_id is null
    and vp.finance_book_id is not null
    and fb.id = vp.finance_book_id;

  update vendor_payments
  set company_id = company_id_by_code('AI')
  where company_id is null;

  alter table vendor_payments alter column company_id set not null;
  alter table vendor_payments drop constraint if exists vendor_payments_company_id_fkey;
  alter table vendor_payments
    add constraint vendor_payments_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  create index if not exists idx_vendor_payments_company_id on vendor_payments(company_id);

  alter table vendor_payments drop constraint if exists vendor_payments_payment_number_key;
  create unique index if not exists idx_vendor_payments_company_payment_number_unique
    on vendor_payments(company_id, payment_number);

  alter table finance_books alter column company_id set not null;
  alter table finance_books drop constraint if exists finance_books_company_id_fkey;
  alter table finance_books
    add constraint finance_books_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  create index if not exists idx_finance_books_company_id on finance_books(company_id);

  alter table finance_books drop constraint if exists finance_books_book_code_key;
  create unique index if not exists idx_finance_books_company_book_code_unique
    on finance_books(company_id, book_code)
    where book_code is not null;

  alter table finance_book_entries add column if not exists company_id integer;
  update finance_book_entries e
  set company_id = fb.company_id
  from finance_books fb
  where fb.id = e.finance_book_id
    and e.company_id is null;
  update finance_book_entries
  set company_id = company_id_by_code('AI')
  where company_id is null;
  alter table finance_book_entries alter column company_id set not null;
  alter table finance_book_entries drop constraint if exists finance_book_entries_company_id_fkey;
  alter table finance_book_entries
    add constraint finance_book_entries_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  create index if not exists idx_finance_book_entries_company_id on finance_book_entries(company_id);
  create index if not exists idx_finance_book_entries_company_book_id on finance_book_entries(company_id, finance_book_id);

  alter table finance_book_entries drop constraint if exists finance_book_entries_entry_number_key;
  create unique index if not exists idx_finance_book_entries_company_entry_number_unique
    on finance_book_entries(company_id, entry_number);

  alter table purchase_requisitions add column if not exists company_id integer;
  update purchase_requisitions
  set company_id = company_id_by_code('AI')
  where company_id is null;
  alter table purchase_requisitions alter column company_id set not null;
  alter table purchase_requisitions drop constraint if exists purchase_requisitions_company_id_fkey;
  alter table purchase_requisitions
    add constraint purchase_requisitions_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  create index if not exists idx_purchase_requisitions_company_id on purchase_requisitions(company_id);

  alter table purchase_requisitions drop constraint if exists purchase_requisitions_requisition_number_key;
  create unique index if not exists idx_purchase_requisitions_company_requisition_number_unique
    on purchase_requisitions(company_id, requisition_number);

  alter table approval_policies add column if not exists company_id integer;
  update approval_policies
  set company_id = company_id_by_code('AI')
  where company_id is null;
  alter table approval_policies alter column company_id set not null;
  alter table approval_policies drop constraint if exists approval_policies_company_id_fkey;
  alter table approval_policies
    add constraint approval_policies_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  create index if not exists idx_approval_policies_company_id on approval_policies(company_id);
end $$;
