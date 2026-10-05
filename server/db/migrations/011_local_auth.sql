create table if not exists user_credentials (
  user_id integer primary key references erp_users(id) on delete cascade,
  password_salt text not null,
  password_hash text not null,
  password_algo text not null default 'scrypt',
  updated_at timestamptz not null default now()
);

create table if not exists user_distributor_links (
  user_id integer primary key references erp_users(id) on delete cascade,
  distributor_id integer not null references distributors(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_distributor_links_distributor_id
  on user_distributor_links(distributor_id);

create table if not exists customer_distributor_links (
  customer_id integer not null references customers(id) on delete cascade,
  distributor_id integer not null references distributors(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (customer_id, distributor_id)
);

create index if not exists idx_customer_distributor_links_distributor_id
  on customer_distributor_links(distributor_id);

