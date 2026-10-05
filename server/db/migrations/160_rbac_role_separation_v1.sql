-- RBAC separation: SuperAdmin vs ERP (Business) Admin vs Office Admin facility screen

-- 1) Business Admin is not SuperAdmin — workspace family + demote mistaken SuperAdmin groups
update roles
set
  default_workspace_family = 'finance',
  updated_at = coalesce(updated_at, now())
where role_key = 'business_admin'
  and coalesce(default_workspace_family, '') = 'superadmin';

-- Users whose primary role is business_admin but group is SuperAdmin → Staff
update erp_users u
set
  group_id = staff.id,
  updated_at = now()
from roles r
join user_groups sa on sa.group_name = 'SuperAdmin'
join user_groups staff on staff.group_name = 'Staff' and staff.is_active = true
where u.primary_role_id = r.id
  and r.role_key = 'business_admin'
  and u.group_id = sa.id;

-- 2) Revoke facility office_admin from ERP Business Admin (must be granted explicitly if dual-hatted)
update screen_permissions sp
set
  can_view = false,
  can_create = false,
  can_edit = false,
  can_approve = false
from roles r
where sp.role_id = r.id
  and r.role_key = 'business_admin'
  and sp.screen_key = 'office_admin';

-- 3) Revoke users / user_access_preview write-style flags from business_admin
--    (Org & access API remains SuperAdmin-only; clear misleading grants)
update screen_permissions sp
set
  can_view = false,
  can_create = false,
  can_edit = false,
  can_approve = false
from roles r
where sp.role_id = r.id
  and r.role_key = 'business_admin'
  and sp.screen_key in ('users', 'user_access_preview', 'rights', 'onboarding', 'product_master', 'job_asset_admin');

-- Keep admin_masters + templates for business_admin (ERP Admin business rules)
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
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
cross join (values ('admin_masters'), ('templates')) as s(screen_key)
where r.role_key = 'business_admin'
on conflict (role_id, screen_key) do update
set
  can_view = true,
  can_create = true,
  can_edit = true,
  can_approve = false;

-- 4) Ensure office_admin is denied for common non-facility roles that inherited it via hr_desk clone (158)
--    Keep for HR role_key and roles with default_workspace_family = 'hr'
update screen_permissions sp
set
  can_view = false,
  can_create = false,
  can_edit = false,
  can_approve = false
from roles r
where sp.role_id = r.id
  and sp.screen_key = 'office_admin'
  and coalesce(r.role_key, '') not in ('hr', 'business_admin')
  and coalesce(r.default_workspace_family, '') is distinct from 'hr'
  and coalesce(r.role_key, '') not in ('super_admin');

-- Note: SuperAdmin group bypasses screen checks; super_admin role rows are irrelevant for runtime god-mode.
-- business_admin office_admin already revoked in step 2; step 4 skips re-touching if already false.

-- 5) Clear user-level overrides that grant platform admin screens to non–SuperAdmin users
delete from user_screen_permissions usp
using erp_users u
join user_groups ug on ug.id = u.group_id
where usp.user_id = u.id
  and ug.group_name is distinct from 'SuperAdmin'
  and usp.screen_key in (
    'users',
    'rights',
    'user_access_preview',
    'onboarding',
    'product_master',
    'job_asset_admin',
    'superadmin_home',
    'pilot_feedback'
  );
