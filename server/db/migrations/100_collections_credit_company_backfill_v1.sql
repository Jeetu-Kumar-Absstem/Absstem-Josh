update customer_collection_actions a
set company_id = ci.company_id
from customer_invoices ci
where a.company_id is null
  and a.customer_invoice_id = ci.id
  and ci.company_id is not null;

update customer_collection_disputes d
set company_id = ci.company_id
from customer_invoices ci
where d.company_id is null
  and d.customer_invoice_id = ci.id
  and ci.company_id is not null;

update customer_collection_disputes d
set company_id = sr.company_id
from sales_returns sr
where d.company_id is null
  and d.sales_return_id = sr.id
  and sr.company_id is not null;

update customer_ar_adjustments a
set company_id = ci.company_id
from customer_invoices ci
where a.company_id is null
  and a.customer_invoice_id = ci.id
  and ci.company_id is not null;

with single_company_links as (
  select customer_id, min(company_id) as company_id
  from customer_company_links
  where is_active = true
  group by customer_id
  having count(distinct company_id) = 1
)
update customer_collection_actions a
set company_id = scl.company_id
from single_company_links scl
where a.company_id is null
  and a.customer_id = scl.customer_id;

with single_company_links as (
  select customer_id, min(company_id) as company_id
  from customer_company_links
  where is_active = true
  group by customer_id
  having count(distinct company_id) = 1
)
update customer_collection_disputes d
set company_id = scl.company_id
from single_company_links scl
where d.company_id is null
  and d.customer_id = scl.customer_id;

with single_company_links as (
  select customer_id, min(company_id) as company_id
  from customer_company_links
  where is_active = true
  group by customer_id
  having count(distinct company_id) = 1
)
update customer_ar_adjustments a
set company_id = scl.company_id
from single_company_links scl
where a.company_id is null
  and a.customer_id = scl.customer_id;

with single_company_links as (
  select customer_id, min(company_id) as company_id
  from customer_company_links
  where is_active = true
  group by customer_id
  having count(distinct company_id) = 1
)
update customer_credit_releases r
set company_id = scl.company_id
from single_company_links scl
where r.company_id is null
  and r.customer_id = scl.customer_id;

alter table customer_collection_actions
  drop constraint if exists customer_collection_actions_company_required_chk;

alter table customer_collection_actions
  add constraint customer_collection_actions_company_required_chk
  check (company_id is not null) not valid;

alter table customer_collection_disputes
  drop constraint if exists customer_collection_disputes_company_required_chk;

alter table customer_collection_disputes
  add constraint customer_collection_disputes_company_required_chk
  check (company_id is not null) not valid;

alter table customer_ar_adjustments
  drop constraint if exists customer_ar_adjustments_company_required_chk;

alter table customer_ar_adjustments
  add constraint customer_ar_adjustments_company_required_chk
  check (company_id is not null) not valid;

alter table customer_credit_releases
  drop constraint if exists customer_credit_releases_company_required_chk;

alter table customer_credit_releases
  add constraint customer_credit_releases_company_required_chk
  check (company_id is not null) not valid;
