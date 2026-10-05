alter table sales_orders
add column if not exists company_id integer;

update sales_orders so
set company_id = coalesce(
  so.company_id,
  qr.company_id,
  qh.company_id,
  company_id_by_code('AI')
)
from quote_revisions qr
left join quote_headers qh on qh.id = qr.quote_id
where qr.id = so.quote_revision_id
  and so.company_id is null;

update sales_orders
set company_id = company_id_by_code('AI')
where company_id is null;

alter table sales_orders
alter column company_id set default company_id_by_code('AI');

alter table sales_orders
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'sales_orders'
      and constraint_name = 'sales_orders_company_id_fkey'
  ) then
    alter table sales_orders
    add constraint sales_orders_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_sales_orders_company_id on sales_orders(company_id);

alter table dispatches
add column if not exists company_id integer;

update dispatches d
set company_id = coalesce(d.company_id, so.company_id, company_id_by_code('AI'))
from sales_orders so
where so.id = d.sales_order_id
  and d.company_id is null;

update dispatches
set company_id = company_id_by_code('AI')
where company_id is null;

alter table dispatches
alter column company_id set default company_id_by_code('AI');

alter table dispatches
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'dispatches'
      and constraint_name = 'dispatches_company_id_fkey'
  ) then
    alter table dispatches
    add constraint dispatches_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_dispatches_company_id on dispatches(company_id);

alter table customer_invoices
add column if not exists company_id integer;

update customer_invoices ci
set company_id = coalesce(ci.company_id, so.company_id, company_id_by_code('AI'))
from sales_orders so
where so.id = ci.sales_order_id
  and ci.company_id is null;

update customer_invoices
set company_id = company_id_by_code('AI')
where company_id is null;

alter table customer_invoices
alter column company_id set default company_id_by_code('AI');

alter table customer_invoices
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'customer_invoices'
      and constraint_name = 'customer_invoices_company_id_fkey'
  ) then
    alter table customer_invoices
    add constraint customer_invoices_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_customer_invoices_company_id on customer_invoices(company_id);

alter table customer_receipts
add column if not exists company_id integer;

update customer_receipts cr
set company_id = coalesce(
  cr.company_id,
  ci.company_id,
  company_id_by_code('AI')
)
from customer_receipt_allocations cra
join customer_invoices ci on ci.id = cra.customer_invoice_id
where cra.customer_receipt_id = cr.id
  and cr.company_id is null;

update customer_receipts
set company_id = company_id_by_code('AI')
where company_id is null;

alter table customer_receipts
alter column company_id set default company_id_by_code('AI');

alter table customer_receipts
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'customer_receipts'
      and constraint_name = 'customer_receipts_company_id_fkey'
  ) then
    alter table customer_receipts
    add constraint customer_receipts_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_customer_receipts_company_id on customer_receipts(company_id);

alter table sales_returns
add column if not exists company_id integer;

update sales_returns sr
set company_id = coalesce(
  sr.company_id,
  ci.company_id,
  company_id_by_code('AI')
)
from customer_invoices ci
where ci.id = sr.customer_invoice_id
  and sr.company_id is null;

update sales_returns
set company_id = company_id_by_code('AI')
where company_id is null;

alter table sales_returns
alter column company_id set default company_id_by_code('AI');

alter table sales_returns
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'sales_returns'
      and constraint_name = 'sales_returns_company_id_fkey'
  ) then
    alter table sales_returns
    add constraint sales_returns_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_sales_returns_company_id on sales_returns(company_id);

