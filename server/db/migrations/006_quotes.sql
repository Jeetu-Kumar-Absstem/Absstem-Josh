create table if not exists quote_headers (
  id serial primary key,
  quote_number text unique,
  customer_id integer not null references customers(id),
  distributor_id integer references distributors(id),
  attention_to text,
  quote_status text not null default 'draft',
  created_by integer references erp_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function set_quote_number()
returns trigger
language plpgsql
as $$
begin
  if new.quote_number is null or length(trim(new.quote_number)) = 0 then
    new.quote_number := next_document_number('QUOTE');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_quote_headers_set_number on quote_headers;
create trigger trg_quote_headers_set_number
before insert on quote_headers
for each row
execute function set_quote_number();

create table if not exists quote_revisions (
  id serial primary key,
  quote_id integer not null references quote_headers(id) on delete cascade,
  revision_no integer not null,
  revision_status text not null default 'draft',
  amendment_reason text,
  pricing_display_mode text not null default 'detailed',
  is_export boolean not null default false,
  incoterm_id integer references incoterms(id),
  base_currency_id integer not null references currencies(id),
  quote_currency_id integer not null references currencies(id),
  payment_term_id integer references payment_terms(id),
  freight_term_id integer references freight_terms(id),
  subtotal_base numeric(18, 2) not null default 0,
  subtotal_quote numeric(18, 2) not null default 0,
  tax_total_base numeric(18, 2) not null default 0,
  tax_total_quote numeric(18, 2) not null default 0,
  grand_total_base numeric(18, 2) not null default 0,
  grand_total_quote numeric(18, 2) not null default 0,
  prepared_by integer references erp_users(id),
  prepared_at timestamptz not null default now(),
  issued_at timestamptz,
  locked_at timestamptz,
  is_latest boolean not null default true,
  unique (quote_id, revision_no),
  check (pricing_display_mode in ('detailed', 'bundled_total', 'group_subtotals')),
  check (is_export = false or (tax_total_base = 0 and tax_total_quote = 0))
);

create index if not exists idx_quote_revisions_quote_id on quote_revisions(quote_id);
create index if not exists idx_quote_revisions_status on quote_revisions(revision_status);

create table if not exists quote_lines (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  line_no integer not null,
  product_id integer references products(id),
  item_code text,
  item_name text,
  line_description text,
  hsn_no text,
  qty numeric(18, 4) not null default 1,
  unit_price_base numeric(18, 4) not null default 0,
  unit_price_quote numeric(18, 4) not null default 0,
  gst_pct numeric(5, 2) not null default 0,
  line_total_base numeric(18, 2) not null default 0,
  line_total_quote numeric(18, 2) not null default 0,
  scope_type text not null default 'included',
  unique (quote_revision_id, line_no),
  check (qty > 0),
  check (scope_type in ('included', 'client_scope', 'quoted_separately'))
);

create index if not exists idx_quote_lines_quote_revision_id on quote_lines(quote_revision_id);
create index if not exists idx_quote_lines_product_id on quote_lines(product_id);

create table if not exists quote_offer_lines (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  line_no integer not null,
  display_text text not null,
  gst_pct numeric(5, 2) not null default 0,
  amount_base numeric(18, 2) not null default 0,
  amount_quote numeric(18, 2) not null default 0,
  unique (quote_revision_id, line_no)
);

create index if not exists idx_quote_offer_lines_quote_revision_id on quote_offer_lines(quote_revision_id);

create table if not exists quote_approvals (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  approval_type text not null,
  approval_status text not null default 'pending',
  approver_role_id integer references roles(id),
  approver_user_id integer references erp_users(id),
  approved_at timestamptz,
  remarks text,
  sequence_no integer not null default 1
);

create index if not exists idx_quote_approvals_quote_revision_id on quote_approvals(quote_revision_id);

create table if not exists quote_recipients (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  recipient_type text not null,
  contact_name text not null,
  email citext not null
);

create index if not exists idx_quote_recipients_quote_revision_id on quote_recipients(quote_revision_id);

create table if not exists quote_documents (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  document_type text not null,
  file_path text not null,
  generated_at timestamptz not null default now(),
  generated_by integer references erp_users(id)
);

create index if not exists idx_quote_documents_quote_revision_id on quote_documents(quote_revision_id);
