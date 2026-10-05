-- 163: AVL-aware landed cost snapshots and inventory valuation

alter table component_specification_avl
  add column if not exists handling_fee_per_unit numeric(18, 4) not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'component_specification_avl_handling_check'
  ) then
    alter table component_specification_avl
      add constraint component_specification_avl_handling_check
      check (handling_fee_per_unit >= 0);
  end if;
end $$;

alter table purchase_orders
  add column if not exists handling_fee_override_order numeric(18, 4),
  add column if not exists landed_cost_calculated_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_orders_handling_override_check'
  ) then
    alter table purchase_orders
      add constraint purchase_orders_handling_override_check
      check (handling_fee_override_order is null or handling_fee_override_order >= 0);
  end if;
end $$;

alter table purchase_order_lines
  add column if not exists component_specification_id bigint references component_specifications(id) on delete set null,
  add column if not exists component_specification_avl_id bigint references component_specification_avl(id) on delete set null,
  add column if not exists landed_cost_fx_rate numeric(18, 8),
  add column if not exists landed_cost_raw_unit_base numeric(18, 4),
  add column if not exists landed_cost_freight_unit_base numeric(18, 4),
  add column if not exists landed_cost_import_duty_unit_base numeric(18, 4),
  add column if not exists landed_cost_handling_unit_base numeric(18, 4),
  add column if not exists landed_cost_unit_base numeric(18, 4),
  add column if not exists landed_cost_total_base numeric(18, 2),
  add column if not exists landed_cost_raw_unit_order numeric(18, 4),
  add column if not exists landed_cost_total_order numeric(18, 2),
  add column if not exists landed_cost_calculated_at timestamptz;

create index if not exists purchase_order_lines_component_spec_idx
  on purchase_order_lines(component_specification_id)
  where component_specification_id is not null;

create index if not exists purchase_order_lines_component_avl_idx
  on purchase_order_lines(component_specification_avl_id)
  where component_specification_avl_id is not null;

alter table stock_movements
  add column if not exists unit_cost_base numeric(18, 4),
  add column if not exists value_signed_base numeric(18, 2);

update stock_movements sm
set unit_cost_base = coalesce(pol.landed_cost_unit_base, pol.unit_price_base, pol.unit_price_order, 0),
    value_signed_base = sm.qty_signed * coalesce(pol.landed_cost_unit_base, pol.unit_price_base, pol.unit_price_order, 0)
from goods_receipt_lines grl
join purchase_order_lines pol on pol.id = grl.purchase_order_line_id
where sm.ref_type = 'GRN'
  and sm.ref_id = grl.goods_receipt_id
  and sm.ref_line_id = grl.id
  and sm.unit_cost_base is null;

alter table stock_balances
  add column if not exists stock_value_base numeric(18, 2) not null default 0,
  add column if not exists average_unit_cost_base numeric(18, 4) not null default 0,
  add column if not exists valuation_updated_at timestamptz;

with recursive ranked as (
  select
    sm.company_id,
    sm.product_id,
    sm.qty_signed,
    sm.unit_cost_base,
    row_number() over (
      partition by sm.company_id, sm.product_id
      order by sm.movement_date asc nulls first, sm.id asc
    ) as movement_no
  from stock_movements sm
),
valuation(company_id, product_id, movement_no, stock_qty, stock_value_base) as (
  select
    r.company_id,
    r.product_id,
    r.movement_no,
    r.qty_signed::numeric,
    (
      case when r.qty_signed > 0 then r.qty_signed * coalesce(r.unit_cost_base, 0) else 0 end
    )::numeric
  from ranked r
  where r.movement_no = 1
  union all
  select
    r.company_id,
    r.product_id,
    r.movement_no,
    (v.stock_qty + r.qty_signed)::numeric,
    (
      case
      when r.qty_signed >= 0 then v.stock_value_base + (
        r.qty_signed * coalesce(
          r.unit_cost_base,
          case when v.stock_qty > 0 then v.stock_value_base / v.stock_qty else 0 end
        )
      )
      else v.stock_value_base + (
        r.qty_signed * case when v.stock_qty > 0 then v.stock_value_base / v.stock_qty else 0 end
      )
      end
    )::numeric
  from valuation v
  join ranked r
    on r.company_id = v.company_id
   and r.product_id = v.product_id
   and r.movement_no = v.movement_no + 1
),
latest as (
  select distinct on (company_id, product_id)
    company_id,
    product_id,
    stock_qty,
    stock_value_base,
    case when stock_qty > 0 then stock_value_base / stock_qty else 0 end as average_unit_cost_base
  from valuation
  order by company_id, product_id, movement_no desc
)
update stock_balances sb
set stock_qty = latest.stock_qty,
    stock_value_base = latest.stock_value_base,
    average_unit_cost_base = latest.average_unit_cost_base,
    valuation_updated_at = now(),
    updated_at = now()
from latest
where sb.company_id = latest.company_id
  and sb.product_id = latest.product_id;

create table if not exists company_finance_settings (
  id bigserial primary key,
  company_id bigint not null unique references companies(id) on delete cascade,
  landed_cost_variance_threshold_pct numeric(8, 4) not null default 5.00,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_finance_settings_variance_check
    check (landed_cost_variance_threshold_pct >= 0)
);

comment on column company_finance_settings.landed_cost_variance_threshold_pct is
  'Percentage variance above which alternate-vendor landed cost is highlighted.';
