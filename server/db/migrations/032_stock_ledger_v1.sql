create table if not exists stock_movements (
  id serial primary key,
  product_id integer not null references products(id),
  qty_signed numeric(18, 4) not null,
  movement_date date not null default current_date,
  ref_type text not null,
  ref_id integer,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_movements_product_id on stock_movements(product_id);
create index if not exists idx_stock_movements_ref on stock_movements(ref_type, ref_id);

create unique index if not exists idx_stock_movements_ref_unique
on stock_movements(ref_type, ref_id, product_id);

create table if not exists stock_balances (
  product_id integer primary key references products(id) on delete cascade,
  stock_qty numeric(18, 4) not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists idx_stock_balances_stock_qty on stock_balances(stock_qty);
