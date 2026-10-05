-- Safe AT cleanup script for a DB-connected Josh environment.
--
-- Purpose:
-- 1. Delete all AT company-product policy rows.
-- 2. Delete only AT-only product rows that are NOT shared with any other company
--    and are NOT referenced by any foreign-key relationship elsewhere.
--
-- Important:
-- - Products are global in Josh. This script intentionally preserves any product that:
--   a) has a non-AT company policy row, or
--   b) is referenced anywhere outside metadata tables.
-- - Metadata tables `company_product_policies` and `product_attributes` are excluded
--   from "blocking references" because they are expected to disappear with the product.
-- - This script defaults to ROLLBACK. Review the preview outputs first.
--   Replace the final ROLLBACK with COMMIT only after you validate the candidate list.

begin;

do $$
declare
  v_at_company_id integer;
  v_fk record;
  v_preview_count integer;
begin
  select c.id
    into v_at_company_id
  from companies c
  where c.company_code = 'AT'
  limit 1;

  if v_at_company_id is null then
    raise exception 'Company code AT not found in companies table.';
  end if;

  create temp table tmp_at_policy_products (
    product_id integer primary key
  ) on commit drop;

  insert into tmp_at_policy_products (product_id)
  select distinct cpp.product_id
  from company_product_policies cpp
  where cpp.company_id = v_at_company_id;

  create temp table tmp_shared_products (
    product_id integer primary key
  ) on commit drop;

  insert into tmp_shared_products (product_id)
  select distinct cpp.product_id
  from company_product_policies cpp
  where cpp.company_id <> v_at_company_id
    and cpp.product_id in (select product_id from tmp_at_policy_products);

  create temp table tmp_blocking_references (
    product_id integer not null,
    source_table text not null,
    source_column text not null,
    ref_count bigint not null
  ) on commit drop;

  for v_fk in
    select
      ns.nspname as schema_name,
      cls.relname as table_name,
      att.attname as column_name
    from pg_constraint con
    join pg_class cls
      on cls.oid = con.conrelid
    join pg_namespace ns
      on ns.oid = cls.relnamespace
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'products'::regclass
      and array_length(con.conkey, 1) = 1
      and not (ns.nspname = 'public' and cls.relname in ('company_product_policies', 'product_attributes'))
  loop
    execute format(
      $sql$
        insert into tmp_blocking_references (product_id, source_table, source_column, ref_count)
        select
          t.%1$I::integer as product_id,
          %2$L as source_table,
          %3$L as source_column,
          count(*)::bigint as ref_count
        from %4$I.%5$I t
        where t.%1$I in (select product_id from tmp_at_policy_products)
        group by t.%1$I
      $sql$,
      v_fk.column_name,
      format('%I.%I', v_fk.schema_name, v_fk.table_name),
      v_fk.column_name,
      v_fk.schema_name,
      v_fk.table_name
    );
  end loop;

  create temp table tmp_delete_candidates (
    product_id integer primary key
  ) on commit drop;

  insert into tmp_delete_candidates (product_id)
  select ap.product_id
  from tmp_at_policy_products ap
  left join tmp_shared_products sp
    on sp.product_id = ap.product_id
  left join (
    select distinct product_id
    from tmp_blocking_references
  ) br
    on br.product_id = ap.product_id
  where sp.product_id is null
    and br.product_id is null;

  get diagnostics v_preview_count = row_count;
  raise notice 'Prepared % AT-only unreferenced product delete candidates.', v_preview_count;
end $$;

-- Preview 1: overall counts
select
  (select count(*) from tmp_at_policy_products) as at_policy_products,
  (select count(*) from tmp_shared_products) as shared_with_other_companies,
  (select count(distinct product_id) from tmp_blocking_references) as blocked_by_fk_reference,
  (select count(*) from tmp_delete_candidates) as safe_delete_candidates;

-- Preview 2: candidate products that will be removed if you COMMIT
select
  p.id,
  p.item_code,
  p.item_name,
  p.item_type,
  p.uom,
  p.is_active
from tmp_delete_candidates d
join products p
  on p.id = d.product_id
order by p.item_code
limit 250;

-- Preview 3: products blocked from deletion and why
select
  p.item_code,
  p.item_name,
  br.source_table,
  br.source_column,
  br.ref_count
from tmp_blocking_references br
join products p
  on p.id = br.product_id
order by p.item_code, br.source_table, br.source_column
limit 500;

-- Preview 4: AT policy rows that will be deleted
select
  count(*) as at_policy_rows_to_delete
from company_product_policies cpp
join companies c
  on c.id = cpp.company_id
where c.company_code = 'AT';

-- Actual deletion phase
delete from company_product_policies cpp
using companies c
where c.id = cpp.company_id
  and c.company_code = 'AT';

delete from products p
using tmp_delete_candidates d
where p.id = d.product_id;

-- Post-delete summary inside the transaction
select
  (select count(*) from products p join tmp_delete_candidates d on d.product_id = p.id) as remaining_candidate_products,
  (select count(*) from company_product_policies cpp join companies c on c.id = cpp.company_id where c.company_code = 'AT') as remaining_at_policy_rows;

-- Default safety: inspect results, then change to COMMIT if satisfied.
rollback;
