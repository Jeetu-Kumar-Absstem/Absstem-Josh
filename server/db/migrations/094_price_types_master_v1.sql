create table if not exists price_types (
  id serial primary key,
  price_type_code text not null unique,
  price_type_name text not null,
  multiplier numeric(12,4) not null default 1,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_price_types_is_active on price_types(is_active);
create index if not exists idx_price_types_sort_order on price_types(sort_order, price_type_name);

insert into price_types (price_type_code, price_type_name, multiplier, sort_order, is_active)
values
  ('list', 'List Price', 1.0000, 10, true),
  ('budget10', 'Budgetary +10%', 1.1000, 20, true),
  ('budget20', 'Budgetary +20%', 1.2000, 30, true),
  ('special14', 'Special 1.4', 1.4000, 40, true)
on conflict (price_type_code) do update
set
  price_type_name = excluded.price_type_name,
  multiplier = excluded.multiplier,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;
