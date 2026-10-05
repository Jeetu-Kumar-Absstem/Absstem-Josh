insert into erp_modules (module_key, module_name)
values
  ('admin', 'Admin'),
  ('masters', 'Masters'),
  ('leads', 'Leads'),
  ('quotes', 'Quotes'),
  ('sales_orders', 'Sales Orders'),
  ('manufacturing', 'Manufacturing'),
  ('purchase', 'Purchase'),
  ('dispatch', 'Dispatch'),
  ('accounting', 'Accounting'),
  ('service', 'Service')
on conflict (module_key) do nothing;

insert into roles (role_key, role_name)
values
  ('super_admin', 'SuperAdmin'),
  ('management', 'Management'),
  ('commercial_manager', 'Commercial Manager'),
  ('sales_head', 'Sales Head'),
  ('sales_executive', 'Sales Executive'),
  ('regional_head', 'Regional Head'),
  ('distributor', 'Distributor'),
  ('factory', 'Factory'),
  ('purchase', 'Purchase'),
  ('stores', 'Stores'),
  ('dispatch', 'Dispatch'),
  ('accounts', 'Accounts'),
  ('qa', 'QA'),
  ('post_sales', 'Post Sales'),
  ('service_engineer', 'Service Engineer'),
  ('design_engineer', 'Design Engineer'),
  ('production_planner', 'Production Planner')
on conflict (role_key) do nothing;

insert into user_groups (group_name, max_autonomous_discount_pct)
values
  ('SuperAdmin', 100),
  ('Distributor', 15),
  ('Factory', 0)
on conflict (group_name) do nothing;

insert into countries (iso_code, country_name)
values
  ('IN', 'India')
on conflict (iso_code) do nothing;

insert into currencies (currency_code, currency_name, symbol, decimal_precision, is_active)
values
  ('INR', 'Indian Rupee', '₹', 2, true),
  ('USD', 'US Dollar', '$', 2, true),
  ('EUR', 'Euro', '€', 2, true),
  ('GBP', 'Pound Sterling', '£', 2, true),
  ('AED', 'UAE Dirham', 'د.إ', 2, true)
on conflict (currency_code) do nothing;

insert into incoterms (incoterm_code, incoterm_name)
values
  ('EXW', 'Ex Works'),
  ('FCA', 'Free Carrier'),
  ('FOB', 'Free On Board'),
  ('CFR', 'Cost and Freight'),
  ('CIF', 'Cost, Insurance and Freight'),
  ('DAP', 'Delivered At Place'),
  ('DDP', 'Delivered Duty Paid')
on conflict (incoterm_code) do nothing;

insert into tax_codes (tax_code, tax_name, tax_rate, is_active)
values
  ('GST18', 'GST 18%', 18, true),
  ('GST0', 'GST 0%', 0, true)
on conflict (tax_code) do nothing;

insert into payment_terms (term_code, term_name, credit_days, is_active)
values
  ('ADV50', '50% Advance, Balance Against PI', null, true)
on conflict (term_code) do nothing;

insert into freight_terms (term_code, term_name, is_active)
values
  ('EXTRA', 'Extra at Actuals', true)
on conflict (term_code) do nothing;

insert into lead_sources (source_code, source_name, is_active)
values
  ('manual', 'Manual', true),
  ('website', 'Website', true),
  ('email', 'Email', true),
  ('distributor', 'Distributor', true)
on conflict (source_code) do nothing;

insert into erp_users (email, full_name, group_id, primary_role_id, is_active)
values
  (
    'superadmin@absstem.com',
    'JOSH Super Admin',
    (select id from user_groups where group_name = 'SuperAdmin'),
    (select id from roles where role_key = 'super_admin'),
    true
  ),
  (
    'distributor@absstem.com',
    'JOSH Distributor User',
    (select id from user_groups where group_name = 'Distributor'),
    (select id from roles where role_key = 'distributor'),
    true
  ),
  (
    'factory@absstem.com',
    'JOSH Factory User',
    (select id from user_groups where group_name = 'Factory'),
    (select id from roles where role_key = 'factory'),
    true
  )
on conflict (email) do nothing;

insert into user_roles (user_id, role_id, is_primary)
values
  (
    (select id from erp_users where email = 'superadmin@absstem.com'),
    (select id from roles where role_key = 'super_admin'),
    true
  ),
  (
    (select id from erp_users where email = 'distributor@absstem.com'),
    (select id from roles where role_key = 'distributor'),
    true
  ),
  (
    (select id from erp_users where email = 'factory@absstem.com'),
    (select id from roles where role_key = 'factory'),
    true
  )
on conflict (user_id, role_id) do nothing;
