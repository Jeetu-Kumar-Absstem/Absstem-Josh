do $$
begin
  create table if not exists job_asset_bom_lines (
    id serial primary key,
    job_asset_id integer not null references job_assets(id) on delete cascade,
    bom_id integer references manufacturing_boms(id) on delete set null,
    manufacturing_bom_line_id integer references manufacturing_bom_lines(id) on delete set null,
    line_no integer not null,
    installed_product_id integer references products(id) on delete set null,
    installed_item_code text not null,
    installed_item_name text,
    uom text,
    qty_installed numeric(18, 4) not null default 0,
    remarks text,
    source_kind text not null default 'manufacturing_bom',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (job_asset_id, line_no),
    check (qty_installed > 0),
    check (length(trim(installed_item_code)) > 0),
    check (source_kind in ('manufacturing_bom', 'manual_snapshot', 'imported_bom', 'field_override'))
  );

  create index if not exists idx_job_asset_bom_lines_job_asset_id
    on job_asset_bom_lines(job_asset_id);

  create index if not exists idx_job_asset_bom_lines_bom_id
    on job_asset_bom_lines(bom_id);

  create index if not exists idx_job_asset_bom_lines_installed_product_id
    on job_asset_bom_lines(installed_product_id);

  create index if not exists idx_job_asset_bom_lines_item_code
    on job_asset_bom_lines(installed_item_code);

  create or replace function trg_validate_job_asset_bom_line()
  returns trigger
  language plpgsql
  as $fn$
  declare
    asset_company_id integer;
    bom_company_id integer;
    bom_fg_product_id integer;
    asset_fg_product_id integer;
    bom_line_bom_id integer;
    bom_line_product_id integer;
  begin
    select ja.company_id, ja.finished_good_product_id
      into asset_company_id, asset_fg_product_id
    from job_assets ja
    where ja.id = new.job_asset_id;

    if asset_company_id is null then
      raise exception 'JOB_ASSET_NOT_FOUND';
    end if;

    if new.bom_id is not null then
      select mb.company_id, mb.finished_good_product_id
        into bom_company_id, bom_fg_product_id
      from manufacturing_boms mb
      where mb.id = new.bom_id;

      if bom_company_id is null then
        raise exception 'JOB_ASSET_BOM_NOT_FOUND';
      end if;

      if bom_company_id is distinct from asset_company_id then
        raise exception 'JOB_ASSET_BOM_COMPANY_MISMATCH';
      end if;

      if asset_fg_product_id is not null and bom_fg_product_id is not null and asset_fg_product_id is distinct from bom_fg_product_id then
        raise exception 'JOB_ASSET_BOM_FINISHED_GOOD_MISMATCH';
      end if;
    end if;

    if new.manufacturing_bom_line_id is not null then
      select mbl.bom_id, mbl.component_product_id
        into bom_line_bom_id, bom_line_product_id
      from manufacturing_bom_lines mbl
      where mbl.id = new.manufacturing_bom_line_id;

      if bom_line_bom_id is null then
        raise exception 'JOB_ASSET_BOM_LINE_NOT_FOUND';
      end if;

      if new.bom_id is null then
        new.bom_id := bom_line_bom_id;
      elsif new.bom_id is distinct from bom_line_bom_id then
        raise exception 'JOB_ASSET_BOM_LINE_PARENT_MISMATCH';
      end if;

      if new.installed_product_id is null then
        new.installed_product_id := bom_line_product_id;
      elsif bom_line_product_id is not null and new.installed_product_id is distinct from bom_line_product_id then
        raise exception 'JOB_ASSET_BOM_LINE_PRODUCT_MISMATCH';
      end if;
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_job_asset_bom_lines_validate on job_asset_bom_lines;
  create trigger trg_job_asset_bom_lines_validate
  before insert or update of job_asset_id, bom_id, manufacturing_bom_line_id, installed_product_id
  on job_asset_bom_lines
  for each row
  execute function trg_validate_job_asset_bom_line();
end $$;
