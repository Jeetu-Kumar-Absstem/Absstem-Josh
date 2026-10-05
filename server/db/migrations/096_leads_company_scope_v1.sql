alter table leads
  add column if not exists company_id integer references companies(id) on delete restrict;

update leads l
set company_id = qh.company_id
from quote_headers qh
where l.company_id is null
  and l.converted_quote_id = qh.id
  and qh.company_id is not null;

update leads l
set company_id = so.company_id
from sales_orders so
where l.company_id is null
  and l.converted_sales_order_id = so.id
  and so.company_id is not null;

update leads l
set company_id = qh.company_id
from quote_headers qh
where l.company_id is null
  and qh.lead_id = l.id
  and qh.company_id is not null;

with preferred_membership as (
  select distinct on (ucm.user_id)
    ucm.user_id,
    ucm.company_id
  from user_company_memberships ucm
  where ucm.is_active = true
  order by ucm.user_id, ucm.is_primary desc, ucm.id asc
)
update leads l
set company_id = pm.company_id
from preferred_membership pm
where l.company_id is null
  and l.created_by = pm.user_id;

with preferred_membership as (
  select distinct on (ucm.user_id)
    ucm.user_id,
    ucm.company_id
  from user_company_memberships ucm
  where ucm.is_active = true
  order by ucm.user_id, ucm.is_primary desc, ucm.id asc
)
update leads l
set company_id = pm.company_id
from preferred_membership pm
where l.company_id is null
  and l.assigned_to = pm.user_id;

create index if not exists idx_leads_company_id
  on leads(company_id);

create index if not exists idx_leads_company_status
  on leads(company_id, status, updated_at desc);
