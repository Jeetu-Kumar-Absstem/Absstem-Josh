create table if not exists terms_master (
  id serial primary key,
  sort_order integer not null,
  caption text not null,
  default_description text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (caption)
);

create index if not exists idx_terms_master_active on terms_master(is_active);

create table if not exists quote_revision_terms (
  id serial primary key,
  quote_revision_id integer not null references quote_revisions(id) on delete cascade,
  term_master_id integer references terms_master(id) on delete set null,
  sort_order integer not null,
  caption text not null,
  description text not null,
  is_selected boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quote_revision_id, term_master_id)
);

create index if not exists idx_quote_revision_terms_quote_revision_id on quote_revision_terms(quote_revision_id);

insert into terms_master (sort_order, caption, default_description)
values
  (
    2,
    'EXCLUSIONS & CLIENT''S SCOPE',
    'All erection / civil work, All Power Cables & Cabling out of battery limit of PSA Plant, Cable Trenches etc. Unloading / Shifting of Gas Plant at Client''s site will be in Client Scope. Additional gas piping, cooling water (if required).'
  ),
  (
    3,
    'SUPERVISION OF ERECTION & COMMISSIONING',
    'There shall be no commissioning charges, however you shall arrange free To & Fro Air Ticket, lodging / boarding, and local conveyance for our Engineers during supervision of Installation of Gas Plant at site on free of cost basis. Our Engineers will be there for Supervision only. Any manpower / fitter required for installation work shall be provided by you.'
  ),
  (4, 'P&F', '3% Extra.'),
  (5, 'Freight', 'Extra at Actuals.'),
  (6, 'Insurance', 'In your Scope.'),
  (7, 'Payment Terms', '50% Advance with your Prestegious Purchase Order and Balance against PI.'),
  (8, 'Delivery', '6-8 Weeks from the PO and Advance. Rest can be confirmed for Availability.'),
  (
    9,
    'Warranty',
    'We hereby confirm that, our equipment shall have Supplier''s warranty for a period of 12 months from the date of Commissioning or 18 months from date of Dispatch whichever is earlier.'
  ),
  (10, 'GST', 'As per the Commercial Table.')
on conflict (caption) do nothing;

