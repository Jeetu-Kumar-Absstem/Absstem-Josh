create table if not exists hsn_tax_code_map (
  id serial primary key,
  hsn_no text not null unique,
  tax_code_id integer not null references tax_codes(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hsn_tax_code_map_active on hsn_tax_code_map(is_active);

insert into hsn_tax_code_map (hsn_no, tax_code_id)
select
  src.hsn_no,
  tc.id
from (
  select
    trim(hsn_no) as hsn_no,
    round(min(coalesce(gst_pct, 0))::numeric, 2) as gst_pct
  from products
  where nullif(trim(coalesce(hsn_no, '')), '') is not null
  group by trim(hsn_no)
  having count(distinct round(coalesce(gst_pct, 0)::numeric, 2)) = 1
) src
join lateral (
  select id
  from tax_codes
  where round(coalesce(tax_rate, 0)::numeric, 2) = src.gst_pct
  order by id asc
  limit 1
) tc on true
on conflict (hsn_no) do nothing;
