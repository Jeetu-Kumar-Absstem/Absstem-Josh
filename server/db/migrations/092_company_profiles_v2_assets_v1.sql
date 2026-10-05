alter table company_profiles_v2
  add column if not exists website text,
  add column if not exists logo_attachment_id integer references attachments(id) on delete set null,
  add column if not exists signature_attachment_id integer references attachments(id) on delete set null;

create index if not exists idx_company_profiles_v2_logo_attachment_id
  on company_profiles_v2(logo_attachment_id);

create index if not exists idx_company_profiles_v2_signature_attachment_id
  on company_profiles_v2(signature_attachment_id);

update company_profiles_v2 cp2
set
  website = coalesce(cp2.website, cp.website),
  logo_attachment_id = coalesce(cp2.logo_attachment_id, cp.logo_attachment_id),
  signature_attachment_id = coalesce(cp2.signature_attachment_id, cp.signature_attachment_id),
  updated_at = now()
from company_profiles cp,
     companies c
where cp.id = 1
  and c.id = cp2.company_id
  and c.company_code = 'AI'
  and (
    cp2.website is distinct from coalesce(cp2.website, cp.website)
    or cp2.logo_attachment_id is distinct from coalesce(cp2.logo_attachment_id, cp.logo_attachment_id)
    or cp2.signature_attachment_id is distinct from coalesce(cp2.signature_attachment_id, cp.signature_attachment_id)
  );
