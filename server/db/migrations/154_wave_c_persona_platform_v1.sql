-- Wave C: workspace families (marketing/hr/stores/distributor), role baselines, business_admin

-- ---------------------------------------------------------------------------
-- C3: Expand workspace_family CHECK + backfill
-- ---------------------------------------------------------------------------
alter table roles
  drop constraint if exists roles_default_workspace_family_check;

alter table roles
  add constraint roles_default_workspace_family_check
  check (
    default_workspace_family is null
    or default_workspace_family in (
      'sales',
      'finance',
      'operations',
      'stores',
      'aftermarket',
      'procurement',
      'marketing',
      'hr',
      'distributor',
      'superadmin'
    )
  );

alter table departments
  drop constraint if exists departments_default_workspace_family_check;

alter table departments
  add constraint departments_default_workspace_family_check
  check (
    default_workspace_family is null
    or default_workspace_family in (
      'sales',
      'finance',
      'operations',
      'stores',
      'aftermarket',
      'procurement',
      'marketing',
      'hr',
      'distributor',
      'superadmin'
    )
  );

update roles
set default_workspace_family = case
  when lower(coalesce(role_key, '')) = 'marketing' then 'marketing'
  when lower(coalesce(role_key, '')) = 'stores' then 'stores'
  when lower(coalesce(role_key, '')) in ('distributor') then 'distributor'
  when lower(coalesce(role_key, '')) in ('business_admin') then 'superadmin'
  when lower(coalesce(role_key, '')) in ('accounts') then 'finance'
  when lower(coalesce(role_key, '')) in ('purchase') then 'procurement'
  when lower(coalesce(role_key, '')) in ('post_sales', 'service_engineer') then 'aftermarket'
  when lower(coalesce(role_key, '')) in ('factory', 'dispatch', 'qa', 'production_planner', 'design_engineer') then 'operations'
  when lower(coalesce(role_name, '')) like '%hr%' then 'hr'
  when lower(coalesce(role_name, '')) like '%human resource%' then 'hr'
  else default_workspace_family
end
where default_workspace_family is null
   or default_workspace_family not in (
     'sales', 'finance', 'operations', 'stores', 'aftermarket', 'procurement', 'marketing', 'hr', 'distributor', 'superadmin'
   );

update departments
set default_workspace_family = case
  when lower(coalesce(department_key, '')) = 'marketing' then 'marketing'
  when lower(coalesce(department_key, '')) = 'hr' then 'hr'
  when lower(coalesce(department_key, '')) in ('stores', 'warehouse') then 'stores'
  when lower(coalesce(department_key, '')) = 'accounts' then 'finance'
  when lower(coalesce(department_key, '')) in ('purchase', 'procurement') then 'procurement'
  when lower(coalesce(department_key, '')) = 'service' then 'aftermarket'
  when lower(coalesce(department_key, '')) in ('production', 'dispatch', 'packing', 'engineering', 'projects') then 'operations'
  when lower(coalesce(department_key, '')) = 'sales' then 'sales'
  else default_workspace_family
end
where default_workspace_family is null
   or default_workspace_family not in (
     'sales', 'finance', 'operations', 'stores', 'aftermarket', 'procurement', 'marketing', 'hr', 'distributor', 'superadmin'
   );

insert into departments (department_key, department_name, default_workspace_family, is_active, sort_order)
values
  ('stores', 'Stores', 'stores', true, 85),
  ('purchase', 'Purchase', 'procurement', true, 75)
on conflict (department_key) do update
set
  department_name = excluded.department_name,
  default_workspace_family = coalesce(departments.default_workspace_family, excluded.default_workspace_family),
  is_active = true;

-- ---------------------------------------------------------------------------
-- C5: Business Admin role
-- ---------------------------------------------------------------------------
insert into roles (role_key, role_name, default_workspace_family)
values ('business_admin', 'Business Admin', 'superadmin')
on conflict (role_key) do update
set
  role_name = excluded.role_name,
  default_workspace_family = coalesce(roles.default_workspace_family, excluded.default_workspace_family);

-- ---------------------------------------------------------------------------
-- C2: Distributor workspace family on existing role
-- ---------------------------------------------------------------------------
update roles
set default_workspace_family = 'distributor'
where role_key = 'distributor'
  and (default_workspace_family is null or default_workspace_family = 'sales');

-- ---------------------------------------------------------------------------
-- C4 + C5: Screen baselines (additive; conflict updates preserve explicit grants)
-- ---------------------------------------------------------------------------
insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, s.can_create, s.can_edit, s.can_approve, false, false
from roles r
cross join (
  values
    ('home', true, true, false),
    ('ar_desk', true, true, false),
    ('receipts', true, true, false),
    ('proforma_invoices', true, true, false),
    ('invoices', true, true, false),
    ('gl_desk', true, true, false),
    ('tally_export', true, false, false),
    ('bank_book', true, true, false),
    ('customers', true, true, false)
) as s(screen_key, can_create, can_edit, can_approve)
where r.role_key = 'accounts'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, true, true, s.can_approve, false, false
from roles r
cross join (
  values
    ('home', false),
    ('purchase_requisitions', true),
    ('approval_desk', true),
    ('purchase_orders', true),
    ('goods_receipts', false),
    ('vendor_quotes', false),
    ('vendor_payments', true),
    ('purchase_invoices', false),
    ('vendor_statement', false),
    ('three_way_match', false)
) as s(screen_key, can_approve)
where r.role_key = 'purchase'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit,
  can_approve = excluded.can_approve;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, true, true, false, false, false
from roles r
cross join (
  values
    ('home'),
    ('goods_receipts'),
    ('quality_control'),
    ('stock_ledger'),
    ('stock_adjustments'),
    ('stock_transfers'),
    ('job_cards')
) as s(screen_key)
where r.role_key = 'stores'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, true, true, false, false, false
from roles r
cross join (
  values
    ('home'),
    ('job_cards'),
    ('dispatches'),
    ('manufacturing_boms'),
    ('engineering_desk'),
    ('quality_control'),
    ('sales_desk')
) as s(screen_key)
where r.role_key in ('factory', 'production_planner', 'dispatch', 'qa', 'design_engineer')
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, true, true, false, false, false
from roles r
cross join (
  values
    ('home'),
    ('my_duty_expenses'),
    ('service_tickets'),
    ('aftermarket_desk'),
    ('service_warranty'),
    ('return_rework'),
    ('amc_contracts'),
    ('reverse_logistics')
) as s(screen_key)
where r.role_key in ('post_sales', 'service_engineer')
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, true, true, false, false, false
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
where r.role_key = 'distributor'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit;

insert into screen_permissions (
  role_id, screen_key, can_view, can_create, can_edit, can_approve, own_records_only, financial_masking
)
select r.id, s.screen_key, true, s.can_create, s.can_edit, false, false, false
from roles r
cross join (
  values
    ('admin_masters', true, true),
    ('templates', true, true),
    ('users', false, false),
    ('user_access_preview', false, false)
) as s(screen_key, can_create, can_edit)
where r.role_key = 'business_admin'
on conflict (role_id, screen_key) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_edit = excluded.can_edit;
