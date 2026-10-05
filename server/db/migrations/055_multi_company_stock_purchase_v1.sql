alter table purchase_orders
add column if not exists company_id integer;

update purchase_orders
set company_id = company_id_by_code('AI')
where company_id is null;

alter table purchase_orders
alter column company_id set default company_id_by_code('AI');

alter table purchase_orders
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'purchase_orders'
      and constraint_name = 'purchase_orders_company_id_fkey'
  ) then
    alter table purchase_orders
    add constraint purchase_orders_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_purchase_orders_company_id on purchase_orders(company_id);

alter table purchase_invoices
add column if not exists company_id integer;

update purchase_invoices pi
set company_id = coalesce(pi.company_id, po.company_id, company_id_by_code('AI'))
from purchase_orders po
where po.id = pi.purchase_order_id
  and pi.company_id is null;

update purchase_invoices
set company_id = company_id_by_code('AI')
where company_id is null;

alter table purchase_invoices
alter column company_id set default company_id_by_code('AI');

alter table purchase_invoices
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'purchase_invoices'
      and constraint_name = 'purchase_invoices_company_id_fkey'
  ) then
    alter table purchase_invoices
    add constraint purchase_invoices_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_purchase_invoices_company_id on purchase_invoices(company_id);

alter table goods_receipts
add column if not exists company_id integer;

update goods_receipts gr
set company_id = coalesce(gr.company_id, po.company_id, company_id_by_code('AI'))
from purchase_orders po
where po.id = gr.purchase_order_id
  and gr.company_id is null;

update goods_receipts
set company_id = company_id_by_code('AI')
where company_id is null;

alter table goods_receipts
alter column company_id set default company_id_by_code('AI');

alter table goods_receipts
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'goods_receipts'
      and constraint_name = 'goods_receipts_company_id_fkey'
  ) then
    alter table goods_receipts
    add constraint goods_receipts_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_goods_receipts_company_id on goods_receipts(company_id);

alter table purchase_returns
add column if not exists company_id integer;

update purchase_returns pr
set company_id = gr.company_id
from goods_receipts gr
where pr.company_id is null
  and pr.goods_receipt_id is not null
  and gr.id = pr.goods_receipt_id;

update purchase_returns pr
set company_id = pi.company_id
from purchase_invoices pi
where pr.company_id is null
  and pr.purchase_invoice_id is not null
  and pi.id = pr.purchase_invoice_id;

update purchase_returns
set company_id = company_id_by_code('AI')
where company_id is null;

alter table purchase_returns
alter column company_id set default company_id_by_code('AI');

alter table purchase_returns
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'purchase_returns'
      and constraint_name = 'purchase_returns_company_id_fkey'
  ) then
    alter table purchase_returns
    add constraint purchase_returns_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_purchase_returns_company_id on purchase_returns(company_id);

alter table quality_controls
add column if not exists company_id integer;

update quality_controls qc
set company_id = coalesce(qc.company_id, gr.company_id, company_id_by_code('AI'))
from goods_receipts gr
where gr.id = qc.goods_receipt_id
  and qc.company_id is null;

update quality_controls
set company_id = company_id_by_code('AI')
where company_id is null;

alter table quality_controls
alter column company_id set default company_id_by_code('AI');

alter table quality_controls
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'quality_controls'
      and constraint_name = 'quality_controls_company_id_fkey'
  ) then
    alter table quality_controls
    add constraint quality_controls_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_quality_controls_company_id on quality_controls(company_id);

alter table supplier_claims
add column if not exists company_id integer;

update supplier_claims sc
set company_id = coalesce(sc.company_id, qc.company_id, company_id_by_code('AI'))
from quality_controls qc
where qc.id = sc.quality_control_id
  and sc.company_id is null;

update supplier_claims
set company_id = company_id_by_code('AI')
where company_id is null;

alter table supplier_claims
alter column company_id set default company_id_by_code('AI');

alter table supplier_claims
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'supplier_claims'
      and constraint_name = 'supplier_claims_company_id_fkey'
  ) then
    alter table supplier_claims
    add constraint supplier_claims_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_supplier_claims_company_id on supplier_claims(company_id);

alter table stock_adjustments
add column if not exists company_id integer;

update stock_adjustments
set company_id = company_id_by_code('AI')
where company_id is null;

alter table stock_adjustments
alter column company_id set default company_id_by_code('AI');

alter table stock_adjustments
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'stock_adjustments'
      and constraint_name = 'stock_adjustments_company_id_fkey'
  ) then
    alter table stock_adjustments
    add constraint stock_adjustments_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_stock_adjustments_company_id on stock_adjustments(company_id);

alter table stock_transfers
add column if not exists company_id integer;

update stock_transfers
set company_id = company_id_by_code('AI')
where company_id is null;

alter table stock_transfers
alter column company_id set default company_id_by_code('AI');

alter table stock_transfers
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'stock_transfers'
      and constraint_name = 'stock_transfers_company_id_fkey'
  ) then
    alter table stock_transfers
    add constraint stock_transfers_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_stock_transfers_company_id on stock_transfers(company_id);

alter table job_cards
add column if not exists company_id integer;

update job_cards
set company_id = company_id_by_code('AI')
where company_id is null;

alter table job_cards
alter column company_id set default company_id_by_code('AI');

alter table job_cards
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'job_cards'
      and constraint_name = 'job_cards_company_id_fkey'
  ) then
    alter table job_cards
    add constraint job_cards_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_job_cards_company_id on job_cards(company_id);

alter table service_warranty_cases
add column if not exists company_id integer;

update service_warranty_cases swc
set company_id = coalesce(swc.company_id, d.company_id, company_id_by_code('AI'))
from dispatches d
where d.id = swc.dispatch_id
  and swc.company_id is null;

update service_warranty_cases
set company_id = company_id_by_code('AI')
where company_id is null;

alter table service_warranty_cases
alter column company_id set default company_id_by_code('AI');

alter table service_warranty_cases
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'service_warranty_cases'
      and constraint_name = 'service_warranty_cases_company_id_fkey'
  ) then
    alter table service_warranty_cases
    add constraint service_warranty_cases_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_service_warranty_cases_company_id on service_warranty_cases(company_id);

alter table amc_contracts
add column if not exists company_id integer;

update amc_contracts ac
set company_id = coalesce(ac.company_id, d.company_id, company_id_by_code('AI'))
from dispatches d
where d.id = ac.dispatch_id
  and ac.company_id is null;

update amc_contracts
set company_id = company_id_by_code('AI')
where company_id is null;

alter table amc_contracts
alter column company_id set default company_id_by_code('AI');

alter table amc_contracts
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'amc_contracts'
      and constraint_name = 'amc_contracts_company_id_fkey'
  ) then
    alter table amc_contracts
    add constraint amc_contracts_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_amc_contracts_company_id on amc_contracts(company_id);

alter table stock_locations
add column if not exists company_id integer;

update stock_locations
set company_id = company_id_by_code('AI')
where company_id is null;

alter table stock_locations
alter column company_id set default company_id_by_code('AI');

alter table stock_locations
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'stock_locations'
      and constraint_name = 'stock_locations_company_id_fkey'
  ) then
    alter table stock_locations
    add constraint stock_locations_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_stock_locations_company_id on stock_locations(company_id);

alter table stock_movements
add column if not exists company_id integer;

update stock_movements sm
set company_id = gr.company_id
from goods_receipts gr
where sm.company_id is null
  and sm.ref_type = 'GRN'
  and gr.id = sm.ref_id;

update stock_movements sm
set company_id = pr.company_id
from purchase_returns pr
where sm.company_id is null
  and sm.ref_type = 'PURCHASE_RETURN'
  and pr.id = sm.ref_id;

update stock_movements sm
set company_id = d.company_id
from dispatches d
where sm.company_id is null
  and sm.ref_type = 'DISPATCH'
  and d.id = sm.ref_id;

update stock_movements sm
set company_id = sr.company_id
from sales_returns sr
where sm.company_id is null
  and sm.ref_type = 'SALES_RETURN'
  and sr.id = sm.ref_id;

update stock_movements sm
set company_id = swc.company_id
from service_warranty_cases swc
where sm.company_id is null
  and (sm.ref_type = 'FIELD_RETURN' or sm.ref_type = 'SERVICE_REPLACEMENT')
  and swc.id = sm.ref_id;

update stock_movements sm
set company_id = jc.company_id
from job_cards jc
where sm.company_id is null
  and (sm.ref_type = 'MATERIAL_ISSUE' or sm.ref_type = 'MATERIAL_RETURN')
  and jc.id = sm.ref_id;

update stock_movements sm
set company_id = st.company_id
from stock_transfers st
where sm.company_id is null
  and (sm.ref_type = 'LOCATION_TRANSFER_OUT' or sm.ref_type = 'LOCATION_TRANSFER_IN')
  and st.id = sm.ref_id;

update stock_movements sm
set company_id = sa.company_id
from stock_adjustments sa
where sm.company_id is null
  and sm.ref_type = 'STOCK_ADJUSTMENT'
  and sa.id = sm.ref_id;

update stock_movements
set company_id = company_id_by_code('AI')
where company_id is null;

alter table stock_movements
alter column company_id set default company_id_by_code('AI');

alter table stock_movements
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'stock_movements'
      and constraint_name = 'stock_movements_company_id_fkey'
  ) then
    alter table stock_movements
    add constraint stock_movements_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_stock_movements_company_product on stock_movements(company_id, product_id);
create index if not exists idx_stock_movements_company_ref on stock_movements(company_id, ref_type, ref_id);

alter table stock_balances
add column if not exists company_id integer;

update stock_balances
set company_id = company_id_by_code('AI')
where company_id is null;

alter table stock_balances
alter column company_id set default company_id_by_code('AI');

alter table stock_balances
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'stock_balances'
      and constraint_name = 'stock_balances_company_id_fkey'
  ) then
    alter table stock_balances
    add constraint stock_balances_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

alter table stock_balances
drop constraint if exists stock_balances_pkey;

alter table stock_balances
add primary key (company_id, product_id);

create index if not exists idx_stock_balances_product_id on stock_balances(product_id);
