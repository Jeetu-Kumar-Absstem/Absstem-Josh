create table if not exists configurator_datasets (
  id serial primary key,
  dataset_key text not null unique,
  dataset_name text not null,
  is_active boolean not null default true,
  current_version_id integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists configurator_dataset_versions (
  id serial primary key,
  dataset_id integer not null references configurator_datasets(id) on delete cascade,
  version_no integer not null,
  file_name text,
  row_count integer not null default 0,
  content_json jsonb not null,
  created_by integer references erp_users(id),
  created_at timestamptz not null default now()
);

create unique index if not exists idx_configurator_dataset_versions_dataset_version
  on configurator_dataset_versions(dataset_id, version_no);

alter table configurator_datasets
  add constraint fk_configurator_datasets_current_version
  foreign key (current_version_id)
  references configurator_dataset_versions(id);
