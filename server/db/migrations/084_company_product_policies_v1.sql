do $$
begin
  create table if not exists company_product_policies (
    id serial primary key,
    company_id integer not null references companies(id) on delete cascade,
    product_id integer not null references products(id) on delete cascade,
    is_manufactured boolean not null default false,
    mfg_job_prefix text,
    sourcing_mode text not null default 'buy_external',
    intercompany_source_company_id integer references companies(id) on delete restrict,
    preferred_vendor_id integer references vendors(id) on delete set null,
    is_saleable boolean not null default true,
    is_purchaseable boolean not null default true,
    is_stocked boolean not null default true,
    remarks text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, product_id)
  );

  create index if not exists idx_company_product_policies_company_id
    on company_product_policies(company_id);
  create index if not exists idx_company_product_policies_product_id
    on company_product_policies(product_id);
  create index if not exists idx_company_product_policies_intercompany_source_company_id
    on company_product_policies(intercompany_source_company_id);

  alter table company_product_policies
    drop constraint if exists company_product_policies_mfg_job_prefix_chk;
  alter table company_product_policies
    add constraint company_product_policies_mfg_job_prefix_chk
    check (mfg_job_prefix is null or mfg_job_prefix in ('M', 'N', 'ID'));

  alter table company_product_policies
    drop constraint if exists company_product_policies_sourcing_mode_chk;
  alter table company_product_policies
    add constraint company_product_policies_sourcing_mode_chk
    check (sourcing_mode in ('manufacture', 'buy_external', 'buy_intercompany', 'service_only', 'blocked'));

  insert into company_product_policies (
    company_id,
    product_id,
    is_manufactured,
    mfg_job_prefix,
    sourcing_mode,
    is_saleable,
    is_purchaseable,
    is_stocked
  )
  select
    c.id as company_id,
    p.id as product_id,
    coalesce(p.is_manufactured, false) as is_manufactured,
    p.mfg_job_prefix,
    case
      when coalesce(p.is_manufactured, false) = true then 'manufacture'
      else 'buy_external'
    end as sourcing_mode,
    true as is_saleable,
    true as is_purchaseable,
    true as is_stocked
  from companies c
  cross join products p
  on conflict (company_id, product_id) do nothing;
end $$;

