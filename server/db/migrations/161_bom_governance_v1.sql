-- 161: BOM Governance Protocol — lifecycle lock + engineering_approver

alter table manufacturing_boms
  add column if not exists lifecycle_state text not null default 'Draft',
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by bigint references erp_users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'manufacturing_boms_lifecycle_state_check'
  ) then
    alter table manufacturing_boms
      add constraint manufacturing_boms_lifecycle_state_check
      check (lifecycle_state in ('Draft', 'Pending Review', 'Locked/Active'));
  end if;
end $$;

-- Existing active masters become Locked/Active; inactive revs stay Draft archive
update manufacturing_boms
set lifecycle_state = 'Locked/Active',
    approved_at = coalesce(approved_at, updated_at, created_at, now())
where is_active = true
  and lifecycle_state = 'Draft';

create index if not exists manufacturing_boms_lifecycle_idx
  on manufacturing_boms (company_id, lifecycle_state);

-- Persona: engineering_approver (BOM / engineering gate)
insert into roles (role_key, role_name, default_workspace_family)
values ('engineering_approver', 'Engineering Approver', 'operations')
on conflict (role_key) do update
set role_name = excluded.role_name,
    default_workspace_family = excluded.default_workspace_family;

-- Screen grants: view/create/edit + can_approve on manufacturing_boms
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, true, true, s.can_approve, false, false
from roles r
cross join (
  values
    ('home', false),
    ('manufacturing_boms', true),
    ('engineering_desk', false),
    ('job_cards', false),
    ('quality_control', false)
) as s(screen_key, can_approve)
where r.role_key = 'engineering_approver'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

-- Ensure design_engineer cannot approve locked masters via can_approve
update screen_permissions sp
set can_approve = false
from roles r
where sp.role_id = r.id
  and r.role_key = 'design_engineer'
  and sp.screen_key = 'manufacturing_boms';
