create table if not exists attachments (
  id serial primary key,
  file_name text not null,
  file_path text not null,
  mime_type text,
  file_size_bytes bigint,
  uploaded_by integer references erp_users(id),
  created_at timestamptz not null default now()
);

create table if not exists document_templates (
  id serial primary key,
  template_key text not null unique,
  template_type text not null,
  attachment_id integer references attachments(id),
  version_no integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_group_scope_templates (
  id serial primary key,
  product_group_id integer not null unique references product_groups(id) on delete cascade,
  template_id integer not null references document_templates(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists distributor_letterheads (
  id serial primary key,
  distributor_id integer not null unique references distributors(id) on delete cascade,
  template_id integer not null references document_templates(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists quote_revision_templates (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  template_role text not null,
  template_id integer not null references document_templates(id),
  product_group_id integer references product_groups(id),
  created_at timestamptz not null default now(),
  check (template_role in ('letterhead', 'scope', 'terms'))
);

create index if not exists idx_quote_revision_templates_quote_revision_id on quote_revision_templates(quote_revision_id);
