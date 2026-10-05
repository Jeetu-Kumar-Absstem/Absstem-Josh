-- Home families v2: dispatch, executive (leadership), office (office admin), employee (self-service)

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
      'dispatch',
      'stores',
      'aftermarket',
      'procurement',
      'marketing',
      'hr',
      'executive',
      'office',
      'employee',
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
      'dispatch',
      'stores',
      'aftermarket',
      'procurement',
      'marketing',
      'hr',
      'executive',
      'office',
      'employee',
      'distributor',
      'superadmin'
    )
  );

-- Only move rows still on the migration-154 defaults; admin-edited values are kept.
update departments
set default_workspace_family = 'dispatch'
where lower(department_key) = 'dispatch'
  and (default_workspace_family is null or default_workspace_family = 'operations');

update departments
set default_workspace_family = 'office'
where lower(department_key) = 'office_admin'
  and default_workspace_family is null;

update roles
set default_workspace_family = 'dispatch'
where lower(coalesce(role_key, '')) = 'dispatch'
  and (default_workspace_family is null or default_workspace_family = 'operations');

update roles
set default_workspace_family = 'executive'
where lower(coalesce(role_key, '')) = 'management'
  and default_workspace_family is null;
