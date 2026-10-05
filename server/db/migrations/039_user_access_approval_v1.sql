insert into user_groups (group_name, max_autonomous_discount_pct, is_active)
values ('Absstem', 25, true)
on conflict (group_name) do nothing;

alter table erp_users
add column if not exists is_approved boolean not null default true,
add column if not exists approved_by integer references erp_users(id),
add column if not exists approved_at timestamptz,
add column if not exists approval_requested_at timestamptz;

update erp_users
set is_approved = true
where is_active = true and is_approved is distinct from true;
