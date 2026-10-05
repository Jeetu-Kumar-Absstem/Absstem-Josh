-- Phase 1 integrity: company-scoped unique lead phones + GRN location on stock movements

-- ---------------------------------------------------------------------------
-- H11: normalized unique phone on lead contacts (per company)
-- ---------------------------------------------------------------------------
alter table lead_contacts
  add column if not exists phone_digits text;

alter table lead_contacts
  add column if not exists company_id integer references companies(id) on delete cascade;

update lead_contacts lc
set company_id = l.company_id
from leads l
where l.id = lc.lead_id
  and (lc.company_id is distinct from l.company_id);

update lead_contacts
set phone_digits = case
  when nullif(btrim(coalesce(phone, '')), '') is null then null
  when length(regexp_replace(phone, '\D', '', 'g')) > 10
    then right(regexp_replace(phone, '\D', '', 'g'), 10)
  when length(regexp_replace(phone, '\D', '', 'g')) >= 7
    then regexp_replace(phone, '\D', '', 'g')
  else null
end
where phone_digits is distinct from case
  when nullif(btrim(coalesce(phone, '')), '') is null then null
  when length(regexp_replace(phone, '\D', '', 'g')) > 10
    then right(regexp_replace(phone, '\D', '', 'g'), 10)
  when length(regexp_replace(phone, '\D', '', 'g')) >= 7
    then regexp_replace(phone, '\D', '', 'g')
  else null
end;

-- Keep the oldest contact per company+digits; clear digits on later duplicates so the unique index can apply.
with ranked as (
  select
    lc.id,
    row_number() over (
      partition by lc.company_id, lc.phone_digits
      order by l.created_at asc nulls last, lc.id asc
    ) as rn
  from lead_contacts lc
  join leads l on l.id = lc.lead_id
  where lc.company_id is not null
    and lc.phone_digits is not null
    and length(lc.phone_digits) >= 7
)
update lead_contacts lc
set phone_digits = null
from ranked r
where r.id = lc.id
  and r.rn > 1;

create or replace function lead_contacts_sync_phone_company()
returns trigger
language plpgsql
as $$
declare
  digits text;
begin
  if new.company_id is null then
    select l.company_id into new.company_id
    from leads l
    where l.id = new.lead_id;
  end if;

  digits := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
  if digits is null or length(digits) = 0 then
    new.phone_digits := null;
  elsif length(digits) > 10 then
    new.phone_digits := right(digits, 10);
  elsif length(digits) >= 7 then
    new.phone_digits := digits;
  else
    new.phone_digits := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_lead_contacts_sync_phone_company on lead_contacts;
create trigger trg_lead_contacts_sync_phone_company
before insert or update of phone, lead_id, company_id
on lead_contacts
for each row
execute function lead_contacts_sync_phone_company();

create unique index if not exists idx_lead_contacts_company_phone_digits_uq
  on lead_contacts (company_id, phone_digits)
  where phone_digits is not null
    and length(phone_digits) >= 7
    and company_id is not null;

create index if not exists idx_lead_contacts_company_id
  on lead_contacts (company_id);

-- ---------------------------------------------------------------------------
-- M7: persist GRN line location onto stock movements
-- ---------------------------------------------------------------------------
alter table stock_movements
  add column if not exists location_id integer references stock_locations(id) on delete set null;

create index if not exists idx_stock_movements_location_id
  on stock_movements (location_id)
  where location_id is not null;
