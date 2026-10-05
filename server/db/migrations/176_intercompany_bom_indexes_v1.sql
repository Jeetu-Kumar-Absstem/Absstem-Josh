-- Migration 176: Intercompany BOM Indexes & Performance Optimization
-- Optimizes cross-company fallback queries (e.g. AI resolving AT active locked recipes)

create index if not exists idx_mfg_boms_fg_lookup
  on manufacturing_boms(finished_good_product_id, is_active, revision_no desc, company_id);

comment on index idx_mfg_boms_fg_lookup is 'Optimizes local and intercompany fallback lookup of active manufacturing recipes per finished good';
