create table if not exists user_notifications (
  id bigserial primary key,
  company_id integer references companies(id) on delete set null,
  user_id integer not null references erp_users(id) on delete cascade,
  event_type text not null,
  title text not null,
  body text not null default '',
  deep_link_page text,
  deep_link_id bigint,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_unread_idx
  on user_notifications (user_id, created_at desc)
  where read_at is null;

create index if not exists user_notifications_user_created_idx
  on user_notifications (user_id, created_at desc);

create index if not exists user_notifications_company_created_idx
  on user_notifications (company_id, created_at desc);

create table if not exists web_push_subscriptions (
  id bigserial primary key,
  user_id integer not null references erp_users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index if not exists web_push_subscriptions_user_idx
  on web_push_subscriptions (user_id);
