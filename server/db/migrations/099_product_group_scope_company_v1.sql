alter table product_group_scope_templates
  add column if not exists company_id integer references companies(id) on delete cascade;

alter table product_group_scope_templates
  drop constraint if exists product_group_scope_templates_product_group_id_key;

create unique index if not exists uq_product_group_scope_templates_global
  on product_group_scope_templates(product_group_id)
  where company_id is null;

create unique index if not exists uq_product_group_scope_templates_company
  on product_group_scope_templates(product_group_id, company_id)
  where company_id is not null;

create index if not exists idx_product_group_scope_templates_company_id
  on product_group_scope_templates(company_id);
