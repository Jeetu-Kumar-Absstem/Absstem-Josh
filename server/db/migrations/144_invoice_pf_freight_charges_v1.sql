-- Invoice charge lines for taxable P&F / Freight (goods composite supply).
-- Also bring P&F term onto sales_orders (parity with quote) and seed freight INCL/BUYER.

alter table invoice_lines
  add column if not exists charge_kind text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_lines_charge_kind_check'
  ) then
    alter table invoice_lines
      add constraint invoice_lines_charge_kind_check
      check (charge_kind is null or charge_kind in ('packing_forwarding', 'freight'));
  end if;
end $$;

create index if not exists idx_invoice_lines_charge_kind
  on invoice_lines (customer_invoice_id, charge_kind)
  where charge_kind is not null;

alter table sales_orders
  add column if not exists p_and_f_term_id integer references p_and_f_terms(id);

create index if not exists idx_sales_orders_p_and_f_term_id
  on sales_orders (p_and_f_term_id);

-- Backfill P&F term from source quote revision where missing.
update sales_orders so
set p_and_f_term_id = qr.p_and_f_term_id
from quote_revisions qr
where so.quote_revision_id = qr.id
  and so.p_and_f_term_id is null
  and qr.p_and_f_term_id is not null;

-- Freight is independent of P&F. Absstem modes:
-- Inclusive | Buyer Scope | Buyer Approved (billed on invoice). Extra at Actuals stays as a billable alias.
insert into freight_terms (term_code, term_name, is_active)
values
  ('EXTRA', 'Extra at Actuals', true),
  ('INCL', 'Inclusive', true),
  ('BUYER_SCOPE', 'Buyer Scope', true),
  ('BUYER_BILLED', 'Buyer Approved (Billed on Invoice)', true)
on conflict (term_code) do update
set term_name = excluded.term_name,
    is_active = true;

-- Legacy BUYER freight row (if present) → Buyer Scope wording.
update freight_terms
set term_name = 'Buyer Scope',
    is_active = true
where term_code = 'BUYER';
