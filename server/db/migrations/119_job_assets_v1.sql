do $$
begin
  create table if not exists job_assets (
    id serial primary key,
    company_id integer not null references companies(id) on delete cascade,
    customer_id integer not null references customers(id) on delete restrict,
    sales_order_id integer references sales_orders(id) on delete set null,
    sales_order_line_id integer references sales_order_lines(id) on delete set null,
    dispatch_id integer references dispatches(id) on delete set null,
    dispatch_line_id integer references dispatch_lines(id) on delete set null,
    job_card_id integer references job_cards(id) on delete set null,
    asset_status text not null default 'active',
    job_id text not null,
    serial_no text not null,
    asset_code text,
    asset_name text,
    finished_good_product_id integer references products(id) on delete set null,
    finished_good_item_code text,
    finished_good_item_name text,
    installation_date date,
    commissioning_date date,
    warranty_start_date date,
    warranty_end_date date,
    site_name text,
    site_address text,
    remarks text,
    created_by integer references erp_users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (asset_status in ('draft', 'active', 'inactive', 'scrapped')),
    check (length(trim(job_id)) > 0),
    check (length(trim(serial_no)) > 0),
    check (warranty_end_date is null or warranty_start_date is null or warranty_end_date >= warranty_start_date)
  );

  create unique index if not exists idx_job_assets_company_job_id_unique
    on job_assets(company_id, job_id);

  create unique index if not exists idx_job_assets_company_serial_no_unique
    on job_assets(company_id, serial_no);

  create unique index if not exists idx_job_assets_company_asset_code_unique
    on job_assets(company_id, asset_code)
    where asset_code is not null and length(trim(asset_code)) > 0;

  create index if not exists idx_job_assets_customer_id
    on job_assets(customer_id);

  create index if not exists idx_job_assets_sales_order_id
    on job_assets(sales_order_id);

  create index if not exists idx_job_assets_dispatch_id
    on job_assets(dispatch_id);

  create index if not exists idx_job_assets_job_card_id
    on job_assets(job_card_id);

  create index if not exists idx_job_assets_finished_good_product_id
    on job_assets(finished_good_product_id);

  create or replace function trg_validate_job_asset_integrity()
  returns trigger
  language plpgsql
  as $fn$
  declare
    so_company_id integer;
    so_customer_id integer;
    so_line_order_id integer;
    so_line_product_id integer;
    dispatch_company_id integer;
    dispatch_customer_id integer;
    dispatch_sales_order_id integer;
    dispatch_line_dispatch_id integer;
    dispatch_line_so_line_id integer;
    jc_company_id integer;
    jc_sales_order_id integer;
    jc_sales_order_line_id integer;
    jc_finished_good_product_id integer;
    jc_job_id text;
  begin
    if new.sales_order_id is not null then
      select so.company_id, so.customer_id
        into so_company_id, so_customer_id
      from sales_orders so
      where so.id = new.sales_order_id;

      if so_company_id is null then
        raise exception 'JOB_ASSET_SALES_ORDER_NOT_FOUND';
      end if;

      if so_company_id is distinct from new.company_id then
        raise exception 'JOB_ASSET_SALES_ORDER_COMPANY_MISMATCH';
      end if;

      if so_customer_id is distinct from new.customer_id then
        raise exception 'JOB_ASSET_SALES_ORDER_CUSTOMER_MISMATCH';
      end if;
    end if;

    if new.sales_order_line_id is not null then
      select sol.sales_order_id, sol.product_id
        into so_line_order_id, so_line_product_id
      from sales_order_lines sol
      where sol.id = new.sales_order_line_id;

      if so_line_order_id is null then
        raise exception 'JOB_ASSET_SALES_ORDER_LINE_NOT_FOUND';
      end if;

      if new.sales_order_id is null then
        new.sales_order_id := so_line_order_id;
      elsif new.sales_order_id is distinct from so_line_order_id then
        raise exception 'JOB_ASSET_SALES_ORDER_LINE_MISMATCH';
      end if;

      if new.finished_good_product_id is null then
        new.finished_good_product_id := so_line_product_id;
      elsif so_line_product_id is not null and new.finished_good_product_id is distinct from so_line_product_id then
        raise exception 'JOB_ASSET_FINISHED_GOOD_SO_LINE_MISMATCH';
      end if;
    end if;

    if new.dispatch_id is not null then
      select d.company_id, d.customer_id, d.sales_order_id
        into dispatch_company_id, dispatch_customer_id, dispatch_sales_order_id
      from dispatches d
      where d.id = new.dispatch_id;

      if dispatch_company_id is null then
        raise exception 'JOB_ASSET_DISPATCH_NOT_FOUND';
      end if;

      if dispatch_company_id is distinct from new.company_id then
        raise exception 'JOB_ASSET_DISPATCH_COMPANY_MISMATCH';
      end if;

      if dispatch_customer_id is distinct from new.customer_id then
        raise exception 'JOB_ASSET_DISPATCH_CUSTOMER_MISMATCH';
      end if;

      if new.sales_order_id is null then
        new.sales_order_id := dispatch_sales_order_id;
      elsif dispatch_sales_order_id is not null and new.sales_order_id is distinct from dispatch_sales_order_id then
        raise exception 'JOB_ASSET_DISPATCH_SALES_ORDER_MISMATCH';
      end if;
    end if;

    if new.dispatch_line_id is not null then
      select dl.dispatch_id, dl.sales_order_line_id
        into dispatch_line_dispatch_id, dispatch_line_so_line_id
      from dispatch_lines dl
      where dl.id = new.dispatch_line_id;

      if dispatch_line_dispatch_id is null then
        raise exception 'JOB_ASSET_DISPATCH_LINE_NOT_FOUND';
      end if;

      if new.dispatch_id is null then
        new.dispatch_id := dispatch_line_dispatch_id;
      elsif new.dispatch_id is distinct from dispatch_line_dispatch_id then
        raise exception 'JOB_ASSET_DISPATCH_LINE_DISPATCH_MISMATCH';
      end if;

      if new.sales_order_line_id is null then
        new.sales_order_line_id := dispatch_line_so_line_id;
      elsif dispatch_line_so_line_id is not null and new.sales_order_line_id is distinct from dispatch_line_so_line_id then
        raise exception 'JOB_ASSET_DISPATCH_LINE_SO_LINE_MISMATCH';
      end if;
    end if;

    if new.job_card_id is not null then
      select jc.company_id, jc.sales_order_id, jc.sales_order_line_id, jc.finished_good_product_id, jc.job_id
        into jc_company_id, jc_sales_order_id, jc_sales_order_line_id, jc_finished_good_product_id, jc_job_id
      from job_cards jc
      where jc.id = new.job_card_id;

      if jc_company_id is null then
        raise exception 'JOB_ASSET_JOB_CARD_NOT_FOUND';
      end if;

      if jc_company_id is distinct from new.company_id then
        raise exception 'JOB_ASSET_JOB_CARD_COMPANY_MISMATCH';
      end if;

      if jc_sales_order_id is not null then
        if new.sales_order_id is null then
          new.sales_order_id := jc_sales_order_id;
        elsif new.sales_order_id is distinct from jc_sales_order_id then
          raise exception 'JOB_ASSET_JOB_CARD_SALES_ORDER_MISMATCH';
        end if;
      end if;

      if jc_sales_order_line_id is not null then
        if new.sales_order_line_id is null then
          new.sales_order_line_id := jc_sales_order_line_id;
        elsif new.sales_order_line_id is distinct from jc_sales_order_line_id then
          raise exception 'JOB_ASSET_JOB_CARD_SALES_ORDER_LINE_MISMATCH';
        end if;
      end if;

      if jc_finished_good_product_id is not null then
        if new.finished_good_product_id is null then
          new.finished_good_product_id := jc_finished_good_product_id;
        elsif new.finished_good_product_id is distinct from jc_finished_good_product_id then
          raise exception 'JOB_ASSET_JOB_CARD_PRODUCT_MISMATCH';
        end if;
      end if;

      if jc_job_id is not null and length(trim(jc_job_id)) > 0 and new.job_id is distinct from jc_job_id then
        raise exception 'JOB_ASSET_JOB_CARD_JOB_ID_MISMATCH';
      end if;
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_job_assets_validate_integrity on job_assets;
  create trigger trg_job_assets_validate_integrity
  before insert or update of company_id, customer_id, sales_order_id, sales_order_line_id, dispatch_id, dispatch_line_id, job_card_id, finished_good_product_id, job_id
  on job_assets
  for each row
  execute function trg_validate_job_asset_integrity();
end $$;
