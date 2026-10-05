insert into roles (role_key, role_name)
values ('marketing', 'Marketing')
on conflict (role_key) do update
set role_name = excluded.role_name;

insert into role_module_permissions (role_id, module_id, can_view, can_create, can_edit, can_approve)
select
  r.id,
  m.id,
  true,
  true,
  true,
  false
from roles r
join erp_modules m on m.module_key in ('marketing', 'leads')
where r.role_key = 'marketing'
on conflict (role_id, module_id) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

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
    ('marketing_desk'),
    ('campaigns'),
    ('exhibitions'),
    ('source_performance'),
    ('marketing_mailers'),
    ('leads')
) as s(screen_key)
where r.role_key = 'marketing'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve,
  own_records_only = excluded.own_records_only,
  financial_masking = excluded.financial_masking;
