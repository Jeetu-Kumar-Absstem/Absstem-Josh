create table if not exists designations (
  id serial primary key,
  designation_name citext not null unique,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_designations_is_active on designations(is_active);
create index if not exists idx_designations_sort_order on designations(sort_order);

insert into designations (designation_name)
select distinct trim(designation)
from erp_users
where designation is not null and trim(designation) <> ''
on conflict (designation_name) do nothing;
