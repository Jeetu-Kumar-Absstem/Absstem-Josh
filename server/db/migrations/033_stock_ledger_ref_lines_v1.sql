alter table stock_movements
add column if not exists ref_line_id integer;

drop index if exists idx_stock_movements_ref_unique;

create unique index if not exists idx_stock_movements_ref_line_unique
on stock_movements(ref_type, ref_id, ref_line_id)
where ref_line_id is not null;
