-- How product-group scope PDFs (annexures) go out with a quote revision.
-- null keeps the older merge_annexures behaviour; 'none' leaves them out of the PDF and the email.
alter table quote_revisions add column if not exists annexure_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quote_revisions_annexure_mode_chk'
  ) then
    alter table quote_revisions
      add constraint quote_revisions_annexure_mode_chk
      check (annexure_mode is null or annexure_mode in ('merged', 'separate', 'none'));
  end if;
end $$;

-- Editable product-family write-ups for the quote PDF technical section.
-- A row overrides the built-in text for its content_key; fields left null fall back to the built-in text.
create table if not exists quote_family_content (
  content_key text primary key,
  title text,
  tagline text,
  source_url text,
  write_up text,
  unique_features jsonb,
  design_rows jsonb,
  is_active boolean not null default true,
  updated_by integer references erp_users(id),
  updated_at timestamptz not null default now()
);
