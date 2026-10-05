alter table attachments
  add column if not exists company_id integer references companies(id) on delete restrict;

alter table attachments
  add column if not exists owner_type text;

alter table attachments
  add column if not exists owner_id integer;

alter table attachments
  add column if not exists visibility_scope text;

update attachments
set owner_type = coalesce(nullif(owner_type, ''), 'legacy');

update attachments
set visibility_scope = coalesce(nullif(visibility_scope, ''), case when company_id is null then 'global' else 'company' end);

alter table attachments
  drop constraint if exists attachments_owner_type_check;

alter table attachments
  add constraint attachments_owner_type_check
  check (owner_type in ('legacy', 'template', 'quote_document', 'dispatch_pod', 'company_profile'));

alter table attachments
  drop constraint if exists attachments_visibility_scope_check;

alter table attachments
  add constraint attachments_visibility_scope_check
  check (visibility_scope in ('global', 'company'));

create index if not exists idx_attachments_company_id
  on attachments(company_id);

create index if not exists idx_attachments_owner
  on attachments(owner_type, owner_id);

update attachments a
set company_id = cp.company_id,
    owner_type = 'company_profile',
    owner_id = cp.company_id,
    visibility_scope = 'company'
from company_profiles_v2 cp
where (cp.logo_attachment_id = a.id or cp.signature_attachment_id = a.id)
  and cp.company_id is not null;

update attachments a
set company_id = d.company_id,
    owner_type = 'dispatch_pod',
    owner_id = d.id,
    visibility_scope = 'company'
from dispatches d
where d.pod_attachment_id = a.id
  and d.company_id is not null;

update attachments a
set company_id = qr.company_id,
    owner_type = 'quote_document',
    owner_id = qd.quote_revision_id,
    visibility_scope = 'company'
from quote_documents qd
join quote_revisions qr on qr.id = qd.quote_revision_id
where a.file_path = qd.file_path
  and qr.company_id is not null;

update attachments a
set company_id = cto.company_id,
    owner_type = 'template',
    owner_id = cto.id,
    visibility_scope = 'company'
from company_template_overrides cto
join document_templates dt on dt.id = cto.template_id
where dt.attachment_id = a.id
  and cto.company_id is not null;

update attachments a
set owner_type = 'template',
    owner_id = dt.id,
    visibility_scope = coalesce(a.visibility_scope, 'global')
from document_templates dt
where dt.attachment_id = a.id
  and a.owner_type = 'legacy';

alter table attachments
  alter column owner_type set not null;

alter table attachments
  alter column visibility_scope set not null;

alter table company_template_overrides
  add column if not exists template_body text;

alter table company_template_overrides
  alter column template_id drop not null;
