-- 164: External vendor portal, statutory compliance, and dual-path RFQ submission

create table if not exists vendor_users (
  id bigserial primary key,
  vendor_id integer not null references vendors(id) on delete cascade,
  email text not null,
  password_salt text not null,
  password_hash text not null,
  password_algo text not null default 'scrypt',
  status text not null default 'pending',
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (vendor_id, email),
  constraint vendor_users_status_check check (status in ('pending', 'active', 'suspended')),
  constraint vendor_users_password_algo_check check (password_algo = 'scrypt')
);

create unique index if not exists vendor_users_email_unique
  on vendor_users (lower(email));

create index if not exists vendor_users_vendor_status_idx
  on vendor_users (vendor_id, status);

create table if not exists vendor_onboarding_tokens (
  id bigserial primary key,
  token_hash text not null unique,
  vendor_id integer not null references vendors(id) on delete cascade,
  vendor_email text not null,
  expires_at timestamptz not null,
  is_used boolean not null default false,
  used_at timestamptz,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint vendor_onboarding_tokens_expiry_check check (expires_at > created_at)
);

create index if not exists vendor_onboarding_tokens_vendor_idx
  on vendor_onboarding_tokens (vendor_id, expires_at, is_used);

alter table vendor_users
  add column if not exists onboarding_token_id bigint references vendor_onboarding_tokens(id) on delete set null;

create table if not exists vendor_documents (
  id bigserial primary key,
  vendor_id integer references vendors(id) on delete cascade,
  vendor_user_id bigint references vendor_users(id) on delete set null,
  guest_rfq_token_id bigint,
  vendor_email text,
  document_type text not null,
  file_path text not null,
  file_name text not null,
  mime_type text not null,
  file_size_bytes bigint not null default 0,
  file_size_kb integer,
  expiry_date date,
  verification_status text not null default 'pending',
  verified_by integer references erp_users(id) on delete set null,
  verified_at timestamptz,
  is_mandatory boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_documents_status_check check (verification_status in ('pending', 'approved', 'expired', 'rejected')),
  constraint vendor_documents_type_check check (
    upper(document_type) in (
      'GST', 'GST_CERTIFICATE', 'PAN', 'PAN_CARD', 'MSME',
      'ISO', 'ISO_9001', 'ISO_CERTIFICATE', 'BANK_PROOF', 'OTHER'
    )
  ),
  constraint vendor_documents_owner_check check (vendor_id is not null or vendor_email is not null)
);

create index if not exists vendor_documents_vendor_idx
  on vendor_documents (vendor_id, document_type, expiry_date);

create index if not exists vendor_documents_status_idx
  on vendor_documents (verification_status, expiry_date);

alter table vendor_quotes
  add column if not exists vendor_user_id bigint references vendor_users(id) on delete set null,
  add column if not exists guest_rfq_token_id bigint,
  add column if not exists verification_status text not null default 'internal_verified',
  add column if not exists submitted_at timestamptz,
  add column if not exists verified_by integer references erp_users(id) on delete set null,
  add column if not exists verified_at timestamptz,
  add column if not exists verification_notes text;

alter table vendor_quotes
  drop constraint if exists vendor_quotes_received_via_check;

alter table vendor_quotes
  add constraint vendor_quotes_received_via_check
  check (received_via in ('manual', 'rfq', 'email', 'portal', 'guest_portal'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'vendor_quotes_verification_status_check'
      and conrelid = 'vendor_quotes'::regclass
  ) then
    alter table vendor_quotes
      add constraint vendor_quotes_verification_status_check
      check (verification_status in ('internal_verified', 'pending_portal_verification', 'pending_guest_verification', 'rejected'));
  end if;
end $$;

create index if not exists vendor_quotes_verification_idx
  on vendor_quotes (verification_status, purchase_rfq_id);

alter table vendor_quote_lines
  add column if not exists component_specification_id bigint references component_specifications(id) on delete set null,
  add column if not exists component_specification_avl_id bigint references component_specification_avl(id) on delete set null;

create index if not exists vendor_quote_lines_component_spec_idx
  on vendor_quote_lines (component_specification_id)
  where component_specification_id is not null;

create table if not exists guest_rfq_tokens (
  id bigserial primary key,
  token_hash text not null unique,
  rfq_id integer not null references purchase_rfqs(id) on delete cascade,
  purchase_rfq_vendor_id integer references purchase_rfq_vendors(id) on delete cascade,
  vendor_id integer references vendors(id) on delete set null,
  vendor_email text not null,
  expires_at timestamptz not null,
  is_used boolean not null default false,
  used_at timestamptz,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint guest_rfq_tokens_expiry_check check (expires_at > created_at)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'vendor_documents_guest_token_fk'
      and conrelid = 'vendor_documents'::regclass
  ) then
    alter table vendor_documents
      add constraint vendor_documents_guest_token_fk
      foreign key (guest_rfq_token_id) references guest_rfq_tokens(id) on delete set null;
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'vendor_quotes_guest_token_fk'
      and conrelid = 'vendor_quotes'::regclass
  ) then
    alter table vendor_quotes
      add constraint vendor_quotes_guest_token_fk
      foreign key (guest_rfq_token_id) references guest_rfq_tokens(id) on delete set null;
  end if;
end $$;

create index if not exists guest_rfq_tokens_rfq_idx
  on guest_rfq_tokens (rfq_id, expires_at, is_used);

create index if not exists guest_rfq_tokens_vendor_idx
  on guest_rfq_tokens (vendor_id, vendor_email);

comment on column guest_rfq_tokens.token_hash is
  'SHA-256 hash of the one-time bearer token; raw tokens are never persisted.';

comment on column vendor_onboarding_tokens.token_hash is
  'SHA-256 hash of the one-time onboarding token; raw tokens are never persisted.';

comment on column vendor_documents.is_mandatory is
  'Internal compliance flag; GST/PAN document types are mandatory by default in the portal guardrail.';
