do $$
begin
  create unique index if not exists idx_dispatches_intercompany_goods_receipt_unique
    on dispatches(intercompany_goods_receipt_id)
    where intercompany_goods_receipt_id is not null;

  create or replace function trg_check_intercompany_customer_invoice_link()
  returns trigger
  language plpgsql
  as $fn$
  declare expected_buyer_company_id integer;
  begin
    if new.intercompany_purchase_invoice_id is null then
      return new;
    end if;

    select so.intercompany_counterparty_company_id
      into expected_buyer_company_id
    from sales_orders so
    where so.id = new.sales_order_id;

    if expected_buyer_company_id is null then
      raise exception 'INTERCOMPANY_COUNTERPARTY_REQUIRED';
    end if;

    if expected_buyer_company_id = new.company_id then
      raise exception 'INTERCOMPANY_COUNTERPARTY_INVALID';
    end if;

    perform 1
    from purchase_invoices pi
    where pi.id = new.intercompany_purchase_invoice_id
      and pi.company_id = expected_buyer_company_id;

    if not found then
      raise exception 'INTERCOMPANY_LINK_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_customer_invoices_intercompany_link_check on customer_invoices;
  create trigger trg_customer_invoices_intercompany_link_check
  before insert or update of intercompany_purchase_invoice_id, sales_order_id, company_id
  on customer_invoices
  for each row
  execute function trg_check_intercompany_customer_invoice_link();

  create or replace function trg_check_intercompany_purchase_invoice_link()
  returns trigger
  language plpgsql
  as $fn$
  declare expected_buyer_company_id integer;
  begin
    if new.intercompany_customer_invoice_id is null then
      return new;
    end if;

    select so.intercompany_counterparty_company_id
      into expected_buyer_company_id
    from customer_invoices ci
    join sales_orders so on so.id = ci.sales_order_id
    where ci.id = new.intercompany_customer_invoice_id;

    if expected_buyer_company_id is null then
      raise exception 'INTERCOMPANY_COUNTERPARTY_REQUIRED';
    end if;

    if new.company_id <> expected_buyer_company_id then
      raise exception 'INTERCOMPANY_LINK_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_purchase_invoices_intercompany_link_check on purchase_invoices;
  create trigger trg_purchase_invoices_intercompany_link_check
  before insert or update of intercompany_customer_invoice_id, company_id
  on purchase_invoices
  for each row
  execute function trg_check_intercompany_purchase_invoice_link();

  create or replace function trg_check_intercompany_goods_receipt_link()
  returns trigger
  language plpgsql
  as $fn$
  declare expected_buyer_company_id integer;
  begin
    if new.intercompany_dispatch_id is null then
      return new;
    end if;

    select so.intercompany_counterparty_company_id
      into expected_buyer_company_id
    from dispatches d
    join sales_orders so on so.id = d.sales_order_id
    where d.id = new.intercompany_dispatch_id;

    if expected_buyer_company_id is null then
      raise exception 'INTERCOMPANY_COUNTERPARTY_REQUIRED';
    end if;

    if new.company_id <> expected_buyer_company_id then
      raise exception 'INTERCOMPANY_LINK_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_goods_receipts_intercompany_link_check on goods_receipts;
  create trigger trg_goods_receipts_intercompany_link_check
  before insert or update of intercompany_dispatch_id, company_id
  on goods_receipts
  for each row
  execute function trg_check_intercompany_goods_receipt_link();

  create or replace function trg_check_intercompany_dispatch_grn_link()
  returns trigger
  language plpgsql
  as $fn$
  declare expected_buyer_company_id integer;
  begin
    if new.intercompany_goods_receipt_id is null then
      return new;
    end if;

    select so.intercompany_counterparty_company_id
      into expected_buyer_company_id
    from sales_orders so
    where so.id = new.sales_order_id;

    if expected_buyer_company_id is null then
      raise exception 'INTERCOMPANY_COUNTERPARTY_REQUIRED';
    end if;

    perform 1
    from goods_receipts grn
    where grn.id = new.intercompany_goods_receipt_id
      and grn.company_id = expected_buyer_company_id;

    if not found then
      raise exception 'INTERCOMPANY_LINK_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_dispatches_intercompany_grn_link_check on dispatches;
  create trigger trg_dispatches_intercompany_grn_link_check
  before insert or update of intercompany_goods_receipt_id, sales_order_id, company_id
  on dispatches
  for each row
  execute function trg_check_intercompany_dispatch_grn_link();
end $$;
