-- 187: Legacy nGEN purity variants + SKU supersession
--
-- Background: the AI nGEN range was renamed on 12-Mar-2025. Before that, purity was
-- expressed by an item-code suffix -- "nGEN 30" (standard, quoted 95-99.95%) and
-- "nGEN 30 P" (high purity, quoted 99.99-99.9995%). From 12-Mar-2025 the same span is
-- split three ways: HF (95-98%), SH (99-99.95%) and UH (99.99-99.999%).
--
-- 186 constrained products.variant_key to the new HF/SH/UH set, so the legacy builds
-- had nowhere to live. Machines commissioned before the rename must still reference the
-- SKU they were actually sold as, so we widen the variant set rather than remapping
-- history onto the new codes.

alter table products drop constraint if exists products_variant_key_chk;
alter table products
  add constraint products_variant_key_chk
  check (
    variant_key is null
    -- current range (12-Mar-2025 onward)
    or variant_key in ('HF', 'SH', 'UH')
    -- legacy range: STD = plain code, P = "P" suffix
    or variant_key in ('STD', 'P')
  );

alter table product_groups drop constraint if exists product_groups_default_variant_key_chk;
alter table product_groups
  add constraint product_groups_default_variant_key_chk
  check (
    default_variant_key is null
    or default_variant_key in ('HF', 'SH', 'UH', 'STD', 'P')
  );

-- Supersession: a retired SKU names the current SKU that replaces it. Kept as a code
-- rather than an id so the legacy row can be loaded before its successor exists, and so
-- the pointer survives a re-import of either side.
alter table products
  add column if not exists superseded_by_item_code text,
  add column if not exists superseded_on date;

alter table products drop constraint if exists products_superseded_by_self_chk;
alter table products
  add constraint products_superseded_by_self_chk
  check (
    superseded_by_item_code is null
    or upper(btrim(superseded_by_item_code)) <> upper(btrim(item_code))
  );

create index if not exists idx_products_superseded_by_item_code
  on products(superseded_by_item_code)
  where superseded_by_item_code is not null;

comment on column products.variant_key is
  'Purity variant. Current: HF/SH/UH. Legacy (pre 12-Mar-2025): STD (plain code), P ("P" suffix).';
comment on column products.superseded_by_item_code is
  'item_code of the current SKU replacing this retired one (legacy STD -> SH, legacy P -> UH).';
comment on column products.superseded_on is
  'Date this SKU stopped being sold; 2025-03-12 for the nGEN rename.';
