alter table quote_headers
  add column if not exists job_asset_id integer references job_assets(id) on delete set null,
  add column if not exists quote_job_id text,
  add column if not exists quote_serial_no text;

create index if not exists idx_quote_headers_job_asset_id
  on quote_headers(job_asset_id);

create or replace function trg_validate_quote_job_asset()
returns trigger
language plpgsql
as $$
declare
  asset_company_id integer;
  asset_customer_id integer;
  asset_job_id text;
  asset_serial_no text;
begin
  if new.job_asset_id is null then
    return new;
  end if;

  select ja.company_id, ja.customer_id, ja.job_id, ja.serial_no
    into asset_company_id, asset_customer_id, asset_job_id, asset_serial_no
  from job_assets ja
  where ja.id = new.job_asset_id;

  if asset_company_id is null then
    raise exception 'QUOTE_JOB_ASSET_NOT_FOUND';
  end if;

  if asset_company_id is distinct from new.company_id then
    raise exception 'QUOTE_JOB_ASSET_COMPANY_MISMATCH';
  end if;

  if asset_customer_id is distinct from new.customer_id then
    raise exception 'QUOTE_JOB_ASSET_CUSTOMER_MISMATCH';
  end if;

  new.quote_job_id := coalesce(nullif(trim(new.quote_job_id), ''), asset_job_id);
  new.quote_serial_no := coalesce(nullif(trim(new.quote_serial_no), ''), asset_serial_no);

  return new;
end;
$$;

drop trigger if exists trg_quote_headers_validate_job_asset on quote_headers;
create trigger trg_quote_headers_validate_job_asset
before insert or update of company_id, customer_id, job_asset_id, quote_job_id, quote_serial_no
on quote_headers
for each row
execute function trg_validate_quote_job_asset();
