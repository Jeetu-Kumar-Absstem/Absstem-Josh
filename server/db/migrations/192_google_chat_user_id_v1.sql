-- Google account ID (OpenID "sub") captured at Google sign-in.
-- Google Chat app authentication can only address people as users/{id}, never by email.
alter table erp_users add column if not exists google_user_id text;

create index if not exists idx_erp_users_google_user_id on erp_users (google_user_id) where google_user_id is not null;
