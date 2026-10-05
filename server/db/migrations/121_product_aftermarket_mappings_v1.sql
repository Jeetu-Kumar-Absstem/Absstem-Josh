do $$
begin
  create table if not exists product_aftermarket_mappings (
    id serial primary key,
    company_id integer not null references companies(id) on delete cascade,
    parent_product_id integer not null references products(id) on delete cascade,
    replacement_product_id integer not null references products(id) on delete restrict,
    mapping_type text not null default 'consumable',
    qty_per_parent numeric(18, 4) not null default 1,
    is_recommended boolean not null default true,
    is_mandatory boolean not null default false,
    service_interval_hours integer,
    service_interval_days integer,
    notes text,
    is_active boolean not null default true,
    created_by integer references erp_users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, parent_product_id, replacement_product_id, mapping_type),
    check (mapping_type in ('consumable', 'spare', 'service_kit', 'replacement')),
    check (qty_per_parent > 0),
    check (service_interval_hours is null or service_interval_hours > 0),
    check (service_interval_days is null or service_interval_days > 0),
    check (parent_product_id <> replacement_product_id)
  );

  create index if not exists idx_product_aftermarket_mappings_parent
    on product_aftermarket_mappings(company_id, parent_product_id);

  create index if not exists idx_product_aftermarket_mappings_replacement
    on product_aftermarket_mappings(company_id, replacement_product_id);

  create index if not exists idx_product_aftermarket_mappings_active
    on product_aftermarket_mappings(company_id, is_active, is_recommended);

  create or replace function trg_validate_product_aftermarket_mapping()
  returns trigger
  language plpgsql
  as $fn$
  declare
    parent_company_id integer;
    replacement_company_id integer;
  begin
    select p.company_id
      into parent_company_id
    from company_product_policies p
    where p.company_id = new.company_id
      and p.product_id = new.parent_product_id
    limit 1;

    select p.company_id
      into replacement_company_id
    from company_product_policies p
    where p.company_id = new.company_id
      and p.product_id = new.replacement_product_id
    limit 1;

    if parent_company_id is null then
      raise exception 'AFTERMARKET_PARENT_PRODUCT_NOT_IN_COMPANY_SCOPE';
    end if;

    if replacement_company_id is null then
      raise exception 'AFTERMARKET_REPLACEMENT_PRODUCT_NOT_IN_COMPANY_SCOPE';
    end if;

    return new;
  end;
  $fn$;

  drop trigger if exists trg_product_aftermarket_mappings_validate on product_aftermarket_mappings;
  create trigger trg_product_aftermarket_mappings_validate
  before insert or update of company_id, parent_product_id, replacement_product_id
  on product_aftermarket_mappings
  for each row
  execute function trg_validate_product_aftermarket_mapping();
end $$;
