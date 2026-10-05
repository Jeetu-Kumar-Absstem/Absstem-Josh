-- Phase 3: Executive control plane — trade show ROI, voice of market, board packs

-- ---------------------------------------------------------------------------
-- 1) Trade show campaigns (marketing ROI) — links to leads for CPL / closed-won
--    Complements marketing_exhibitions; optional exhibition bridge for continuity.
-- ---------------------------------------------------------------------------
create table if not exists trade_show_campaigns (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  event_name text not null,
  event_date date,
  total_spend numeric(14, 2) not null default 0,
  status text not null default 'Planned',
  marketing_exhibition_id integer references marketing_exhibitions(id) on delete set null,
  region text,
  notes text,
  created_by integer references erp_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_show_campaigns_status_check check (
    status in ('Planned', 'Active', 'Completed', 'Closed')
  ),
  constraint trade_show_campaigns_spend_check check (total_spend >= 0)
);

create index if not exists trade_show_campaigns_company_idx on trade_show_campaigns (company_id);
create index if not exists trade_show_campaigns_event_date_idx on trade_show_campaigns (event_date desc nulls last);
create index if not exists trade_show_campaigns_status_idx on trade_show_campaigns (status);

alter table leads
  add column if not exists trade_show_campaign_id bigint references trade_show_campaigns(id) on delete set null;

create index if not exists leads_trade_show_campaign_idx on leads (trade_show_campaign_id)
  where trade_show_campaign_id is not null;

-- ---------------------------------------------------------------------------
-- 2) Voice of market logs (executive intelligence)
-- ---------------------------------------------------------------------------
create table if not exists voice_of_market_logs (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  source_type text not null,
  submitted_by integer not null references erp_users(id) on delete restrict,
  customer_id integer references customers(id) on delete set null,
  distributor_id integer references distributors(id) on delete set null,
  feedback_notes text not null,
  strategic_category text not null,
  severity text not null default 'Info',
  is_highlighted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint voice_of_market_source_check check (
    source_type in ('Voice of Customer', 'Voice of Channel')
  ),
  constraint voice_of_market_severity_check check (
    severity in ('Info', 'Watch', 'Critical')
  )
);

create index if not exists voice_of_market_logs_company_idx on voice_of_market_logs (company_id);
create index if not exists voice_of_market_logs_source_idx on voice_of_market_logs (source_type);
create index if not exists voice_of_market_logs_category_idx on voice_of_market_logs (strategic_category);
create index if not exists voice_of_market_logs_created_idx on voice_of_market_logs (created_at desc);

-- ---------------------------------------------------------------------------
-- 3) Executive board packs (management manuscript)
-- ---------------------------------------------------------------------------
create table if not exists executive_board_packs (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  report_month date not null,
  generated_by integer not null references erp_users(id) on delete restrict,
  financial_summary_json jsonb not null default '{}'::jsonb,
  voc_summary_json jsonb not null default '{}'::jsonb,
  manuscript_json jsonb not null default '{}'::jsonb,
  status text not null default 'Draft',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint executive_board_packs_status_check check (status in ('Draft', 'Published')),
  constraint executive_board_packs_month_key unique (company_id, report_month)
);

create index if not exists executive_board_packs_month_idx on executive_board_packs (report_month desc);
create index if not exists executive_board_packs_status_idx on executive_board_packs (status);

-- ---------------------------------------------------------------------------
-- 4) Screen permissions — marketing + management (Phase 3 RBAC)
-- ---------------------------------------------------------------------------
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  sp.role_id,
  'marketing',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'marketing_desk'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  sp.role_id,
  'management',
  sp.can_view,
  sp.can_create,
  sp.can_edit,
  sp.can_approve,
  sp.own_records_only,
  sp.financial_masking
from screen_permissions sp
where sp.screen_key = 'marketing_desk'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;
