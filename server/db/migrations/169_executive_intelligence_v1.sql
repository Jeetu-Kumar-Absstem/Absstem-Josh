-- 169: Executive Intelligence & Real-Time Operational BI Dashboards (Phase 9)

-- Screen permissions for executive_command
insert into screen_permissions (role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking)
select r.id, 'executive_command', true, true, true, false, false, false
from roles r
where r.role_key in ('super_admin', 'cfo', 'ceo', 'management', 'executive', 'commercial_head', 'finance_manager', 'accounts_head')
on conflict (role_id, screen_key) do update
set can_view = true, can_create = true, can_edit = true;
