do $$
begin
  drop index if exists idx_stock_movements_ref_line_unique;

  create unique index if not exists idx_stock_movements_company_ref_line_unique
    on stock_movements(company_id, ref_type, ref_id, ref_line_id)
    where ref_line_id is not null;
end $$;

