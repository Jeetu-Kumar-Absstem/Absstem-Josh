do $$
begin
  create table if not exists intercompany_partners (
    id serial primary key,
    company_id integer not null references companies(id) on delete restrict,
    counterparty_company_id integer not null references companies(id) on delete restrict,
    vendor_id integer references vendors(id) on delete set null,
    customer_id integer references customers(id) on delete set null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, counterparty_company_id),
    check (company_id <> counterparty_company_id)
  );

  create index if not exists idx_intercompany_partners_company_id on intercompany_partners(company_id);
  create index if not exists idx_intercompany_partners_counterparty_company_id on intercompany_partners(counterparty_company_id);
  create index if not exists idx_intercompany_partners_vendor_id on intercompany_partners(vendor_id);
  create index if not exists idx_intercompany_partners_customer_id on intercompany_partners(customer_id);

  alter table purchase_orders
    add column if not exists intercompany_counterparty_company_id integer references companies(id) on delete restrict,
    add column if not exists intercompany_sales_order_id integer references sales_orders(id) on delete set null;

  create index if not exists idx_purchase_orders_intercompany_counterparty on purchase_orders(intercompany_counterparty_company_id);
  create index if not exists idx_purchase_orders_intercompany_sales_order_id on purchase_orders(intercompany_sales_order_id);

  alter table sales_orders
    add column if not exists intercompany_counterparty_company_id integer references companies(id) on delete restrict,
    add column if not exists intercompany_purchase_order_id integer references purchase_orders(id) on delete set null;

  create index if not exists idx_sales_orders_intercompany_counterparty on sales_orders(intercompany_counterparty_company_id);
  create index if not exists idx_sales_orders_intercompany_purchase_order_id on sales_orders(intercompany_purchase_order_id);

  alter table customer_invoices
    add column if not exists intercompany_purchase_invoice_id integer references purchase_invoices(id) on delete set null;
  create index if not exists idx_customer_invoices_intercompany_purchase_invoice_id on customer_invoices(intercompany_purchase_invoice_id);

  alter table purchase_invoices
    add column if not exists intercompany_customer_invoice_id integer references customer_invoices(id) on delete set null;
  create index if not exists idx_purchase_invoices_intercompany_customer_invoice_id on purchase_invoices(intercompany_customer_invoice_id);

  create or replace function trg_check_intercompany_purchase_order_link()
  returns trigger
  language plpgsql
  as $fn$
  begin
    if new.intercompany_sales_order_id is null then
      return new;
    end if;

    if new.intercompany_counterparty_company_id is null then
      raise exception 'INTERCOMPANY_COUNTERPARTY_REQUIRED';
    end if;

    if new.intercompany_counterparty_company_id = new.company_id then
      raise exception 'INTERCOMPANY_COUNTERPARTY_INVALID';
    end if;

    perform 1
    from sales_orders so
    where so.id = new.intercompany_sales_order_id
      and so.company_id = new.intercompany_counterparty_company_id;

    if not found then
      raise exception 'INTERCOMPANY_LINK_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_purchase_orders_intercompany_link_check on purchase_orders;
  create trigger trg_purchase_orders_intercompany_link_check
  before insert or update of intercompany_counterparty_company_id, intercompany_sales_order_id, company_id
  on purchase_orders
  for each row
  execute function trg_check_intercompany_purchase_order_link();

  create or replace function trg_check_intercompany_sales_order_link()
  returns trigger
  language plpgsql
  as $fn$
  begin
    if new.intercompany_purchase_order_id is null then
      return new;
    end if;

    if new.intercompany_counterparty_company_id is null then
      raise exception 'INTERCOMPANY_COUNTERPARTY_REQUIRED';
    end if;

    if new.intercompany_counterparty_company_id = new.company_id then
      raise exception 'INTERCOMPANY_COUNTERPARTY_INVALID';
    end if;

    perform 1
    from purchase_orders po
    where po.id = new.intercompany_purchase_order_id
      and po.company_id = new.intercompany_counterparty_company_id;

    if not found then
      raise exception 'INTERCOMPANY_LINK_MISMATCH';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_sales_orders_intercompany_link_check on sales_orders;
  create trigger trg_sales_orders_intercompany_link_check
  before insert or update of intercompany_counterparty_company_id, intercompany_purchase_order_id, company_id
  on sales_orders
  for each row
  execute function trg_check_intercompany_sales_order_link();
end $$;
