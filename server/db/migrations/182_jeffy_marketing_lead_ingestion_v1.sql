-- 182: Jeffy Marketing & Lead Ingestion (M0–M5)
-- Dual-track status, touchpoints, geo routing, first-touch ROI, dormancy/Brevo.

insert into lead_sources (source_code, source_name, is_active)
values
  ('WEBSITE_FORM', 'Website Form', true),
  ('GOOGLE_LEAD_FORM', 'Google Lead Form', true),
  ('META_LEAD_FORM', 'Meta Lead Form', true),
  ('LINKEDIN_LEAD_FORM', 'LinkedIn Lead Form', true),
  ('WHATSAPP_API', 'WhatsApp API', true),
  ('TOLLFREE_TELEPHONY', 'Toll-free Telephony', true),
  ('QR_FORM', 'QR / Exhibition Form', true),
  ('EMAIL_INBOUND', 'Inbound Email Review', true),
  ('SOCIAL_MEDIA_AD', 'Social Media Ad', true),
  ('EXHIBITION', 'Exhibition', true),
  ('REFERRAL', 'Referral', true)
on conflict (source_code) do update
set source_name = excluded.source_name,
    is_active = true;

alter table leads
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists pincode text,
  add column if not exists country text,
  add column if not exists lifecycle_status text,
  add column if not exists sales_activity_status text,
  add column if not exists sales_temperature text,
  add column if not exists engagement_score numeric(10, 2) not null default 0,
  add column if not exists engagement_score_updated_at timestamptz,
  add column if not exists last_touchpoint_at timestamptz,
  add column if not exists last_sales_engagement_at timestamptz,
  add column if not exists dormant_since timestamptz,
  add column if not exists newsletter_segment text,
  add column if not exists brevo_contact_id text,
  add column if not exists first_touch_campaign_id integer references marketing_campaigns(id) on delete set null,
  add column if not exists last_touch_campaign_id integer references marketing_campaigns(id) on delete set null,
  add column if not exists first_touch_channel text,
  add column if not exists last_touch_channel text;

update leads
set lifecycle_status = case
      when status in ('order_won') then 'won'
      when status in ('lost') then 'lost'
      when status in ('closed', 'closed_no_action') then 'shelved'
      when status in ('cancelled') then 'cancelled'
      when status in ('quoted') then 'negotiation'
      when status in ('follow_up') then 'sql'
      when status in ('qualified') then 'mql'
      else 'new_lead'
    end
where lifecycle_status is null;

update leads
set sales_activity_status = case
      when status in ('order_won') then 'order_closed'
      when status in ('lost') then 'lost_order'
      when status in ('quoted') then 'quote_sent'
      when status in ('follow_up') then 'follow_up'
      when exists (
        select 1 from lead_activities la where la.lead_id = leads.id
      ) then 'contacted'
      else 'uncontacted'
    end
where sales_activity_status is null;

update leads
set sales_temperature = case
      when lower(coalesce(priority, '')) = 'high' then 'hot'
      when lower(coalesce(priority, '')) = 'low' then 'cold'
      else 'warm'
    end
where sales_temperature is null;

update leads
set last_sales_engagement_at = coalesce(
  (
    select max(la.activity_at)
    from lead_activities la
    where la.lead_id = leads.id
  ),
  updated_at,
  created_at
)
where last_sales_engagement_at is null;

update leads
set first_touch_campaign_id = coalesce(first_touch_campaign_id, marketing_campaign_id),
    last_touch_campaign_id = coalesce(last_touch_campaign_id, marketing_campaign_id),
    first_touch_channel = coalesce(first_touch_channel, 'manual'),
    last_touch_channel = coalesce(last_touch_channel, 'manual');

alter table leads
  alter column lifecycle_status set default 'new_lead',
  alter column sales_activity_status set default 'uncontacted',
  alter column sales_temperature set default 'warm';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_lifecycle_status_check'
  ) then
    alter table leads
      add constraint leads_lifecycle_status_check
      check (lifecycle_status in ('new_lead', 'mql', 'sql', 'negotiation', 'won', 'lost', 'shelved', 'cancelled'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'leads_sales_activity_status_check'
  ) then
    alter table leads
      add constraint leads_sales_activity_status_check
      check (sales_activity_status in ('uncontacted', 'contacted', 'follow_up', 'quote_sent', 'negotiation', 'order_closed', 'lost_order'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'leads_sales_temperature_check'
  ) then
    alter table leads
      add constraint leads_sales_temperature_check
      check (sales_temperature in ('hot', 'warm', 'cold'));
  end if;
end $$;

create index if not exists idx_leads_lifecycle_status on leads (company_id, lifecycle_status);
create index if not exists idx_leads_sales_activity on leads (company_id, sales_activity_status);
create index if not exists idx_leads_first_touch_campaign on leads (first_touch_campaign_id);
create index if not exists idx_leads_pincode on leads (company_id, pincode);

alter table lead_activities
  add column if not exists contact_outcome text;

create table if not exists lead_touchpoints (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  lead_id integer references leads(id) on delete cascade,
  channel text not null,
  occurred_at timestamptz not null default now(),
  lead_source_id integer references lead_sources(id) on delete set null,
  marketing_campaign_id integer references marketing_campaigns(id) on delete set null,
  marketing_exhibition_id integer references marketing_exhibitions(id) on delete set null,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  gclid text,
  fbclid text,
  li_fat_id text,
  external_event_id text,
  raw_payload jsonb,
  contact_name text,
  email text,
  phone text,
  phone_digits text,
  company_name text,
  city text,
  state text,
  pincode text,
  country text,
  match_method text,
  created_at timestamptz not null default now()
);

create unique index if not exists ux_lead_touchpoints_external
  on lead_touchpoints (company_id, channel, external_event_id)
  where external_event_id is not null;

create index if not exists idx_lead_touchpoints_lead_occurred
  on lead_touchpoints (lead_id, occurred_at desc);

create index if not exists idx_lead_touchpoints_phone
  on lead_touchpoints (company_id, phone_digits);

create table if not exists lead_ingestion_endpoints (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  channel text not null,
  api_key_hash text not null,
  default_campaign_id integer references marketing_campaigns(id) on delete set null,
  default_source_id integer references lead_sources(id) on delete set null,
  is_enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, channel)
);

create table if not exists india_pincodes (
  pincode text primary key,
  city_name text not null,
  state_name text not null,
  state_code text,
  country_code text not null default 'IN',
  district text,
  is_active boolean not null default true
);

insert into india_pincodes (pincode, city_name, state_name, state_code, district) values
  ('110001', 'New Delhi', 'Delhi', 'DL', 'New Delhi'),
  ('110016', 'New Delhi', 'Delhi', 'DL', 'South Delhi'),
  ('110017', 'New Delhi', 'Delhi', 'DL', 'South Delhi'),
  ('122001', 'Gurugram', 'Haryana', 'HR', 'Gurugram'),
  ('122002', 'Gurugram', 'Haryana', 'HR', 'Gurugram'),
  ('201301', 'Noida', 'Uttar Pradesh', 'UP', 'Gautam Buddha Nagar'),
  ('201304', 'Noida', 'Uttar Pradesh', 'UP', 'Gautam Buddha Nagar'),
  ('400001', 'Mumbai', 'Maharashtra', 'MH', 'Mumbai'),
  ('400051', 'Mumbai', 'Maharashtra', 'MH', 'Mumbai'),
  ('400070', 'Mumbai', 'Maharashtra', 'MH', 'Mumbai'),
  ('411001', 'Pune', 'Maharashtra', 'MH', 'Pune'),
  ('411014', 'Pune', 'Maharashtra', 'MH', 'Pune'),
  ('560001', 'Bengaluru', 'Karnataka', 'KA', 'Bengaluru Urban'),
  ('560066', 'Bengaluru', 'Karnataka', 'KA', 'Bengaluru Urban'),
  ('560100', 'Bengaluru', 'Karnataka', 'KA', 'Bengaluru Urban'),
  ('600001', 'Chennai', 'Tamil Nadu', 'TN', 'Chennai'),
  ('600032', 'Chennai', 'Tamil Nadu', 'TN', 'Chennai'),
  ('500001', 'Hyderabad', 'Telangana', 'TS', 'Hyderabad'),
  ('500081', 'Hyderabad', 'Telangana', 'TS', 'Hyderabad'),
  ('700001', 'Kolkata', 'West Bengal', 'WB', 'Kolkata'),
  ('700091', 'Kolkata', 'West Bengal', 'WB', 'Kolkata'),
  ('380001', 'Ahmedabad', 'Gujarat', 'GJ', 'Ahmedabad'),
  ('380015', 'Ahmedabad', 'Gujarat', 'GJ', 'Ahmedabad'),
  ('302001', 'Jaipur', 'Rajasthan', 'RJ', 'Jaipur'),
  ('160017', 'Chandigarh', 'Chandigarh', 'CH', 'Chandigarh'),
  ('226001', 'Lucknow', 'Uttar Pradesh', 'UP', 'Lucknow'),
  ('682001', 'Kochi', 'Kerala', 'KL', 'Ernakulam'),
  ('452001', 'Indore', 'Madhya Pradesh', 'MP', 'Indore'),
  ('141001', 'Ludhiana', 'Punjab', 'PB', 'Ludhiana'),
  ('800001', 'Patna', 'Bihar', 'BR', 'Patna'),
  ('751001', 'Bhubaneswar', 'Odisha', 'OD', 'Khordha'),
  ('781001', 'Guwahati', 'Assam', 'AS', 'Kamrup Metro'),
  ('395001', 'Surat', 'Gujarat', 'GJ', 'Surat'),
  ('440001', 'Nagpur', 'Maharashtra', 'MH', 'Nagpur'),
  ('302017', 'Jaipur', 'Rajasthan', 'RJ', 'Jaipur'),
  ('121001', 'Faridabad', 'Haryana', 'HR', 'Faridabad'),
  ('201009', 'Ghaziabad', 'Uttar Pradesh', 'UP', 'Ghaziabad'),
  ('248001', 'Dehradun', 'Uttarakhand', 'UK', 'Dehradun')
on conflict (pincode) do nothing;

create table if not exists sales_territories (
  id serial primary key,
  company_id integer not null references companies(id) on delete cascade,
  name text not null,
  circle_code text,
  match_type text not null default 'pincode_prefix',
  match_value text not null,
  priority integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (match_type in ('pincode_prefix', 'pincode', 'state', 'city'))
);

create index if not exists idx_sales_territories_company
  on sales_territories (company_id, is_active, priority);

create table if not exists sales_territory_agents (
  id serial primary key,
  territory_id integer not null references sales_territories(id) on delete cascade,
  user_id integer not null references erp_users(id) on delete cascade,
  is_default boolean not null default true,
  effective_from date,
  effective_to date,
  unique (territory_id, user_id)
);

create table if not exists lead_engagement_events (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  lead_id integer not null references leads(id) on delete cascade,
  event_type text not null,
  source_table text,
  source_id bigint,
  points integer not null default 0,
  occurred_at timestamptz not null default now(),
  meta jsonb
);

create index if not exists idx_lead_engagement_lead
  on lead_engagement_events (lead_id, occurred_at desc);

create unique index if not exists ux_lead_engagement_source
  on lead_engagement_events (lead_id, event_type, source_table, source_id)
  where source_id is not null;

create table if not exists lead_campaign_attributions (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  lead_id integer not null references leads(id) on delete cascade,
  campaign_id integer not null references marketing_campaigns(id) on delete cascade,
  role text not null default 'assist',
  attributed_at timestamptz not null default now(),
  check (role in ('first', 'last', 'assist')),
  unique (lead_id, campaign_id, role)
);

alter table marketing_campaigns
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists tracking_template text;

create table if not exists brevo_sync_logs (
  id bigserial primary key,
  company_id integer not null references companies(id) on delete cascade,
  action text not null,
  payload_summary text,
  status text not null default 'ok',
  error_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_brevo_sync_logs_company
  on brevo_sync_logs (company_id, created_at desc);

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  sp.role_id,
  s.screen_key,
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
cross join (
  values
    ('lead_ingestion'),
    ('geo_territories'),
    ('lead_scoring'),
    ('dormancy_segments')
) as s(screen_key)
where sp.screen_key = 'marketing_desk'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
