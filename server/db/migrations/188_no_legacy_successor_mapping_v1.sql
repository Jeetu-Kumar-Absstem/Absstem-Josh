-- 188: Correct the supersession semantics left by 187
--
-- 187 documented superseded_by_item_code as "legacy STD -> SH, legacy P -> UH". That is
-- wrong and has been withdrawn: the legacy size does not carry across the 12-Mar-2025
-- rename. nGEN 07 delivers 24 Nm3/hr at 99% purity where nGEN007SH delivers 35, a 46%
-- difference, and pairing on flow instead drifts just as far (nGEN 30 sits nearest
-- nGEN020SH, nGEN 40 nearest nGEN025SH). The ranges are different machines that share a
-- naming scheme.
--
-- No legacy -> current mapping is stored. superseded_by_item_code is reserved for exact
-- one-for-one renames of the same physical product, and stays null for the nGEN rename.
-- Replacement sizing is a fresh calculation from required flow and purity.

comment on column products.superseded_by_item_code is
  'item_code of the current SKU replacing this one, for exact one-for-one renames of the same physical product only. Null for the 12-Mar-2025 nGEN rename: legacy and current ranges are not interchangeable.';

comment on column products.superseded_on is
  'Date this SKU stopped being sold; 2025-03-12 for the nGEN rename. Set independently of superseded_by_item_code.';

-- Nothing populated it, but make the withdrawal explicit and re-runnable.
update products
set superseded_by_item_code = null
where superseded_by_item_code is not null
  and variant_key in ('STD', 'P');
