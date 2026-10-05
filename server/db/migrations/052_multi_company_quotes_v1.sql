alter table quote_headers
add column if not exists company_id integer;

update quote_headers
set company_id = coalesce(company_id, company_id_by_code('AI'))
where company_id is null;

alter table quote_headers
alter column company_id set default company_id_by_code('AI');

alter table quote_headers
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'quote_headers_company_id_fkey'
      and table_name = 'quote_headers'
  ) then
    alter table quote_headers
    add constraint quote_headers_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_quote_headers_company_id on quote_headers(company_id);

alter table quote_revisions
add column if not exists company_id integer;

update quote_revisions qr
set company_id = qh.company_id
from quote_headers qh
where qh.id = qr.quote_id
  and qr.company_id is null;

alter table quote_revisions
alter column company_id set default company_id_by_code('AI');

alter table quote_revisions
alter column company_id set not null;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'quote_revisions_company_id_fkey'
      and table_name = 'quote_revisions'
  ) then
    alter table quote_revisions
    add constraint quote_revisions_company_id_fkey
    foreign key (company_id) references companies(id) on delete restrict;
  end if;
end $$;

create index if not exists idx_quote_revisions_company_id on quote_revisions(company_id);

create or replace function set_quote_revision_company_id()
returns trigger
language plpgsql
as $$
begin
  if new.company_id is null then
    select qh.company_id into new.company_id
    from quote_headers qh
    where qh.id = new.quote_id;
  end if;
  if new.company_id is null then
    new.company_id := company_id_by_code('AI');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_quote_revisions_set_company on quote_revisions;
create trigger trg_quote_revisions_set_company
before insert on quote_revisions
for each row
execute function set_quote_revision_company_id();

create or replace function set_quote_number()
returns trigger
language plpgsql
as $$
declare
  effective_company_id integer;
begin
  if new.quote_number is null or length(trim(new.quote_number)) = 0 then
    effective_company_id := coalesce(new.company_id, company_id_by_code('AI'));
    new.quote_number := next_company_document_number(effective_company_id, 'QUOTE');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_quote_headers_set_number on quote_headers;
create trigger trg_quote_headers_set_number
before insert on quote_headers
for each row
execute function set_quote_number();

