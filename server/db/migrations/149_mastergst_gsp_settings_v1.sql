-- Step 1: MasterGST GSP settings extensions for e-way (and future IRN).
-- Secrets stay in env; credential_env_key names the env var holding JSON credentials.

alter table company_einvoice_settings
  add column if not exists environment text;

update company_einvoice_settings
set environment = coalesce(nullif(trim(environment), ''), 'sandbox')
where environment is null or trim(environment) = '';

alter table company_einvoice_settings
  alter column environment set default 'sandbox';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'company_einvoice_settings_environment_check'
  ) then
    alter table company_einvoice_settings
      add constraint company_einvoice_settings_environment_check
      check (environment in ('sandbox', 'production'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'company_einvoice_settings_provider_check'
  ) then
    alter table company_einvoice_settings
      add constraint company_einvoice_settings_provider_check
      check (
        provider is null
        or lower(provider) in ('mastergst', 'manual', 'other')
      );
  end if;
end $$;

-- Allow distinct e-way event types on the existing audit table.
alter table einvoice_events drop constraint if exists einvoice_events_event_type_check;
alter table einvoice_events
  add constraint einvoice_events_event_type_check
  check (
    event_type in (
      'generate',
      'cancel',
      'manual_capture',
      'payload_download',
      'clear',
      'eway_generate',
      'eway_cancel'
    )
  );

-- Default MasterGST sandbox base URL hint for new rows (no credentials).
comment on column company_einvoice_settings.base_url is
  'MasterGST sandbox default: https://apisandbox.mastergst.com ; production: https://api.mastergst.com';
comment on column company_einvoice_settings.credential_env_key is
  'Name of env var whose value is JSON: email, client_id, client_secret, username, password, ip_address; optional mock:true for QA.';
