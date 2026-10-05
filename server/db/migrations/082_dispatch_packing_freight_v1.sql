do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'packing_list_no'
  ) then
    alter table dispatches add column packing_list_no text;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'packing_list_date'
  ) then
    alter table dispatches add column packing_list_date date;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'no_of_packages'
  ) then
    alter table dispatches add column no_of_packages integer;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'gross_weight'
  ) then
    alter table dispatches add column gross_weight numeric(14, 3);
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'net_weight'
  ) then
    alter table dispatches add column net_weight numeric(14, 3);
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'packing_remarks'
  ) then
    alter table dispatches add column packing_remarks text;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'freight_amount'
  ) then
    alter table dispatches add column freight_amount numeric(14, 2);
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'freight_bill_no'
  ) then
    alter table dispatches add column freight_bill_no text;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'freight_bill_date'
  ) then
    alter table dispatches add column freight_bill_date date;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'freight_paid_by'
  ) then
    alter table dispatches add column freight_paid_by text;
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dispatches'
      and column_name = 'pod_attachment_id'
  ) then
    alter table dispatches add column pod_attachment_id integer references attachments(id) on delete set null;
  end if;
end $$;

