-- P2: structured e-way bill capture on dispatches (Part A + Part B).
-- Complements customer_invoices.eway_* from migration 146; keeps eway_ref for back-compat.

alter table dispatches
  add column if not exists eway_bill_no text,
  add column if not exists eway_bill_date date,
  add column if not exists eway_valid_till timestamptz,
  add column if not exists transporter_id text,
  add column if not exists transport_mode text,
  add column if not exists vehicle_type text,
  add column if not exists approx_distance_km numeric(10, 2),
  add column if not exists ship_to_gstin text,
  add column if not exists lr_date date,
  add column if not exists dispatch_from_pincode text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dispatches_transport_mode_check') then
    alter table dispatches add constraint dispatches_transport_mode_check
      check (transport_mode is null or transport_mode in ('road', 'rail', 'air', 'ship'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dispatches_vehicle_type_check') then
    alter table dispatches add constraint dispatches_vehicle_type_check
      check (vehicle_type is null or vehicle_type in ('R', 'O'));
  end if;

  -- Vehicle type is a road-only NIC attribute; unset mode is allowed for partial capture.
  if not exists (select 1 from pg_constraint where conname = 'dispatches_vehicle_type_road_only_check') then
    alter table dispatches add constraint dispatches_vehicle_type_road_only_check
      check (vehicle_type is null or transport_mode is null or transport_mode = 'road');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dispatches_approx_distance_km_check') then
    alter table dispatches add constraint dispatches_approx_distance_km_check
      check (approx_distance_km is null or approx_distance_km >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'dispatches_eway_validity_order_check') then
    alter table dispatches add constraint dispatches_eway_validity_order_check
      check (
        eway_valid_till is null
        or eway_bill_date is null
        or eway_valid_till >= eway_bill_date::timestamptz
      );
  end if;
end $$;

-- Back-fill only values that look like a real 12-digit EBN.
update dispatches
set eway_bill_no = regexp_replace(trim(eway_ref), '\s+', '', 'g')
where eway_bill_no is null
  and regexp_replace(coalesce(trim(eway_ref), ''), '\s+', '', 'g') ~ '^[0-9]{12}$';

create index if not exists idx_dispatches_eway_bill_no
  on dispatches (company_id, eway_bill_no)
  where eway_bill_no is not null;

create index if not exists idx_dispatches_eway_valid_till
  on dispatches (company_id, eway_valid_till)
  where eway_valid_till is not null;
