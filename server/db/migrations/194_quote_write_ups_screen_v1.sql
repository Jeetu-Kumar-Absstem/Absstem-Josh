-- 194: Quote Write-ups permission (family text on quote PDF technical pages).
-- Separate from Product Master so marketing can maintain wording without SKU, price or HSN rights.

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select
  r.id,
  'quote_write_ups',
  true,
  true,
  true,
  r.role_key in ('super_admin'),
  false,
  false
from roles r
where r.role_key in ('super_admin', 'marketing')
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;
