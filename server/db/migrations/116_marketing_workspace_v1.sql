insert into erp_modules (module_key, module_name)
values ('marketing', 'Marketing')
on conflict (module_key) do update
set module_name = excluded.module_name;

insert into lead_sources (source_code, source_name, is_active)
values
  ('SOCIAL_MEDIA_AD', 'Social Media Ad', true),
  ('EXHIBITION', 'Exhibition', true),
  ('WEBSITE_FORM', 'Website Form', true),
  ('REFERRAL', 'Referral', true)
on conflict (source_code) do update
set source_name = excluded.source_name,
    is_active = excluded.is_active;

create table if not exists marketing_campaigns (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  campaign_name text not null,
  channel_type text not null default 'social_media',
  lead_source_id integer references lead_sources(id) on delete set null,
  city text,
  start_date date,
  end_date date,
  planned_budget numeric(14, 2) not null default 0,
  actual_spend numeric(14, 2) not null default 0,
  campaign_status text not null default 'planned',
  agency_name text,
  notes text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (channel_type in ('social_media', 'google_ads', 'email', 'whatsapp', 'referral', 'other')),
  check (campaign_status in ('planned', 'live', 'paused', 'closed'))
);

create index if not exists idx_marketing_campaigns_company_status
  on marketing_campaigns(company_id, campaign_status, start_date desc);

create table if not exists marketing_exhibitions (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  exhibition_name text not null,
  city text,
  venue text,
  stall_no text,
  organizer_name text,
  lead_source_id integer references lead_sources(id) on delete set null,
  start_date date,
  end_date date,
  planned_budget numeric(14, 2) not null default 0,
  actual_spend numeric(14, 2) not null default 0,
  exhibition_status text not null default 'planned',
  notes text,
  created_by integer references erp_users(id) on delete set null,
  updated_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (exhibition_status in ('planned', 'upcoming', 'live', 'follow_up', 'closed'))
);

create index if not exists idx_marketing_exhibitions_company_status
  on marketing_exhibitions(company_id, exhibition_status, start_date desc);

alter table leads
  add column if not exists marketing_campaign_id integer references marketing_campaigns(id) on delete set null,
  add column if not exists marketing_exhibition_id integer references marketing_exhibitions(id) on delete set null;

create index if not exists idx_leads_marketing_campaign_id on leads(marketing_campaign_id);
create index if not exists idx_leads_marketing_exhibition_id on leads(marketing_exhibition_id);
