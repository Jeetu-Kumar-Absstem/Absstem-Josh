-- Wave 2: Staff group, sales_executive screen baseline, access audit trail

insert into user_groups (group_name, max_autonomous_discount_pct, is_active)
values ('Staff', 25, true)
on conflict (group_name) do nothing;

create table if not exists user_access_audit (
  id serial primary key,
  actor_user_id integer references erp_users(id) on delete set null,
  target_user_id integer references erp_users(id) on delete set null,
  target_role_id integer references roles(id) on delete set null,
  action text not null,
  before_json jsonb not null default '{}'::jsonb,
  after_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_access_audit_created_at on user_access_audit(created_at);
create index if not exists idx_user_access_audit_target_user_id on user_access_audit(target_user_id);
create index if not exists idx_user_access_audit_target_role_id on user_access_audit(target_role_id);
create index if not exists idx_user_access_audit_actor_user_id on user_access_audit(actor_user_id);
create index if not exists idx_user_access_audit_action on user_access_audit(action);

insert into screen_permissions (
  role_id,
  screen_key,
  can_view,
  can_create,
  can_edit,
  can_approve,
  own_records_only,
  financial_masking
)
select
  r.id,
  s.screen_key,
  true,
  true,
  true,
  false,
  false,
  false
from roles r
cross join (
  values
    ('home'),
    ('leads'),
    ('quotes'),
    ('customers'),
    ('sales_orders'),
    ('sales_desk')
) as s(screen_key)
where r.role_key = 'sales_executive'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
