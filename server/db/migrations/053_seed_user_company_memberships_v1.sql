insert into user_company_memberships (user_id, company_id, is_primary, is_active)
select
  u.id as user_id,
  company_id_by_code('AI') as company_id,
  true as is_primary,
  true as is_active
from erp_users u
join user_groups ug on ug.id = u.group_id
where u.is_active = true
  and u.is_approved = true
  and company_id_by_code('AI') is not null
on conflict (user_id, company_id) do update set
  is_active = true;

insert into user_company_memberships (user_id, company_id, is_primary, is_active)
select
  u.id as user_id,
  company_id_by_code('AT') as company_id,
  false as is_primary,
  true as is_active
from erp_users u
join user_groups ug on ug.id = u.group_id
where u.is_active = true
  and u.is_approved = true
  and ug.group_name = 'SuperAdmin'
  and company_id_by_code('AT') is not null
on conflict (user_id, company_id) do update set
  is_active = true;

update user_company_memberships ucm
set is_primary = false
where ucm.company_id <> company_id_by_code('AI')
  and ucm.is_primary = true
  and exists (
    select 1
    from user_company_memberships x
    where x.user_id = ucm.user_id
      and x.company_id = company_id_by_code('AI')
  );

