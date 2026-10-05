begin;

-- Pilot cleanup for pre-go-live commercial data.
-- Commit version:
-- 1) delete all leads and their child records
-- 2) delete all quotes not linked to any sales order
-- 3) preserve quote chains already converted into sales orders

drop table if exists tmp_protected_quote_ids;
create temporary table tmp_protected_quote_ids as
select distinct qr.quote_id
from sales_orders so
join quote_revisions qr on qr.id = so.quote_revision_id
where so.quote_revision_id is not null
  and qr.quote_id is not null;

drop table if exists tmp_deletable_quote_ids;
create temporary table tmp_deletable_quote_ids as
select qh.id as quote_id, qh.quote_number
from quote_headers qh
where not exists (
  select 1
  from tmp_protected_quote_ids p
  where p.quote_id = qh.id
);

select
  (select count(*) from leads) as leads_to_delete,
  (select count(*) from tmp_deletable_quote_ids) as quotes_to_delete,
  (select count(*) from tmp_protected_quote_ids) as quotes_protected_by_sales_orders;

select
  qh.id,
  qh.quote_number,
  qh.quote_status,
  qh.customer_id,
  qh.created_at
from quote_headers qh
join tmp_deletable_quote_ids d on d.quote_id = qh.id
order by qh.created_at desc, qh.id desc
limit 50;

select
  qh.id,
  qh.quote_number,
  qh.quote_status,
  so.id as sales_order_id,
  so.so_number,
  so.order_status
from quote_headers qh
join tmp_protected_quote_ids p on p.quote_id = qh.id
join quote_revisions qr on qr.quote_id = qh.id
join sales_orders so on so.quote_revision_id = qr.id
order by so.id desc
limit 50;

delete from leads;

delete from quote_headers qh
using tmp_deletable_quote_ids d
where qh.id = d.quote_id;

select
  (select count(*) from leads) as remaining_leads,
  (select count(*) from quote_headers qh join tmp_deletable_quote_ids d on d.quote_id = qh.id) as remaining_deletable_quotes,
  (select count(*) from quote_headers qh join tmp_protected_quote_ids p on p.quote_id = qh.id) as remaining_protected_quotes;

commit;
