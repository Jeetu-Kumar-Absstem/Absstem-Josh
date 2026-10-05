-- 186: Product family/module metadata + group defaults for modular quotes/PDFs

alter table products
  add column if not exists family_key text,
  add column if not exists module_role text,
  add column if not exists variant_key text;

alter table product_groups
  add column if not exists default_family_key text,
  add column if not exists default_module_role text,
  add column if not exists default_variant_key text;

alter table products drop constraint if exists products_family_key_chk;
alter table products
  add constraint products_family_key_chk
  check (
    family_key is null
    or family_key in ('NGEN', 'NGENX', 'MEDO', 'MEDO_C', 'IDOS', 'IDOS_C', 'SHIELD')
  );

alter table products drop constraint if exists products_module_role_chk;
alter table products
  add constraint products_module_role_chk
  check (
    module_role is null
    or module_role in (
      'generator',
      'air_system',
      'gas_storage',
      'booster',
      'shield',
      'accessory',
      'spare',
      'other'
    )
  );

alter table products drop constraint if exists products_variant_key_chk;
alter table products
  add constraint products_variant_key_chk
  check (variant_key is null or variant_key in ('HF', 'SH', 'UH'));

alter table product_groups drop constraint if exists product_groups_default_family_key_chk;
alter table product_groups
  add constraint product_groups_default_family_key_chk
  check (
    default_family_key is null
    or default_family_key in ('NGEN', 'NGENX', 'MEDO', 'MEDO_C', 'IDOS', 'IDOS_C', 'SHIELD')
  );

alter table product_groups drop constraint if exists product_groups_default_module_role_chk;
alter table product_groups
  add constraint product_groups_default_module_role_chk
  check (
    default_module_role is null
    or default_module_role in (
      'generator',
      'air_system',
      'gas_storage',
      'booster',
      'shield',
      'accessory',
      'spare',
      'other'
    )
  );

alter table product_groups drop constraint if exists product_groups_default_variant_key_chk;
alter table product_groups
  add constraint product_groups_default_variant_key_chk
  check (default_variant_key is null or default_variant_key in ('HF', 'SH', 'UH'));

create index if not exists idx_products_family_key on products(family_key);
create index if not exists idx_products_module_role on products(module_role);

-- Group-level defaults from naming
update product_groups pg
set
  default_family_key = case
    when lower(pg.group_name) ~ 'ngenx' then 'NGENX'
    when lower(pg.group_name) ~ 'ngen' then 'NGEN'
    when lower(pg.group_name) ~ 'medo[[:space:]_-]?c|medo c' then 'MEDO_C'
    when lower(pg.group_name) ~ 'medo|medical oxygen' then 'MEDO'
    when lower(pg.group_name) ~ 'idos[[:space:]_-]?c|idos c' then 'IDOS_C'
    when lower(pg.group_name) ~ 'idos|industrial oxygen' then 'IDOS'
    when lower(pg.group_name) ~ 'shield' then 'SHIELD'
    else default_family_key
  end,
  default_module_role = case
    when lower(pg.group_name) ~ 'booster' then 'booster'
    when lower(pg.group_name) ~ 'gas storage|storage vessel' then 'gas_storage'
    when lower(pg.group_name) ~ 'compressed air|air system|air package|air compressor' then 'air_system'
    when lower(pg.group_name) ~ 'shield' then 'shield'
    when lower(pg.group_name) ~ 'spare|service' then 'spare'
    when lower(pg.group_name) ~ 'generator|ngen|medo|idos|psa' then 'generator'
    else default_module_role
  end,
  default_variant_key = case
    when lower(pg.group_name) ~ 'ultra|uh' then 'UH'
    when lower(pg.group_name) ~ 'high flow|hf' then 'HF'
    when lower(pg.group_name) ~ 'high purity|sh' and lower(pg.group_name) !~ 'ultra' then 'SH'
    else default_variant_key
  end
where default_family_key is null
   or default_module_role is null
   or default_variant_key is null;

-- Product backfill from item/group/category text when unset
update products p
set
  family_key = coalesce(
    p.family_key,
    (
      select case
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'ngenx' then 'NGENX'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'ngen' then 'NGEN'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'medo[[:space:]_-]?c|medo c|custom psa medical' then 'MEDO_C'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'medo|medical oxygen' then 'MEDO'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'idos[[:space:]_-]?c|idos c|custom psa industrial' then 'IDOS_C'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'idos|industrial oxygen' then 'IDOS'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'shield' then 'SHIELD'
        else null
      end
      from product_groups pg
      left join product_categories pc on pc.id = p.category_id
      where pg.id = p.group_id
    ),
    (
      select pg.default_family_key from product_groups pg where pg.id = p.group_id
    )
  ),
  module_role = coalesce(
    p.module_role,
    (
      select case
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'booster' then 'booster'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'gas storage|storage vessel|nitrogen storage|oxygen storage' then 'gas_storage'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'compressed air|air system|air compressor|air package' then 'air_system'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'shield' then 'shield'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'spare' then 'spare'
        when lower(concat_ws(' ', p.item_code, p.item_name, pg.group_name, pc.category_name)) ~ 'generator|ngen|medo|idos|psa' then 'generator'
        else null
      end
      from product_groups pg
      left join product_categories pc on pc.id = p.category_id
      where pg.id = p.group_id
    ),
    (
      select pg.default_module_role from product_groups pg where pg.id = p.group_id
    )
  ),
  variant_key = coalesce(
    p.variant_key,
    case
      when upper(p.item_code) ~ 'UH' or lower(p.item_name) ~ 'ultra' then 'UH'
      when upper(p.item_code) ~ 'HF' or lower(p.item_name) ~ 'high[[:space:]-]?flow' then 'HF'
      when upper(p.item_code) ~ 'SH' or lower(p.item_name) ~ 'high[[:space:]-]?purity' then 'SH'
      else null
    end,
    (
      select pg.default_variant_key from product_groups pg where pg.id = p.group_id
    )
  )
where p.family_key is null
   or p.module_role is null
   or p.variant_key is null;

comment on column products.family_key is 'Explicit product family for configurator/PDF (NGEN, NGENX, MEDO, …)';
comment on column products.module_role is 'Package/module role for modular quote sections (generator, air_system, …)';
comment on column products.variant_key is 'Optional nGEN variant HF/SH/UH';
