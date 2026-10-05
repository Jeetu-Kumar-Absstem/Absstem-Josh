alter table roles
  add column if not exists default_workspace_family text;

alter table roles
  drop constraint if exists roles_default_workspace_family_check;

alter table roles
  add constraint roles_default_workspace_family_check
  check (
    default_workspace_family is null
    or default_workspace_family in ('sales', 'finance', 'operations', 'aftermarket', 'procurement', 'superadmin')
  );

alter table departments
  add column if not exists default_workspace_family text;

alter table departments
  drop constraint if exists departments_default_workspace_family_check;

alter table departments
  add constraint departments_default_workspace_family_check
  check (
    default_workspace_family is null
    or default_workspace_family in ('sales', 'finance', 'operations', 'aftermarket', 'procurement', 'superadmin')
  );

update roles
set default_workspace_family = case
  when lower(coalesce(role_name, '')) like '%account%' then 'finance'
  when lower(coalesce(role_name, '')) like '%post sales%' then 'aftermarket'
  when lower(coalesce(role_name, '')) like '%service%' then 'aftermarket'
  when lower(coalesce(role_name, '')) like '%purchase%' then 'procurement'
  when lower(coalesce(role_name, '')) like '%dispatch%' then 'operations'
  when lower(coalesce(role_name, '')) like '%production%' then 'operations'
  when lower(coalesce(role_name, '')) like '%planner%' then 'operations'
  when lower(coalesce(role_name, '')) like '%qa%' then 'operations'
  when lower(coalesce(role_name, '')) like '%quality%' then 'operations'
  when lower(coalesce(role_name, '')) like '%superadmin%' then 'superadmin'
  when lower(coalesce(role_name, '')) like '%sales%' then 'sales'
  else default_workspace_family
end
where default_workspace_family is null;

update departments
set default_workspace_family = case
  when lower(coalesce(department_key, '')) like '%account%' then 'finance'
  when lower(coalesce(department_key, '')) like '%service%' then 'aftermarket'
  when lower(coalesce(department_key, '')) like '%purchase%' then 'procurement'
  when lower(coalesce(department_key, '')) like '%production%' then 'operations'
  when lower(coalesce(department_key, '')) like '%dispatch%' then 'operations'
  when lower(coalesce(department_key, '')) like '%packing%' then 'operations'
  when lower(coalesce(department_key, '')) like '%engineering%' then 'operations'
  when lower(coalesce(department_key, '')) like '%sales%' then 'sales'
  else default_workspace_family
end
where default_workspace_family is null;
