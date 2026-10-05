alter table customers
  add column if not exists fax text,
  add column if not exists tinno text,
  add column if not exists pan text,
  add column if not exists customer_type text,
  add column if not exists account_manager text,
  add column if not exists invoice_no text,
  add column if not exists invoice_date date,
  add column if not exists in_case_of_hospital boolean not null default false;
