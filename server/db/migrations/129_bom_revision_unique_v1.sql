-- Allow multiple BOM revisions under the same bom_code (company-scoped).
drop index if exists idx_manufacturing_boms_company_code_unique;

create unique index if not exists idx_manufacturing_boms_company_code_revision_unique
  on manufacturing_boms (company_id, bom_code, revision_no);
