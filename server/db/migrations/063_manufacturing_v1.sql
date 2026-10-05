do $$
begin
  alter table products
    add column if not exists is_manufactured boolean not null default false,
    add column if not exists mfg_job_prefix text;

  alter table products drop constraint if exists products_mfg_job_prefix_check;
  alter table products drop constraint if exists products_mfg_job_prefix_chk;
  alter table products
    add constraint products_mfg_job_prefix_chk
    check (mfg_job_prefix is null or mfg_job_prefix in ('M', 'N', 'ID'));

  create table if not exists company_running_sequences (
    company_id integer not null references companies(id) on delete cascade,
    sequence_key text not null,
    current_number integer not null default 0,
    primary key (company_id, sequence_key)
  );

  create or replace function next_company_running_sequence(
    p_company_id integer,
    p_sequence_key text,
    p_prefix text,
    p_padding integer default 4
  )
  returns text
  language plpgsql
  as $fn$
  declare n integer;
  begin
    if p_company_id is null then
      raise exception 'company_id is required';
    end if;
    if p_sequence_key is null or length(trim(p_sequence_key)) = 0 then
      raise exception 'sequence_key is required';
    end if;
    if p_prefix is null then
      raise exception 'prefix is required';
    end if;

    insert into company_running_sequences (company_id, sequence_key, current_number)
    values (p_company_id, p_sequence_key, 0)
    on conflict (company_id, sequence_key) do nothing;

    update company_running_sequences
    set current_number = current_number + 1
    where company_id = p_company_id
      and sequence_key = p_sequence_key
    returning current_number into n;

    return p_prefix || lpad(n::text, greatest(coalesce(p_padding, 4), 1), '0');
  end;
  $fn$;

  create table if not exists manufacturing_boms (
    id serial primary key,
    company_id integer not null references companies(id) on delete cascade,
    bom_code text not null,
    finished_good_product_id integer not null references products(id) on delete restrict,
    revision_no integer not null default 1,
    is_active boolean not null default true,
    remarks text,
    created_by integer references erp_users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create unique index if not exists idx_manufacturing_boms_company_code_unique
    on manufacturing_boms(company_id, bom_code);
  create index if not exists idx_manufacturing_boms_company_fg
    on manufacturing_boms(company_id, finished_good_product_id);

  create table if not exists manufacturing_bom_lines (
    id serial primary key,
    bom_id integer not null references manufacturing_boms(id) on delete cascade,
    line_no integer not null,
    component_product_id integer not null references products(id) on delete restrict,
    item_code text,
    item_name text,
    uom text,
    qty_per numeric(18, 4) not null,
    remarks text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (bom_id, line_no),
    unique (bom_id, component_product_id),
    check (qty_per > 0)
  );

  create index if not exists idx_manufacturing_bom_lines_bom_id
    on manufacturing_bom_lines(bom_id);
  create index if not exists idx_manufacturing_bom_lines_component_product_id
    on manufacturing_bom_lines(component_product_id);

  alter table job_cards
    add column if not exists sales_order_id integer references sales_orders(id) on delete set null,
    add column if not exists sales_order_line_id integer references sales_order_lines(id) on delete set null,
    add column if not exists finished_good_product_id integer references products(id) on delete restrict,
    add column if not exists bom_id integer references manufacturing_boms(id) on delete set null,
    add column if not exists job_id text,
    add column if not exists job_prefix text,
    add column if not exists planned_output_qty numeric(18, 4) not null default 1,
    add column if not exists actual_output_qty numeric(18, 4) not null default 0,
    add column if not exists finished_good_receipt_date date;

  alter table job_cards drop constraint if exists job_cards_job_status_check;
  alter table job_cards
    add constraint job_cards_job_status_check
    check (job_status in ('draft', 'open', 'closed', 'cancelled', 'submitted', 'approved', 'posted'));

  alter table job_cards drop constraint if exists job_cards_job_type_check;
  alter table job_cards
    add constraint job_cards_job_type_check
    check (job_type in ('service', 'installation', 'internal_issue', 'manufacturing'));

  alter table job_cards drop constraint if exists job_cards_job_prefix_check;
  alter table job_cards
    add constraint job_cards_job_prefix_check
    check (job_prefix is null or job_prefix in ('M', 'N', 'ID'));

  alter table job_cards drop constraint if exists job_cards_output_qty_check;
  alter table job_cards
    add constraint job_cards_output_qty_check
    check (planned_output_qty > 0 and actual_output_qty >= 0);

  create index if not exists idx_job_cards_sales_order_id on job_cards(sales_order_id);
  create index if not exists idx_job_cards_sales_order_line_id on job_cards(sales_order_line_id);
  create index if not exists idx_job_cards_finished_good_product_id on job_cards(finished_good_product_id);
  create index if not exists idx_job_cards_bom_id on job_cards(bom_id);
  create unique index if not exists idx_job_cards_company_job_id_unique
    on job_cards(company_id, job_id)
    where job_id is not null;

  create or replace function trg_validate_manufacturing_job_card()
  returns trigger
  language plpgsql
  as $fn$
  declare so_company_id integer;
  declare so_line_product_id integer;
  declare bom_company_id integer;
  declare bom_fg_product_id integer;
  begin
    if new.job_type <> 'manufacturing' then
      return new;
    end if;

    if new.finished_good_product_id is null then
      raise exception 'FINISHED_GOOD_REQUIRED';
    end if;

    if new.job_id is null or length(trim(new.job_id)) = 0 then
      raise exception 'JOB_ID_REQUIRED';
    end if;

    if new.sales_order_line_id is not null then
      select so.company_id, sol.product_id
        into so_company_id, so_line_product_id
      from sales_order_lines sol
      join sales_orders so on so.id = sol.sales_order_id
      where sol.id = new.sales_order_line_id;

      if so_line_product_id is null then
        raise exception 'SALES_ORDER_LINE_NOT_FOUND';
      end if;

      if new.sales_order_id is null then
        new.sales_order_id := (select sales_order_id from sales_order_lines where id = new.sales_order_line_id limit 1);
      end if;

      if new.sales_order_id is distinct from (select sales_order_id from sales_order_lines where id = new.sales_order_line_id limit 1) then
        raise exception 'SALES_ORDER_LINE_MISMATCH';
      end if;

      if so_company_id is distinct from new.company_id then
        raise exception 'SALES_ORDER_COMPANY_MISMATCH';
      end if;

      if so_line_product_id is distinct from new.finished_good_product_id then
        raise exception 'FINISHED_GOOD_SO_LINE_MISMATCH';
      end if;
    end if;

    if new.bom_id is not null then
      select company_id, finished_good_product_id
        into bom_company_id, bom_fg_product_id
      from manufacturing_boms
      where id = new.bom_id;

      if bom_fg_product_id is null then
        raise exception 'BOM_NOT_FOUND';
      end if;

      if bom_company_id is distinct from new.company_id then
        raise exception 'BOM_COMPANY_MISMATCH';
      end if;

      if bom_fg_product_id is distinct from new.finished_good_product_id then
        raise exception 'BOM_FINISHED_GOOD_MISMATCH';
      end if;
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_job_cards_validate_manufacturing on job_cards;
  create trigger trg_job_cards_validate_manufacturing
  before insert or update of job_type, company_id, sales_order_id, sales_order_line_id, finished_good_product_id, bom_id, job_id
  on job_cards
  for each row
  execute function trg_validate_manufacturing_job_card();
end $$;
