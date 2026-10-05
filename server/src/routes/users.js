const express = require("express");
const crypto = require("crypto");

const { pool } = require("../db/pool");
const { notifyUser } = require("../services/notifications");
const { docTypeLabel, getDocTypeOptions } = require("../services/approvalPolicy");
const { getActiveCompanyId } = require("../services/companyContext");
const {
  applyRoleProfileIdentity,
  findManagerAssignmentProblem,
  reassignDirectReports,
  syncPrimaryRole,
} = require("../services/userIdentityGuards");
const { accessModelMode } = require("../auth/accessModel");
const { applyPersonChange, normalizeOverrideChanges } = require("../services/personAccess");
const { offboardEmployee } = require("../services/hrTransitions");

const router = express.Router();

const AUTHORITY_DOC_TYPES = ["purchase_order", "goods_receipt", "purchase_invoice", "vendor_payment"];

function moneyOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(2));
}

function pickAuthorityCeiling(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let unlimited = false;
  let maxSeen = null;
  for (const row of rows) {
    if (row.max_amount === null || row.max_amount === undefined || row.max_amount === "") {
      unlimited = true;
      break;
    }
    const n = Number(row.max_amount);
    if (!Number.isFinite(n)) continue;
    maxSeen = maxSeen === null ? n : Math.max(maxSeen, n);
  }
  if (unlimited) return { max_amount: null, policy_id: Number(rows[0]?.id) || null };
  return { max_amount: maxSeen, policy_id: Number(rows[0]?.id) || null };
}

async function loadUserAuthoritySnapshot(client, { userId, companyId, roleId, groupId }) {
  const policiesRes = await client.query(
    `
      select
        id,
        doc_type,
        level_no,
        user_id,
        role_id,
        group_id,
        min_amount,
        max_amount,
        is_active
      from approval_policies
      where company_id = $1
        and is_active = true
        and doc_type = any($2::text[])
        and vendor_id is null
        and (
          user_id = $3
          or ($4::integer is not null and role_id = $4)
          or ($5::integer is not null and group_id = $5)
        )
      order by
        doc_type asc,
        case when user_id is not null then 0 else 1 end,
        level_no asc,
        id asc
    `,
    [companyId, AUTHORITY_DOC_TYPES, userId, roleId || null, groupId || null]
  );

  const byDoc = new Map();
  for (const row of policiesRes.rows) {
    const key = String(row.doc_type);
    if (!byDoc.has(key)) byDoc.set(key, { user: [], role: [], group: [] });
    const bucket = byDoc.get(key);
    if (Number(row.user_id) === Number(userId)) bucket.user.push(row);
    else if (roleId && Number(row.role_id) === Number(roleId)) bucket.role.push(row);
    else if (groupId && Number(row.group_id) === Number(groupId)) bucket.group.push(row);
  }

  const labels = new Map(getDocTypeOptions().map((item) => [item.key, item.label]));
  return AUTHORITY_DOC_TYPES.map((docType) => {
    const bucket = byDoc.get(docType) || { user: [], role: [], group: [] };
    if (bucket.user.length) {
      const picked = pickAuthorityCeiling(bucket.user);
      return {
        doc_type: docType,
        label: labels.get(docType) || docTypeLabel(docType),
        max_amount: picked.max_amount,
        source: "user",
        policy_id: picked.policy_id,
      };
    }
    if (bucket.role.length) {
      const picked = pickAuthorityCeiling(bucket.role);
      return {
        doc_type: docType,
        label: labels.get(docType) || docTypeLabel(docType),
        max_amount: picked.max_amount,
        source: "role",
        policy_id: picked.policy_id,
      };
    }
    if (bucket.group.length) {
      const picked = pickAuthorityCeiling(bucket.group);
      return {
        doc_type: docType,
        label: labels.get(docType) || docTypeLabel(docType),
        max_amount: picked.max_amount,
        source: "group",
        policy_id: picked.policy_id,
      };
    }
    return {
      doc_type: docType,
      label: labels.get(docType) || docTypeLabel(docType),
      max_amount: null,
      source: "none",
      policy_id: null,
    };
  });
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (req.user.group_name !== "SuperAdmin") return res.status(403).json({ ok: false, error: "FORBIDDEN" });
  return next();
}

function normalizeEmail(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function normalizeText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeDate(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : null;
}

function normalizeBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function normalizePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function normalizeId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      return resolve(derivedKey.toString("base64"));
    });
  });
}

const USER_SELECT = `
  select
    u.id,
    u.user_code,
    u.email,
    u.full_name,
    u.phone,
    u.designation,
    u.company_name,
    u.employee_code,
    u.department_key,
    dep.department_name,
    u.employment_company_id,
    eco.company_code as employment_company_code,
    coalesce(eco.display_name, eco.legal_name) as employment_company_name,
    u.date_of_joining,
    u.local_address,
    u.permanent_address,
    u.discount_threshold_pct as discount_threshold_override,
    coalesce(u.discount_threshold_pct, ug.max_autonomous_discount_pct) as discount_threshold_pct,
    u.is_active,
    u.is_approved,
    u.approval_requested_at,
    u.approved_by,
    u.approved_at,
    u.created_at,
    u.updated_at,
    ug.id as group_id,
    ug.group_name,
    ug.max_autonomous_discount_pct as group_discount_threshold_pct,
    r.id as role_id,
    r.role_name,
    pm.id as primary_manager_user_id,
    pm.user_code as primary_manager_code,
    pm.full_name as primary_manager_name,
    sm.id as secondary_manager_user_id,
    sm.user_code as secondary_manager_code,
    sm.full_name as secondary_manager_name,
    d.id as distributor_id,
    d.company_name as distributor_name,
    (ma.id is not null) as mail_connected,
    ma.provider as mail_provider,
    ma.mailbox_email as mailbox_email
  from erp_users u
  join user_groups ug on ug.id = u.group_id
  left join roles r on r.id = u.primary_role_id
  left join departments dep on dep.department_key = u.department_key
  left join companies eco on eco.id = u.employment_company_id
  left join erp_users pm on pm.id = u.primary_manager_user_id
  left join erp_users sm on sm.id = u.secondary_manager_user_id
  left join user_distributor_links udl on udl.user_id = u.id
  left join distributors d on d.id = udl.distributor_id
  left join mail_accounts ma on ma.owner_type = 'user' and ma.user_id = u.id and ma.provider = 'google' and ma.is_active = true
`;

async function getUserById(client, userId) {
  const r = await client.query(`${USER_SELECT} where u.id = $1 limit 1`, [userId]);
  return r.rows[0] || null;
}

async function findUserByEmail(client, email, { excludeUserId = null } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const excludeId = normalizeId(excludeUserId);
  const r = await client.query(
    `
      select id, user_code, full_name, email
      from erp_users
      where lower(email::text) = lower($1::text)
        and ($2::int is null or id <> $2)
      limit 1
    `,
    [normalizedEmail, excludeId]
  );
  return r.rows[0] || null;
}

async function fetchUserCompanyMemberships(client, userId) {
  const r = await client.query(
    `
      select
        ucm.company_id,
        ucm.is_primary,
        ucm.is_active,
        c.company_code,
        coalesce(c.display_name, c.legal_name) as company_name
      from user_company_memberships ucm
      join companies c on c.id = ucm.company_id
      where ucm.user_id = $1
      order by ucm.is_primary desc, c.company_code asc
    `,
    [userId]
  );
  return r.rows;
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const n = normalizeId(item);
    if (Number.isFinite(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

async function syncCompanyMemberships(client, userId, { companyIds, primaryCompanyId }) {
  const ids = normalizeIdArray(companyIds);
  const primary = normalizeId(primaryCompanyId);
  if (!ids.length && !primary) return;

  const finalIds = ids.length ? ids : primary ? [primary] : [];
  const effectivePrimary = primary && finalIds.includes(primary) ? primary : finalIds[0] || null;

  await client.query(`delete from user_company_memberships where user_id = $1`, [userId]);
  for (const cid of finalIds) {
    await client.query(
      `
        insert into user_company_memberships (user_id, company_id, is_primary, is_active)
        values ($1,$2,$3,true)
        on conflict (user_id, company_id) do update
        set is_primary = excluded.is_primary, is_active = true
      `,
      [userId, cid, effectivePrimary ? cid === effectivePrimary : false]
    );
  }
}

async function defaultDistributorCompanyIds(client, req, { distributorId, primaryManagerUserId }) {
  if (!Number.isFinite(distributorId)) return [];
  const peers = await client.query(
    `
      select distinct ucm.company_id
      from user_company_memberships ucm
      join user_distributor_links udl on udl.user_id = ucm.user_id
      join companies c on c.id = ucm.company_id and c.is_active = true
      where udl.distributor_id = $1
        and ucm.is_active = true
      order by ucm.company_id
    `,
    [distributorId]
  );
  if (peers.rows.length) return peers.rows.map((r) => Number(r.company_id));
  if (Number.isFinite(primaryManagerUserId)) {
    const mgr = await client.query(
      `
        select ucm.company_id
        from user_company_memberships ucm
        join companies c on c.id = ucm.company_id and c.is_active = true
        where ucm.user_id = $1 and ucm.is_active = true
        order by ucm.is_primary desc, ucm.company_id
      `,
      [primaryManagerUserId]
    );
    if (mgr.rows.length) return mgr.rows.map((r) => Number(r.company_id));
  }
  const active = normalizeId(getActiveCompanyId(req));
  return Number.isFinite(active) ? [active] : [];
}

async function ensureEmployeeCode(client, userId) {
  const r = await client.query(`select employee_code from erp_users where id = $1 limit 1`, [userId]);
  const existing = String(r.rows[0]?.employee_code || "").trim();
  if (existing) return existing;
  const next = `EMP${String(userId).padStart(4, "0")}`;
  await client.query(`update erp_users set employee_code = $2, updated_at = now() where id = $1 and coalesce(employee_code, '') = ''`, [
    userId,
    next,
  ]);
  return next;
}

async function syncDistributorLink(client, userId, distributorId) {
  if (!Number.isFinite(distributorId)) {
    await client.query(`delete from user_distributor_links where user_id = $1`, [userId]);
    return;
  }
  const exists = await client.query(`select id from distributors where id = $1 limit 1`, [distributorId]);
  if (!exists.rows[0]) {
    const err = new Error(`Distributor id ${distributorId} does not exist`);
    err.status = 400;
    err.code = "INVALID_DISTRIBUTOR";
    err.detail = "Link this user to a valid Channel Partner / distributor record first.";
    throw err;
  }
  await client.query(
    `
      insert into user_distributor_links (user_id, distributor_id)
      values ($1,$2)
      on conflict (user_id) do update set distributor_id = excluded.distributor_id
    `,
    [userId, distributorId]
  );
}

async function upsertPassword(client, userId, password) {
  const pwd = typeof password === "string" ? password : "";
  if (!pwd.trim().length) return;
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = await scryptHash(pwd, salt);
  await client.query(
    `
      insert into user_credentials (user_id, password_salt, password_hash, password_algo, updated_at)
      values ($1,$2,$3,'scrypt',now())
      on conflict (user_id) do update set
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        password_algo = excluded.password_algo,
        updated_at = now()
    `,
    [userId, salt, hash]
  );
}

async function writeUserAccessAudit(client, {
  actorUserId = null,
  targetUserId = null,
  targetRoleId = null,
  action,
  beforeJson = null,
  afterJson = null,
} = {}) {
  if (!action) return;
  const readyRes = await client.query(`select to_regclass('public.user_access_audit') is not null as ready`);
  if (!Boolean(readyRes.rows[0]?.ready)) return;
  await client.query(
    `
      insert into user_access_audit (
        actor_user_id,
        target_user_id,
        target_role_id,
        action,
        before_json,
        after_json
      )
      values ($1,$2,$3,$4,coalesce($5::jsonb, '{}'::jsonb), coalesce($6::jsonb, '{}'::jsonb))
    `,
    [
      Number(actorUserId) > 0 ? Number(actorUserId) : null,
      Number(targetUserId) > 0 ? Number(targetUserId) : null,
      Number(targetRoleId) > 0 ? Number(targetRoleId) : null,
      String(action),
      beforeJson == null ? null : JSON.stringify(beforeJson),
      afterJson == null ? null : JSON.stringify(afterJson),
    ]
  );
}

async function loadBootstrapData(client) {
  const [groupsRes, rolesRes, distributorsRes, usersRes, departmentsRes, companiesRes, offboardingAuditsRes, designationsRes, accessHealthRes] = await Promise.all([
    client.query(
      `
        select id, group_name, max_autonomous_discount_pct
        from user_groups
        where is_active = true
        order by group_name asc
      `
    ),
    client.query(
      `
        select id, role_key, role_name, default_workspace_family
        from roles
        where is_active = true
        order by role_name asc
      `
    ),
    client.query(
      `
        select id, company_name
        from distributors
        where is_active = true
        order by company_name asc
      `
    ),
    client.query(
      `
        select id, user_code, email, full_name, is_active
        from erp_users
        where is_active = true
        order by coalesce(full_name, email) asc, email asc
      `
    ),
    client.query(
      `
        select department_key, department_name, default_workspace_family
        from departments
        where is_active = true
        order by sort_order asc, department_name asc
      `
    ),
    client.query(
      `
        select id, company_code, coalesce(display_name, legal_name) as company_name
        from companies
        where is_active = true
        order by company_code asc
      `
    ),
    client.query(`select to_regclass('public.offboarding_audits') is not null as offboarding_audits_ready`),
    client
      .query(`select to_regclass('public.designations') is not null as ready`)
      .then((r) =>
        r.rows[0]?.ready
          ? client.query(
              `
                select id, designation_name, sort_order
                from designations
                where is_active = true
                order by sort_order asc, designation_name asc
              `
            )
          : { rows: [] }
      ),
    client.query(
      `
        select
          (
            select count(*)::int
            from erp_users u
            where u.is_active = true
              and coalesce(u.is_approved, false) = false
          ) as unapproved_count,
          (
            select count(*)::int
            from erp_users u
            join user_groups ug on ug.id = u.group_id
            where u.is_active = true
              and ug.group_name is distinct from 'SuperAdmin'
              and not exists (
                select 1
                from user_company_memberships ucm
                where ucm.user_id = u.id
                  and coalesce(ucm.is_active, true) = true
              )
          ) as zero_company_count,
          (
            select count(*)::int
            from erp_users u
            join user_groups ug on ug.id = u.group_id
            left join screen_permissions sp
              on sp.role_id = u.primary_role_id
             and sp.screen_key = 'quotes'
            left join user_screen_permissions usp
              on usp.user_id = u.id
             and usp.screen_key = 'quotes'
            where u.is_active = true
              and coalesce(u.is_approved, true) = true
              and ug.group_name is distinct from 'SuperAdmin'
              and coalesce(usp.can_view, sp.can_view, false) = false
          ) as quotes_hidden_count
      `
    ),
  ]);

  const accessHealth = accessHealthRes.rows[0] || {};
  return {
    user_groups: groupsRes.rows,
    roles: rolesRes.rows,
    distributors: distributorsRes.rows,
    managers: usersRes.rows,
    departments: departmentsRes.rows,
    companies: companiesRes.rows,
    offboarding_audits_ready: Boolean(offboardingAuditsRes.rows[0]?.offboarding_audits_ready),
    designations: designationsRes.rows,
    access_health: {
      unapproved_count: Number(accessHealth.unapproved_count) || 0,
      zero_company_count: Number(accessHealth.zero_company_count) || 0,
      quotes_hidden_count: Number(accessHealth.quotes_hidden_count) || 0,
    },
  };
}

function parseTransferOptions(body) {
  const hasExplicitScope =
    Object.prototype.hasOwnProperty.call(body, "transfer_leads") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_quotes") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_sales_orders") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_job_cards") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_purchase_requisitions") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_dispatches") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_customer_invoices") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_goods_receipts") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_quality_controls") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_supplier_claims") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_purchase_returns") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_sales_returns") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_purchase_orders") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_purchase_invoices") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_vendor_payments") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_customer_receipts") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_finance_entries") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_stock_adjustments") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_stock_transfers") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_service_cases") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_amc_contracts") ||
    Object.prototype.hasOwnProperty.call(body, "transfer_approval_chains");
  return {
    includeClosed: normalizeBool(body.include_closed),
    transferLeads: hasExplicitScope ? normalizeBool(body.transfer_leads) : true,
    transferQuotes: hasExplicitScope ? normalizeBool(body.transfer_quotes) : false,
    transferSalesOrders: hasExplicitScope ? normalizeBool(body.transfer_sales_orders) : false,
    transferJobCards: hasExplicitScope ? normalizeBool(body.transfer_job_cards) : false,
    transferPurchaseRequisitions: hasExplicitScope ? normalizeBool(body.transfer_purchase_requisitions) : false,
    transferDispatches: hasExplicitScope ? normalizeBool(body.transfer_dispatches) : false,
    transferCustomerInvoices: hasExplicitScope ? normalizeBool(body.transfer_customer_invoices) : false,
    transferGoodsReceipts: hasExplicitScope ? normalizeBool(body.transfer_goods_receipts) : false,
    transferQualityControls: hasExplicitScope ? normalizeBool(body.transfer_quality_controls) : false,
    transferSupplierClaims: hasExplicitScope ? normalizeBool(body.transfer_supplier_claims) : false,
    transferPurchaseReturns: hasExplicitScope ? normalizeBool(body.transfer_purchase_returns) : false,
    transferSalesReturns: hasExplicitScope ? normalizeBool(body.transfer_sales_returns) : false,
    transferPurchaseOrders: hasExplicitScope ? normalizeBool(body.transfer_purchase_orders) : false,
    transferPurchaseInvoices: hasExplicitScope ? normalizeBool(body.transfer_purchase_invoices) : false,
    transferVendorPayments: hasExplicitScope ? normalizeBool(body.transfer_vendor_payments) : false,
    transferCustomerReceipts: hasExplicitScope ? normalizeBool(body.transfer_customer_receipts) : false,
    transferFinanceEntries: hasExplicitScope ? normalizeBool(body.transfer_finance_entries) : false,
    transferStockAdjustments: hasExplicitScope ? normalizeBool(body.transfer_stock_adjustments) : false,
    transferStockTransfers: hasExplicitScope ? normalizeBool(body.transfer_stock_transfers) : false,
    transferServiceCases: hasExplicitScope ? normalizeBool(body.transfer_service_cases) : false,
    transferAmcContracts: hasExplicitScope ? normalizeBool(body.transfer_amc_contracts) : false,
    transferApprovalChains: hasExplicitScope ? normalizeBool(body.transfer_approval_chains) : false,
  };
}

async function executeUserTransfer(client, { fromUserId, toUserId, actingUserId, reasonPrefix, includeClosed, transferLeads, transferQuotes, transferSalesOrders, transferJobCards, transferPurchaseRequisitions, transferDispatches, transferCustomerInvoices, transferGoodsReceipts, transferQualityControls, transferSupplierClaims, transferPurchaseReturns, transferSalesReturns, transferPurchaseOrders, transferPurchaseInvoices, transferVendorPayments, transferCustomerReceipts, transferFinanceEntries, transferStockAdjustments, transferStockTransfers, transferServiceCases, transferAmcContracts, transferApprovalChains }) {
  async function transferCreatedByRows({ table, statusColumn, openStatuses }) {
    const params = [toUserId, fromUserId];
    const where = [`created_by = $2`];
    if (!includeClosed && Array.isArray(openStatuses) && openStatuses.length && statusColumn) {
      params.push(openStatuses);
      where.push(`${statusColumn} = any($3::text[])`);
    }
    const r = await client.query(
      `
        update ${table}
        set created_by = $1, updated_at = now()
        where ${where.join(" and ")}
        returning id
      `,
      params
    );
    return r.rows.length;
  }

  const results = {
    leads_transferred: 0,
    quotes_transferred: 0,
    sales_orders_transferred: 0,
    job_cards_transferred: 0,
    purchase_requisitions_transferred: 0,
    dispatches_transferred: 0,
    customer_invoices_transferred: 0,
    goods_receipts_transferred: 0,
    quality_controls_transferred: 0,
    supplier_claims_transferred: 0,
    supplier_claim_receipts_transferred: 0,
    purchase_returns_transferred: 0,
    sales_returns_transferred: 0,
    purchase_orders_transferred: 0,
    purchase_invoices_transferred: 0,
    vendor_payments_transferred: 0,
    customer_receipts_transferred: 0,
    finance_entries_transferred: 0,
    stock_adjustments_transferred: 0,
    stock_transfers_transferred: 0,
    service_cases_transferred: 0,
    amc_contracts_transferred: 0,
    approval_chains_transferred: 0,
    approval_chain_breakdown: {
      quote_draft_prepared_by: 0,
      quote_pending_approvals: 0,
      purchase_requisition_submitted_by: 0,
      purchase_order_submitted_by: 0,
      goods_receipt_submitted_by: 0,
      purchase_invoice_submitted_by: 0,
      vendor_payment_submitted_by: 0,
      purchase_requisition_approved_by: 0,
      purchase_order_approved_by: 0,
      goods_receipt_approved_by: 0,
      purchase_invoice_approved_by: 0,
      vendor_payment_approved_by: 0,
    },
  };

  if (transferLeads) {
    const statuses = includeClosed ? null : ["new", "follow_up", "qualified", "quoted"];
    const params = [toUserId, fromUserId];
    const where = [`assigned_to = $2`];
    if (Array.isArray(statuses)) {
      params.push(statuses);
      where.push(`status = any($3::text[])`);
    }

    const reason = `${reasonPrefix} from user ${fromUserId} to ${toUserId}`;
    const updatedRes = await client.query(
      `
        with moved as (
          update leads
          set assigned_to = $1, updated_at = now()
          where ${where.join(" and ")}
          returning id
        )
        insert into lead_assignments (lead_id, assigned_to, assigned_by, assignment_reason)
        select id, $1, $4, $5
        from moved
        returning lead_id
      `,
      [...params, actingUserId, reason]
    );
    results.leads_transferred = updatedRes.rows.length;
  }

  if (transferQuotes) {
    const quoteParams = [toUserId, fromUserId];
    let quoteStatusSql = "";
    if (!includeClosed) {
      quoteParams.push(["draft", "submitted", "approved", "issued", "sent", "converted"]);
      quoteStatusSql = "and quote_status = any($3::text[])";
    }
    const moved = await client.query(
      `
        update quote_headers
        set owner_user_id = $1,
            created_by = case when created_by = $2 then $1 else created_by end,
            updated_at = now()
        where coalesce(owner_user_id, created_by) = $2
          ${quoteStatusSql}
        returning id
      `,
      quoteParams
    );
    results.quotes_transferred = moved.rows.length;
    if (moved.rows.length) {
      await client.query(
        `
          insert into quote_owner_changes (quote_id, from_user_id, to_user_id, changed_by, reason)
          select unnest($1::int[]), $2, $3, $4, $5
        `,
        [moved.rows.map((r) => r.id), fromUserId, toUserId, actingUserId || null, `${reasonPrefix || "User transfer"}`.slice(0, 500)]
      );
    }
  }

  if (transferSalesOrders) {
    results.sales_orders_transferred = await transferCreatedByRows({
      table: "sales_orders",
      statusColumn: "order_status",
      openStatuses: ["draft", "confirmed"],
    });
  }

  if (transferJobCards) {
    results.job_cards_transferred = await transferCreatedByRows({
      table: "job_cards",
      statusColumn: "job_status",
      openStatuses: ["draft", "open"],
    });
  }

  if (transferPurchaseRequisitions) {
    results.purchase_requisitions_transferred = await transferCreatedByRows({
      table: "purchase_requisitions",
      statusColumn: "requisition_status",
      openStatuses: ["draft", "submitted", "approved"],
    });
  }

  if (transferDispatches) {
    results.dispatches_transferred = await transferCreatedByRows({
      table: "dispatches",
      statusColumn: "dispatch_status",
      openStatuses: ["draft", "ready", "dispatched"],
    });
  }

  if (transferCustomerInvoices) {
    results.customer_invoices_transferred = await transferCreatedByRows({
      table: "customer_invoices",
      statusColumn: "invoice_status",
      openStatuses: ["draft", "issued"],
    });
  }

  if (transferGoodsReceipts) {
    results.goods_receipts_transferred = await transferCreatedByRows({
      table: "goods_receipts",
      statusColumn: "receipt_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferQualityControls) {
    results.quality_controls_transferred = await transferCreatedByRows({
      table: "quality_controls",
      statusColumn: "qc_status",
      openStatuses: ["draft"],
    });
  }

  if (transferSupplierClaims) {
    results.supplier_claims_transferred = await transferCreatedByRows({
      table: "supplier_claims",
      statusColumn: "claim_status",
      openStatuses: ["open"],
    });
    results.supplier_claim_receipts_transferred = await transferCreatedByRows({
      table: "supplier_claim_receipts",
      statusColumn: null,
      openStatuses: null,
    });
  }

  if (transferPurchaseReturns) {
    results.purchase_returns_transferred = await transferCreatedByRows({
      table: "purchase_returns",
      statusColumn: "return_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferSalesReturns) {
    results.sales_returns_transferred = await transferCreatedByRows({
      table: "sales_returns",
      statusColumn: "return_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferPurchaseOrders) {
    results.purchase_orders_transferred = await transferCreatedByRows({
      table: "purchase_orders",
      statusColumn: "po_status",
      openStatuses: ["draft", "confirmed"],
    });
  }

  if (transferPurchaseInvoices) {
    results.purchase_invoices_transferred = await transferCreatedByRows({
      table: "purchase_invoices",
      statusColumn: "invoice_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferVendorPayments) {
    results.vendor_payments_transferred = await transferCreatedByRows({
      table: "vendor_payments",
      statusColumn: "payment_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferCustomerReceipts) {
    results.customer_receipts_transferred = await transferCreatedByRows({
      table: "customer_receipts",
      statusColumn: "receipt_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferFinanceEntries) {
    results.finance_entries_transferred = await transferCreatedByRows({
      table: "finance_book_entries",
      statusColumn: null,
      openStatuses: null,
    });
  }

  if (transferStockAdjustments) {
    results.stock_adjustments_transferred = await transferCreatedByRows({
      table: "stock_adjustments",
      statusColumn: "adjustment_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferStockTransfers) {
    results.stock_transfers_transferred = await transferCreatedByRows({
      table: "stock_transfers",
      statusColumn: "transfer_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferServiceCases) {
    results.service_cases_transferred = await transferCreatedByRows({
      table: "service_warranty_cases",
      statusColumn: "case_status",
      openStatuses: ["open"],
    });
  }

  if (transferAmcContracts) {
    results.amc_contracts_transferred = await transferCreatedByRows({
      table: "amc_contracts",
      statusColumn: "contract_status",
      openStatuses: ["draft", "active"],
    });
  }

  if (transferApprovalChains) {
    const draftPreparedRes = await client.query(
      `
        update quote_revisions
        set prepared_by = $1
        where prepared_by = $2
          and revision_status = 'draft'
        returning id
      `,
      [toUserId, fromUserId]
    );

    const quoteApprovalsRes = await client.query(
      `
        update quote_approvals
        set
          requested_by = case when requested_by = $2 then $1 else requested_by end,
          approver_user_id = case when approver_user_id = $2 then $1 else approver_user_id end,
          updated_at = now()
        where (requested_by = $2 or approver_user_id = $2)
          and approval_status = 'pending'
          and acted_by_user_id is null
        returning id
      `,
      [toUserId, fromUserId]
    );

    const submittedStatuses = ["draft", "submitted"];
    const submittedFilters = includeClosed ? "" : `and ${"${STATUS_COL}"} = any($3::text[])`;
    const submittedParams = includeClosed ? [toUserId, fromUserId] : [toUserId, fromUserId, submittedStatuses];

    const prqSubmittedRes = await client.query(
      `
        update purchase_requisitions
        set submitted_by = $1, updated_at = now()
        where submitted_by = $2
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "requisition_status")})
        returning id
      `,
      submittedParams
    );

    const poSubmittedRes = await client.query(
      `
        update purchase_orders
        set submitted_by = $1, updated_at = now()
        where submitted_by = $2
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "po_status")})
        returning id
      `,
      submittedParams
    );

    const grnSubmittedRes = await client.query(
      `
        update goods_receipts
        set submitted_by = $1, updated_at = now()
        where submitted_by = $2
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "receipt_status")})
        returning id
      `,
      submittedParams
    );

    const piSubmittedRes = await client.query(
      `
        update purchase_invoices
        set submitted_by = $1, updated_at = now()
        where submitted_by = $2
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "invoice_status")})
        returning id
      `,
      submittedParams
    );

    const vpSubmittedRes = await client.query(
      `
        update vendor_payments
        set submitted_by = $1, updated_at = now()
        where submitted_by = $2
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "payment_status")})
        returning id
      `,
      submittedParams
    );

    const approverStatuses = ["submitted"];
    const approverFilters = includeClosed ? "" : `and ${"${STATUS_COL}"} = any($3::text[])`;
    const approverParams = includeClosed ? [toUserId, fromUserId] : [toUserId, fromUserId, approverStatuses];

    const prqApproverRes = await client.query(
      `
        update purchase_requisitions
        set approved_by = $1, updated_at = now()
        where approved_by = $2
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "requisition_status")}
        returning id
      `,
      approverParams
    );

    const poApproverRes = await client.query(
      `
        update purchase_orders
        set approved_by = $1, updated_at = now()
        where approved_by = $2
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "po_status")}
        returning id
      `,
      approverParams
    );

    const grnApproverRes = await client.query(
      `
        update goods_receipts
        set approved_by = $1, updated_at = now()
        where approved_by = $2
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "receipt_status")}
        returning id
      `,
      approverParams
    );

    const piApproverRes = await client.query(
      `
        update purchase_invoices
        set approved_by = $1, updated_at = now()
        where approved_by = $2
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "invoice_status")}
        returning id
      `,
      approverParams
    );

    const vpApproverRes = await client.query(
      `
        update vendor_payments
        set approved_by = $1, updated_at = now()
        where approved_by = $2
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "payment_status")}
        returning id
      `,
      approverParams
    );

    results.approval_chain_breakdown = {
      quote_draft_prepared_by: draftPreparedRes.rows.length,
      quote_pending_approvals: quoteApprovalsRes.rows.length,
      purchase_requisition_submitted_by: prqSubmittedRes.rows.length,
      purchase_order_submitted_by: poSubmittedRes.rows.length,
      goods_receipt_submitted_by: grnSubmittedRes.rows.length,
      purchase_invoice_submitted_by: piSubmittedRes.rows.length,
      vendor_payment_submitted_by: vpSubmittedRes.rows.length,
      purchase_requisition_approved_by: prqApproverRes.rows.length,
      purchase_order_approved_by: poApproverRes.rows.length,
      goods_receipt_approved_by: grnApproverRes.rows.length,
      purchase_invoice_approved_by: piApproverRes.rows.length,
      vendor_payment_approved_by: vpApproverRes.rows.length,
    };
    results.approval_chains_transferred = Object.values(results.approval_chain_breakdown).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  return results;
}

async function previewUserTransfer(client, { fromUserId, includeClosed, transferLeads, transferQuotes, transferSalesOrders, transferJobCards, transferPurchaseRequisitions, transferDispatches, transferCustomerInvoices, transferGoodsReceipts, transferQualityControls, transferSupplierClaims, transferPurchaseReturns, transferSalesReturns, transferPurchaseOrders, transferPurchaseInvoices, transferVendorPayments, transferCustomerReceipts, transferFinanceEntries, transferStockAdjustments, transferStockTransfers, transferServiceCases, transferAmcContracts, transferApprovalChains }) {
  async function countCreatedByRows({ table, statusColumn, openStatuses }) {
    const params = [fromUserId];
    const where = [`created_by = $1`];
    if (!includeClosed && Array.isArray(openStatuses) && openStatuses.length && statusColumn) {
      params.push(openStatuses);
      where.push(`${statusColumn} = any($2::text[])`);
    }
    const r = await client.query(
      `
        select count(*)::int as count
        from ${table}
        where ${where.join(" and ")}
      `,
      params
    );
    return Number(r.rows[0]?.count || 0);
  }

  const results = {
    leads_transferred: 0,
    quotes_transferred: 0,
    sales_orders_transferred: 0,
    job_cards_transferred: 0,
    purchase_requisitions_transferred: 0,
    dispatches_transferred: 0,
    customer_invoices_transferred: 0,
    goods_receipts_transferred: 0,
    quality_controls_transferred: 0,
    supplier_claims_transferred: 0,
    supplier_claim_receipts_transferred: 0,
    purchase_returns_transferred: 0,
    sales_returns_transferred: 0,
    purchase_orders_transferred: 0,
    purchase_invoices_transferred: 0,
    vendor_payments_transferred: 0,
    customer_receipts_transferred: 0,
    finance_entries_transferred: 0,
    stock_adjustments_transferred: 0,
    stock_transfers_transferred: 0,
    service_cases_transferred: 0,
    amc_contracts_transferred: 0,
    approval_chains_transferred: 0,
    approval_chain_breakdown: {
      quote_draft_prepared_by: 0,
      quote_pending_approvals: 0,
      purchase_requisition_submitted_by: 0,
      purchase_order_submitted_by: 0,
      goods_receipt_submitted_by: 0,
      purchase_invoice_submitted_by: 0,
      vendor_payment_submitted_by: 0,
      purchase_requisition_approved_by: 0,
      purchase_order_approved_by: 0,
      goods_receipt_approved_by: 0,
      purchase_invoice_approved_by: 0,
      vendor_payment_approved_by: 0,
    },
  };

  if (transferLeads) {
    const params = [fromUserId];
    const where = [`assigned_to = $1`];
    if (!includeClosed) {
      params.push(["new", "follow_up", "qualified", "quoted"]);
      where.push(`status = any($2::text[])`);
    }
    const r = await client.query(
      `
        select count(*)::int as count
        from leads
        where ${where.join(" and ")}
      `,
      params
    );
    results.leads_transferred = Number(r.rows[0]?.count || 0);
  }

  if (transferQuotes) {
    const countParams = [fromUserId];
    let countStatusSql = "";
    if (!includeClosed) {
      countParams.push(["draft", "submitted", "approved", "issued", "sent", "converted"]);
      countStatusSql = "and quote_status = any($2::text[])";
    }
    const counted = await client.query(
      `select count(*)::int as count from quote_headers where coalesce(owner_user_id, created_by) = $1 ${countStatusSql}`,
      countParams
    );
    results.quotes_transferred = Number(counted.rows[0]?.count || 0);
  }

  if (transferSalesOrders) {
    results.sales_orders_transferred = await countCreatedByRows({
      table: "sales_orders",
      statusColumn: "order_status",
      openStatuses: ["draft", "confirmed"],
    });
  }

  if (transferJobCards) {
    results.job_cards_transferred = await countCreatedByRows({
      table: "job_cards",
      statusColumn: "job_status",
      openStatuses: ["draft", "open"],
    });
  }

  if (transferPurchaseRequisitions) {
    results.purchase_requisitions_transferred = await countCreatedByRows({
      table: "purchase_requisitions",
      statusColumn: "requisition_status",
      openStatuses: ["draft", "submitted", "approved"],
    });
  }

  if (transferDispatches) {
    results.dispatches_transferred = await countCreatedByRows({
      table: "dispatches",
      statusColumn: "dispatch_status",
      openStatuses: ["draft", "ready", "dispatched"],
    });
  }

  if (transferCustomerInvoices) {
    results.customer_invoices_transferred = await countCreatedByRows({
      table: "customer_invoices",
      statusColumn: "invoice_status",
      openStatuses: ["draft", "issued"],
    });
  }

  if (transferGoodsReceipts) {
    results.goods_receipts_transferred = await countCreatedByRows({
      table: "goods_receipts",
      statusColumn: "receipt_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferQualityControls) {
    results.quality_controls_transferred = await countCreatedByRows({
      table: "quality_controls",
      statusColumn: "qc_status",
      openStatuses: ["draft"],
    });
  }

  if (transferSupplierClaims) {
    results.supplier_claims_transferred = await countCreatedByRows({
      table: "supplier_claims",
      statusColumn: "claim_status",
      openStatuses: ["open"],
    });
    results.supplier_claim_receipts_transferred = await countCreatedByRows({
      table: "supplier_claim_receipts",
      statusColumn: null,
      openStatuses: null,
    });
  }

  if (transferPurchaseReturns) {
    results.purchase_returns_transferred = await countCreatedByRows({
      table: "purchase_returns",
      statusColumn: "return_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferSalesReturns) {
    results.sales_returns_transferred = await countCreatedByRows({
      table: "sales_returns",
      statusColumn: "return_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferPurchaseOrders) {
    results.purchase_orders_transferred = await countCreatedByRows({
      table: "purchase_orders",
      statusColumn: "po_status",
      openStatuses: ["draft", "confirmed"],
    });
  }

  if (transferPurchaseInvoices) {
    results.purchase_invoices_transferred = await countCreatedByRows({
      table: "purchase_invoices",
      statusColumn: "invoice_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferVendorPayments) {
    results.vendor_payments_transferred = await countCreatedByRows({
      table: "vendor_payments",
      statusColumn: "payment_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferCustomerReceipts) {
    results.customer_receipts_transferred = await countCreatedByRows({
      table: "customer_receipts",
      statusColumn: "receipt_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferFinanceEntries) {
    results.finance_entries_transferred = await countCreatedByRows({
      table: "finance_book_entries",
      statusColumn: null,
      openStatuses: null,
    });
  }

  if (transferStockAdjustments) {
    results.stock_adjustments_transferred = await countCreatedByRows({
      table: "stock_adjustments",
      statusColumn: "adjustment_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferStockTransfers) {
    results.stock_transfers_transferred = await countCreatedByRows({
      table: "stock_transfers",
      statusColumn: "transfer_status",
      openStatuses: ["draft", "posted"],
    });
  }

  if (transferServiceCases) {
    results.service_cases_transferred = await countCreatedByRows({
      table: "service_warranty_cases",
      statusColumn: "case_status",
      openStatuses: ["open"],
    });
  }

  if (transferAmcContracts) {
    results.amc_contracts_transferred = await countCreatedByRows({
      table: "amc_contracts",
      statusColumn: "contract_status",
      openStatuses: ["draft", "active"],
    });
  }

  if (transferApprovalChains) {
    const draftPreparedRes = await client.query(
      `
        select count(*)::int as count
        from quote_revisions
        where prepared_by = $1
          and revision_status = 'draft'
      `,
      [fromUserId]
    );

    const quoteApprovalsRes = await client.query(
      `
        select count(*)::int as count
        from quote_approvals
        where (requested_by = $1 or approver_user_id = $1)
          and approval_status = 'pending'
          and acted_by_user_id is null
      `,
      [fromUserId]
    );

    const submittedStatuses = ["draft", "submitted"];
    const submittedFilters = includeClosed ? "" : `and ${"${STATUS_COL}"} = any($2::text[])`;
    const submittedParams = includeClosed ? [fromUserId] : [fromUserId, submittedStatuses];

    const prqSubmittedRes = await client.query(
      `
        select count(*)::int as count
        from purchase_requisitions
        where submitted_by = $1
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "requisition_status")})
      `,
      submittedParams
    );

    const poSubmittedRes = await client.query(
      `
        select count(*)::int as count
        from purchase_orders
        where submitted_by = $1
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "po_status")})
      `,
      submittedParams
    );

    const grnSubmittedRes = await client.query(
      `
        select count(*)::int as count
        from goods_receipts
        where submitted_by = $1
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "receipt_status")})
      `,
      submittedParams
    );

    const piSubmittedRes = await client.query(
      `
        select count(*)::int as count
        from purchase_invoices
        where submitted_by = $1
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "invoice_status")})
      `,
      submittedParams
    );

    const vpSubmittedRes = await client.query(
      `
        select count(*)::int as count
        from vendor_payments
        where submitted_by = $1
          and (submitted_at is null ${submittedFilters.replace("${STATUS_COL}", "payment_status")})
      `,
      submittedParams
    );

    const approverStatuses = ["submitted"];
    const approverFilters = includeClosed ? "" : `and ${"${STATUS_COL}"} = any($2::text[])`;
    const approverParams = includeClosed ? [fromUserId] : [fromUserId, approverStatuses];

    const prqApproverRes = await client.query(
      `
        select count(*)::int as count
        from purchase_requisitions
        where approved_by = $1
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "requisition_status")}
      `,
      approverParams
    );

    const poApproverRes = await client.query(
      `
        select count(*)::int as count
        from purchase_orders
        where approved_by = $1
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "po_status")}
      `,
      approverParams
    );

    const grnApproverRes = await client.query(
      `
        select count(*)::int as count
        from goods_receipts
        where approved_by = $1
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "receipt_status")}
      `,
      approverParams
    );

    const piApproverRes = await client.query(
      `
        select count(*)::int as count
        from purchase_invoices
        where approved_by = $1
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "invoice_status")}
      `,
      approverParams
    );

    const vpApproverRes = await client.query(
      `
        select count(*)::int as count
        from vendor_payments
        where approved_by = $1
          and approved_at is null
          ${approverFilters.replace("${STATUS_COL}", "payment_status")}
      `,
      approverParams
    );

    results.approval_chain_breakdown = {
      quote_draft_prepared_by: Number(draftPreparedRes.rows[0]?.count || 0),
      quote_pending_approvals: Number(quoteApprovalsRes.rows[0]?.count || 0),
      purchase_requisition_submitted_by: Number(prqSubmittedRes.rows[0]?.count || 0),
      purchase_order_submitted_by: Number(poSubmittedRes.rows[0]?.count || 0),
      goods_receipt_submitted_by: Number(grnSubmittedRes.rows[0]?.count || 0),
      purchase_invoice_submitted_by: Number(piSubmittedRes.rows[0]?.count || 0),
      vendor_payment_submitted_by: Number(vpSubmittedRes.rows[0]?.count || 0),
      purchase_requisition_approved_by: Number(prqApproverRes.rows[0]?.count || 0),
      purchase_order_approved_by: Number(poApproverRes.rows[0]?.count || 0),
      goods_receipt_approved_by: Number(grnApproverRes.rows[0]?.count || 0),
      purchase_invoice_approved_by: Number(piApproverRes.rows[0]?.count || 0),
      vendor_payment_approved_by: Number(vpApproverRes.rows[0]?.count || 0),
    };
    results.approval_chains_transferred = Object.values(results.approval_chain_breakdown).reduce((sum, value) => sum + Number(value || 0), 0);
  }

  return results;
}

router.use(requireAuth);
router.use(requireSuperAdmin);

router.get("/bootstrap", async (_req, res, next) => {
  try {
    const bootstrap = await loadBootstrapData(pool);
    return res.json({ ok: true, ...bootstrap });
  } catch (err) {
    return next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const q = normalizeText(req.query.q);
    const params = [];
    let where = "";
    if (q.length) {
      params.push(`%${q}%`);
      where = `
        where
          u.user_code ilike $1 or
          u.full_name ilike $1 or
          u.email ilike $1 or
          coalesce(u.company_name, '') ilike $1 or
          coalesce(d.company_name, '') ilike $1
      `;
    }
    const r = await pool.query(
      `
        ${USER_SELECT}
        ${where}
        order by u.updated_at desc, u.id desc
      `,
      params
    );
    return res.json({ ok: true, users: r.rows });
  } catch (err) {
    return next(err);
  }
});

async function createUser(req, res, next) {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    let accessChanges = [];
    if (Array.isArray(body.access_overrides) && body.access_overrides.length) {
      if (accessModelMode() === "off") return res.status(400).json({ ok: false, error: "ACCESS_V2_OFF" });
      const { changes, errors } = normalizeOverrideChanges(body.access_overrides);
      if (errors.length) return res.status(400).json({ ok: false, error: "INVALID_CHANGES", detail: errors.join(", "), invalid: errors });
      accessChanges = changes.filter((c) => !c.clear);
      if (accessChanges.length && !normalizeText(body.access_reason)) {
        return res.status(400).json({ ok: false, error: "REASON_REQUIRED", detail: "Give a reason for the access exceptions." });
      }
    }
    const email = normalizeEmail(body.email);
    const fullName = normalizeText(body.full_name);
    let groupId = normalizeId(body.group_id);
    const roleId = normalizeId(body.role_id);
    const distributorId = normalizeId(body.distributor_id);
    const primaryManagerUserId = normalizeId(body.primary_manager_user_id);
    const secondaryManagerUserId = normalizeId(body.secondary_manager_user_id);
    const isApproved = body.is_approved === undefined ? true : normalizeBool(body.is_approved);
    let departmentKey = normalizeText(body.department_key) || null;
    const employmentCompanyId = normalizeId(body.employment_company_id);
    const companyIds = normalizeIdArray(body.company_ids);
    const primaryCompanyId = normalizeId(body.primary_company_id) || employmentCompanyId;

    if (!email || !fullName) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    if (!roleId && !groupId) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    await client.query("begin");

    const managerProblem = await findManagerAssignmentProblem(client, {
      userId: null,
      primaryManagerUserId,
      secondaryManagerUserId,
    });
    if (managerProblem) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, ...managerProblem });
    }

    const duplicateEmailUser = await findUserByEmail(client, email);
    if (duplicateEmailUser) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_EMAIL",
        detail: `Email already used by ${duplicateEmailUser.full_name || "another user"} (${duplicateEmailUser.user_code || duplicateEmailUser.email}).`,
        conflicting_user: duplicateEmailUser,
      });
    }

    if (roleId) {
      const aligned = await applyRoleProfileIdentity(client, { roleId, groupId, departmentKey });
      if (aligned.groupId) groupId = aligned.groupId;
      // With Access Profiles the department is chosen by the admin (org chart), not derived from the profile.
      departmentKey = accessModelMode() !== "off" && departmentKey ? departmentKey : aligned.departmentKey;
    }

    if (!groupId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }

    const groupRes = await client.query(`select id, group_name from user_groups where id = $1 and is_active = true limit 1`, [groupId]);
    const group = groupRes.rows[0] || null;
    if (!group) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_GROUP" });
    }

    // SuperAdmin privilege band only with super_admin role — blocks business_admin / Staff elevation
    if (group.group_name === "SuperAdmin") {
      if (!roleId) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SUPERADMIN_REQUIRES_SUPER_ADMIN_ROLE" });
      }
      const rk = await client.query(`select role_key from roles where id = $1 limit 1`, [roleId]);
      if (String(rk.rows[0]?.role_key || "") !== "super_admin") {
        await client.query("rollback");
        return res.status(400).json({
          ok: false,
          error: "SUPERADMIN_REQUIRES_SUPER_ADMIN_ROLE",
          detail: "Only the Super Admin role may be placed in the SuperAdmin group.",
        });
      }
    }

    if (departmentKey) {
      const depRes = await client.query(
        `select department_key from departments where department_key = $1 and is_active = true limit 1`,
        [departmentKey]
      );
      if (!depRes.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_DEPARTMENT" });
      }
    }

    if (employmentCompanyId) {
      const coRes = await client.query(`select id from companies where id = $1 and is_active = true limit 1`, [employmentCompanyId]);
      if (!coRes.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_EMPLOYMENT_COMPANY" });
      }
    }

    const ins = await client.query(
      `
        insert into erp_users (
          email,
          full_name,
          group_id,
          primary_role_id,
          is_active,
          is_approved,
          phone,
          designation,
          company_name,
          employee_code,
          department_key,
          employment_company_id,
          primary_manager_user_id,
          secondary_manager_user_id,
          date_of_joining,
          local_address,
          permanent_address,
          discount_threshold_pct,
          updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
        returning id
      `,
      [
        email,
        fullName,
        groupId,
        roleId,
        body.is_active === undefined || body.is_active === null ? true : normalizeBool(body.is_active),
        isApproved,
        normalizeText(body.phone) || null,
        normalizeText(body.designation) || null,
        normalizeText(body.company_name) || null,
        normalizeText(body.employee_code) || null,
        departmentKey,
        employmentCompanyId,
        primaryManagerUserId,
        secondaryManagerUserId,
        normalizeDate(body.date_of_joining),
        normalizeText(body.local_address) || null,
        normalizeText(body.permanent_address) || null,
        normalizePct(body.discount_threshold_pct),
      ]
    );
    const userId = Number(ins.rows[0]?.id);

    await syncPrimaryRole(client, userId, roleId);
    const isDistributorUser = group.group_name === "Distributor";
    await syncDistributorLink(client, userId, isDistributorUser ? distributorId : null);
    await upsertPassword(client, userId, body.password);
    const memberCompanyIds =
      isDistributorUser && !companyIds.length && !primaryCompanyId
        ? await defaultDistributorCompanyIds(client, req, { distributorId, primaryManagerUserId })
        : companyIds;
    await syncCompanyMemberships(client, userId, { companyIds: memberCompanyIds, primaryCompanyId });
    await ensureEmployeeCode(client, userId);
    if (accessChanges.length) {
      await applyPersonChange(client, userId, {
        changes: accessChanges,
        reason: normalizeText(body.access_reason),
        actorId: req.user?.id,
        action: "user_provisioned_access",
      });
    }

    const user = await getUserById(client, userId);
    const memberships = await fetchUserCompanyMemberships(client, userId);
    await writeUserAccessAudit(client, {
      actorUserId: req.user?.id,
      targetUserId: userId,
      action: "user_created",
      afterJson: {
        email: user?.email || email,
        group_id: groupId,
        role_id: roleId,
        is_active: Boolean(user?.is_active),
        is_approved: Boolean(user?.is_approved),
        company_ids: memberships.map((row) => Number(row.company_id)).filter((n) => Number.isFinite(n)),
        primary_company_id: primaryCompanyId,
      },
    });
    await client.query("commit");
    return res.json({ ok: true, user, memberships });
  } catch (err) {
    await client.query("rollback");
    if (err && err.status && typeof err.code === "string" && /^[A-Z_]+$/.test(err.code)) {
      return res.status(err.status).json({ ok: false, error: err.code, detail: err.detail || undefined });
    }
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_USER" });
    if (err && err.code === "INVALID_DISTRIBUTOR") {
      return res.status(400).json({ ok: false, error: "INVALID_DISTRIBUTOR", detail: err.detail || err.message });
    }
    if (err && err.code === "23503") {
      return res.status(409).json({
        ok: false,
        error: "FOREIGN_KEY_VIOLATION",
        detail: err.detail || err.message || "A related record is missing (distributor, company, manager, or role).",
        pg_code: "23503",
        constraint: err.constraint || null,
      });
    }
    return next(err);
  } finally {
    client.release();
  }
}
router.post("/", createUser);

router.put("/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) return res.status(400).json({ ok: false });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const email = normalizeEmail(body.email);
    const fullName = normalizeText(body.full_name);
    let groupId = normalizeId(body.group_id);
    const roleId = normalizeId(body.role_id);
    const distributorId = normalizeId(body.distributor_id);
    const primaryManagerUserId = normalizeId(body.primary_manager_user_id);
    const secondaryManagerUserId = normalizeId(body.secondary_manager_user_id);
    let departmentKey = normalizeText(body.department_key) || null;
    const employmentCompanyId = normalizeId(body.employment_company_id);
    const companyIds = normalizeIdArray(body.company_ids);
    const primaryCompanyId = normalizeId(body.primary_company_id) || employmentCompanyId;

    if (!email || !fullName) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    if (!roleId && !groupId) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

    await client.query("begin");

    const existingRes = await client.query(`select id, is_active, is_approved from erp_users where id = $1 limit 1 for update`, [userId]);
    if (!existingRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    }
    // Omitted status flags keep their stored value; only an explicit false disables or un-approves.
    const isApproved =
      body.is_approved === undefined || body.is_approved === null
        ? existingRes.rows[0].is_approved !== false
        : normalizeBool(body.is_approved);

    const managerProblem = await findManagerAssignmentProblem(client, {
      userId,
      primaryManagerUserId,
      secondaryManagerUserId,
    });
    if (managerProblem) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, ...managerProblem });
    }

    const duplicateEmailUser = await findUserByEmail(client, email, { excludeUserId: userId });
    if (duplicateEmailUser) {
      await client.query("rollback");
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_EMAIL",
        detail: `Email already used by ${duplicateEmailUser.full_name || "another user"} (${duplicateEmailUser.user_code || duplicateEmailUser.email}).`,
        conflicting_user: duplicateEmailUser,
      });
    }

    if (roleId) {
      const aligned = await applyRoleProfileIdentity(client, { roleId, groupId, departmentKey });
      if (aligned.groupId) groupId = aligned.groupId;
      // With Access Profiles the department is chosen by the admin (org chart), not derived from the profile.
      departmentKey = accessModelMode() !== "off" && departmentKey ? departmentKey : aligned.departmentKey;
    }

    if (!groupId) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }

    const groupRes = await client.query(`select id, group_name from user_groups where id = $1 and is_active = true limit 1`, [groupId]);
    const group = groupRes.rows[0] || null;
    if (!group) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "INVALID_GROUP" });
    }

    // SuperAdmin privilege band only with super_admin role — blocks business_admin / Staff elevation
    if (group.group_name === "SuperAdmin") {
      if (!roleId) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "SUPERADMIN_REQUIRES_SUPER_ADMIN_ROLE" });
      }
      const rk = await client.query(`select role_key from roles where id = $1 limit 1`, [roleId]);
      if (String(rk.rows[0]?.role_key || "") !== "super_admin") {
        await client.query("rollback");
        return res.status(400).json({
          ok: false,
          error: "SUPERADMIN_REQUIRES_SUPER_ADMIN_ROLE",
          detail: "Only the Super Admin role may be placed in the SuperAdmin group.",
        });
      }
    }

    if (departmentKey) {
      const depRes = await client.query(
        `select department_key from departments where department_key = $1 and is_active = true limit 1`,
        [departmentKey]
      );
      if (!depRes.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_DEPARTMENT" });
      }
    }

    if (employmentCompanyId) {
      const coRes = await client.query(`select id from companies where id = $1 and is_active = true limit 1`, [employmentCompanyId]);
      if (!coRes.rows[0]) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_EMPLOYMENT_COMPANY" });
      }
    }

    const wasApproved = existingRes.rows[0]?.is_approved === true;
    const wasActive = existingRes.rows[0]?.is_active === true;
    const nextActive =
      body.is_active === undefined || body.is_active === null ? wasActive : normalizeBool(body.is_active);
    const willApproveNow = !wasApproved && isApproved === true;
    const willDisableNow = wasActive && nextActive === false;

    await client.query(
      `
        update erp_users
        set
          email = $1,
          full_name = $2,
          group_id = $3,
          primary_role_id = $4,
          is_active = $5,
          is_approved = $6,
          phone = $7,
          designation = $8,
          company_name = $9,
          employee_code = $10,
          department_key = $11,
          employment_company_id = $12,
          primary_manager_user_id = $13,
          secondary_manager_user_id = $14,
          date_of_joining = $15,
          local_address = $16,
          permanent_address = $17,
          discount_threshold_pct = $18,
          approved_by = case when $19::boolean then $20 else approved_by end,
          approved_at = case when $19::boolean then now() else approved_at end,
          approval_requested_at = case when $19::boolean then null else approval_requested_at end,
          updated_at = now()
        where id = $21
      `,
      [
        email,
        fullName,
        groupId,
        roleId,
        nextActive,
        isApproved,
        normalizeText(body.phone) || null,
        normalizeText(body.designation) || null,
        normalizeText(body.company_name) || null,
        normalizeText(body.employee_code) || null,
        departmentKey,
        employmentCompanyId,
        primaryManagerUserId,
        secondaryManagerUserId,
        normalizeDate(body.date_of_joining),
        normalizeText(body.local_address) || null,
        normalizeText(body.permanent_address) || null,
        normalizePct(body.discount_threshold_pct),
        willApproveNow,
        req.user.id,
        userId,
      ]
    );

    await syncPrimaryRole(client, userId, roleId);
    await syncDistributorLink(client, userId, group.group_name === "Distributor" ? distributorId : null);
    await upsertPassword(client, userId, body.password);
    await syncCompanyMemberships(client, userId, { companyIds, primaryCompanyId });
    await ensureEmployeeCode(client, userId);

    const user = await getUserById(client, userId);
    const memberships = await fetchUserCompanyMemberships(client, userId);
    if (willDisableNow) {
      await writeUserAccessAudit(client, {
        actorUserId: req.user?.id,
        targetUserId: userId,
        action: "user_disabled",
        beforeJson: { is_active: true },
        afterJson: { is_active: false, email: user?.email || email },
      });
    } else if (willApproveNow) {
      await writeUserAccessAudit(client, {
        actorUserId: req.user?.id,
        targetUserId: userId,
        action: "user_approved",
        beforeJson: { is_approved: false },
        afterJson: { is_approved: true },
      });
    }
    await client.query("commit");
    return res.json({ ok: true, user, memberships });
  } catch (err) {
    await client.query("rollback");
    if (err && err.code === "23505") return res.status(409).json({ ok: false, error: "DUPLICATE_USER" });
    if (err && err.code === "INVALID_DISTRIBUTOR") {
      return res.status(400).json({ ok: false, error: "INVALID_DISTRIBUTOR", detail: err.detail || err.message });
    }
    if (err && err.code === "23503") {
      return res.status(409).json({
        ok: false,
        error: "FOREIGN_KEY_VIOLATION",
        detail: err.detail || err.message || "A related record is missing (distributor, company, manager, or role).",
        pg_code: "23503",
        constraint: err.constraint || null,
      });
    }
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/detail/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId)) return res.status(400).json({ ok: false });
    const user = await getUserById(client, userId);
    if (!user) return res.status(404).json({ ok: false, error: "NOT_FOUND" });
    const memberships = await fetchUserCompanyMemberships(client, userId);
    return res.json({ ok: true, user, memberships });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/:id/approval-authority", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const user = await getUserById(client, userId);
    if (!user) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    const authorities = await loadUserAuthoritySnapshot(client, {
      userId,
      companyId: Number(companyId),
      roleId: normalizeId(user.role_id),
      groupId: normalizeId(user.group_id),
    });

    return res.json({
      ok: true,
      user_id: userId,
      company_id: Number(companyId),
      authorities,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.put("/:id/approval-authority", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) return res.status(400).json({ ok: false, error: "INVALID_ID" });

    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.status(400).json({ ok: false, error: "COMPANY_NOT_SELECTED" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const incoming = Array.isArray(body.authorities)
      ? body.authorities
      : Array.isArray(body.limits)
        ? body.limits
        : null;
    if (!incoming) return res.status(400).json({ ok: false, error: "AUTHORITIES_REQUIRED" });

    const user = await getUserById(client, userId);
    if (!user) return res.status(404).json({ ok: false, error: "NOT_FOUND" });

    await client.query("begin");

    for (const item of incoming) {
      const docType = typeof item?.doc_type === "string" ? item.doc_type.trim() : "";
      if (!AUTHORITY_DOC_TYPES.includes(docType)) {
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "INVALID_DOC_TYPE", detail: docType });
      }

      const clearOverride = item.clear === true || item.inherit === true;
      const hasMaxAmount = Object.prototype.hasOwnProperty.call(item, "max_amount");

      if (clearOverride) {
        await client.query(
          `
            update approval_policies
            set is_active = false,
                updated_at = now()
            where company_id = $1
              and user_id = $2
              and doc_type = $3
              and is_active = true
          `,
          [Number(companyId), userId, docType]
        );
        continue;
      }

      if (!hasMaxAmount) continue;

      // null = unlimited user ceiling; number = capped override. Role/group rows are never mutated.
      const maxAmount = moneyOrNull(item.max_amount);

      const existing = await client.query(
        `
          select id
          from approval_policies
          where company_id = $1
            and user_id = $2
            and doc_type = $3
            and level_no = 1
            and vendor_id is null
          order by is_active desc, id desc
          limit 1
        `,
        [Number(companyId), userId, docType]
      );

      if (existing.rows[0]?.id) {
        await client.query(
          `
            update approval_policies
            set
              role_id = null,
              group_id = null,
              vendor_id = null,
              min_amount = 0,
              max_amount = $2,
              is_active = true,
              remarks = coalesce(remarks, 'User authority override'),
              updated_at = now()
            where id = $1
          `,
          [existing.rows[0].id, maxAmount]
        );
      } else {
        await client.query(
          `
            insert into approval_policies (
              company_id,
              doc_type,
              level_no,
              user_id,
              role_id,
              group_id,
              vendor_id,
              min_amount,
              max_amount,
              remarks,
              is_active,
              created_by
            )
            values ($1,$2,1,$3,null,null,null,0,$4,'User authority override',true,$5)
          `,
          [Number(companyId), docType, userId, maxAmount, req.user.id]
        );
      }
    }

    const authorities = await loadUserAuthoritySnapshot(client, {
      userId,
      companyId: Number(companyId),
      roleId: normalizeId(user.role_id),
      groupId: normalizeId(user.group_id),
    });

    await client.query("commit");
    return res.json({
      ok: true,
      user_id: userId,
      company_id: Number(companyId),
      authorities,
    });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin/transfer-work", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromUserId = normalizeId(body.from_user_id);
    const toUserId = normalizeId(body.to_user_id);
    const options = parseTransferOptions(body);

    if (!fromUserId || !toUserId || fromUserId === toUserId) {
      return res.status(400).json({ ok: false, error: "INVALID_TRANSFER" });
    }

    await client.query("begin");

    const fromRes = await client.query(`select id from erp_users where id = $1 limit 1`, [fromUserId]);
    const toRes = await client.query(`select id from erp_users where id = $1 limit 1`, [toUserId]);
    if (!fromRes.rows[0] || !toRes.rows[0]) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    }

    const results = await executeUserTransfer(client, {
      fromUserId,
      toUserId,
      actingUserId: req.user.id,
      reasonPrefix: "Bulk transfer",
      ...options,
    });

    await client.query("commit");

    if (Number(results.leads_transferred) > 0) {
      const count = Number(results.leads_transferred);
      notifyUser({
        userId: toUserId,
        companyId: null,
        actorUserId: req.user.id,
        eventType: "lead_assigned",
        title: `${count} lead${count === 1 ? "" : "s"} transferred to you`,
        body: "Open Leads and continue follow-up on the work that was reassigned.",
        page: "leads",
        entityId: null,
        payload: { transferred_count: count, from_user_id: fromUserId },
      }).catch(() => {});
    }

    return res.json({ ok: true, ...results });
  } catch (err) {
    await client.query("rollback");
    return next(err);
  } finally {
    client.release();
  }
});

router.get("/admin/offboarding-audits", async (req, res, next) => {
  try {
    const readyRes = await pool.query(`select to_regclass('public.offboarding_audits') is not null as offboarding_audits_ready`);
    const offboardingAuditsReady = Boolean(readyRes.rows[0]?.offboarding_audits_ready);
    if (!offboardingAuditsReady) return res.json({ ok: true, offboarding_audits_ready: false, audits: [] });

    const q = normalizeText(req.query.q);
    const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from.trim() : "";
    const dateTo = typeof req.query.date_to === "string" ? req.query.date_to.trim() : "";
    const params = [];
    const where = [];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        coalesce(offboarded.full_name, '') ilike $${params.length} or
        coalesce(offboarded.email, '') ilike $${params.length} or
        coalesce(replacement.full_name, '') ilike $${params.length} or
        coalesce(replacement.email, '') ilike $${params.length} or
        coalesce(actor.full_name, '') ilike $${params.length} or
        coalesce(actor.email, '') ilike $${params.length}
      )`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      where.push(`oa.created_at::date >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      where.push(`oa.created_at::date <= $${params.length}::date`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const r = await pool.query(
      `
        select
          oa.id,
          oa.created_at,
          oa.include_closed,
          oa.reassign_reportees,
          oa.scopes,
          oa.before_counts,
          oa.after_counts,
          oa.moved_counts,
          oa.offboarded_user_id,
          offboarded.full_name as offboarded_user_name,
          offboarded.email as offboarded_user_email,
          oa.replacement_user_id,
          replacement.full_name as replacement_user_name,
          replacement.email as replacement_user_email,
          oa.performed_by,
          actor.full_name as performed_by_name,
          actor.email as performed_by_email
        from offboarding_audits oa
        left join erp_users offboarded on offboarded.id = oa.offboarded_user_id
        left join erp_users replacement on replacement.id = oa.replacement_user_id
        left join erp_users actor on actor.id = oa.performed_by
        ${whereSql}
        order by oa.created_at desc, oa.id desc
        limit 200
      `,
      params
    );
    return res.json({ ok: true, offboarding_audits_ready: true, audits: r.rows });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/offboard-preview", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromUserId = normalizeId(body.from_user_id);
    const toUserId = normalizeId(body.to_user_id);
    const reassignReportees = body.reassign_reportees === undefined ? true : normalizeBool(body.reassign_reportees);
    const options = parseTransferOptions(body);

    if (!fromUserId || !toUserId || fromUserId === toUserId) {
      return res.status(400).json({ ok: false, error: "INVALID_TRANSFER" });
    }
    if (fromUserId === Number(req.user.id)) {
      return res.status(400).json({ ok: false, error: "SELF_OFFBOARD_NOT_ALLOWED" });
    }

    const [fromRes, toRes] = await Promise.all([
      client.query(`select id, is_active from erp_users where id = $1 limit 1`, [fromUserId]),
      client.query(`select id, is_active from erp_users where id = $1 limit 1`, [toUserId]),
    ]);
    const fromUser = fromRes.rows[0] || null;
    const toUser = toRes.rows[0] || null;
    if (!fromUser || !toUser) {
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    }
    if (fromUser.is_active === false) {
      return res.status(400).json({ ok: false, error: "USER_ALREADY_INACTIVE" });
    }
    if (toUser.is_active === false) {
      return res.status(400).json({ ok: false, error: "TARGET_USER_INACTIVE" });
    }

    const transferResults = await previewUserTransfer(client, {
      fromUserId,
      ...options,
    });

    let reporteesToReassign = 0;
    if (reassignReportees) {
      const reporteesRes = await client.query(
        `
          select count(*)::int as count
          from erp_users
          where id <> $1
            and (primary_manager_user_id = $1 or secondary_manager_user_id = $1)
        `,
        [fromUserId]
      );
      reporteesToReassign = Number(reporteesRes.rows[0]?.count || 0);
    }

    return res.json({
      ok: true,
      reportees_to_reassign: reporteesToReassign,
      ...transferResults,
    });
  } catch (err) {
    return next(err);
  } finally {
    client.release();
  }
});

router.post("/admin/offboard-user", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromUserId = normalizeId(body.from_user_id);
    const toUserId = normalizeId(body.to_user_id);
    const reassignReportees = body.reassign_reportees === undefined ? true : normalizeBool(body.reassign_reportees);
    const options = parseTransferOptions(body);

    if (!fromUserId || !toUserId || fromUserId === toUserId) {
      return res.status(400).json({ ok: false, error: "INVALID_TRANSFER" });
    }
    if (fromUserId === Number(req.user.id)) {
      return res.status(400).json({ ok: false, error: "SELF_OFFBOARD_NOT_ALLOWED" });
    }

    await client.query("begin");

    const fromRes = await client.query(`select id, is_active from erp_users where id = $1 limit 1`, [fromUserId]);
    const toRes = await client.query(`select id, is_active from erp_users where id = $1 limit 1`, [toUserId]);
    const fromUser = fromRes.rows[0] || null;
    const toUser = toRes.rows[0] || null;
    if (!fromUser || !toUser) {
      await client.query("rollback");
      return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });
    }
    if (fromUser.is_active === false) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "USER_ALREADY_INACTIVE" });
    }
    if (toUser.is_active === false) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "TARGET_USER_INACTIVE" });
    }

    const auditReadyRes = await client.query(`select to_regclass('public.offboarding_audits') is not null as offboarding_audits_ready`);
    if (!Boolean(auditReadyRes.rows[0]?.offboarding_audits_ready)) {
      await client.query("rollback");
      return res.status(400).json({ ok: false, error: "OFFBOARDING_AUDITS_NOT_READY" });
    }

    const beforeTransferResults = await previewUserTransfer(client, {
      fromUserId,
      ...options,
    });

    let beforeReportees = 0;
    if (reassignReportees) {
      const reporteesRes = await client.query(
        `
          select count(*)::int as count
          from erp_users
          where id <> $1
            and (primary_manager_user_id = $1 or secondary_manager_user_id = $1)
        `,
        [fromUserId]
      );
      beforeReportees = Number(reporteesRes.rows[0]?.count || 0);
    }

    const transferResults = await executeUserTransfer(client, {
      fromUserId,
      toUserId,
      actingUserId: req.user.id,
      reasonPrefix: "Offboarding transfer",
      ...options,
    });

    let reporteesReassigned = 0;
    if (reassignReportees) {
      try {
        const changedIds = await reassignDirectReports(client, { fromUserId, toUserId });
        reporteesReassigned = changedIds.length;
      } catch (reassignErr) {
        if (reassignErr?.code !== "MANAGER_CYCLE") throw reassignErr;
        await client.query("rollback");
        return res.status(400).json({ ok: false, error: "MANAGER_CYCLE", detail: reassignErr.message });
      }
    }

    // With Access Profiles enabled both offboarding desks finish with the same exit routine
    // (release assets, clear access exceptions, deactivate, end sessions, audit).
    let exitResult = null;
    if (accessModelMode() !== "off") {
      exitResult = await offboardEmployee(client, {
        userId: fromUserId,
        actorUserId: req.user.id,
        successorUserId: toUserId,
        notes: "Guided offboarding (Org & Access)",
      });
    } else {
      await client.query(`update erp_users set is_active = false, updated_at = now() where id = $1`, [fromUserId]);
    }

    const afterTransferResults = await previewUserTransfer(client, {
      fromUserId,
      ...options,
    });

    let afterReportees = 0;
    if (reassignReportees) {
      const reporteesRes = await client.query(
        `
          select count(*)::int as count
          from erp_users
          where id <> $1
            and (primary_manager_user_id = $1 or secondary_manager_user_id = $1)
        `,
        [fromUserId]
      );
      afterReportees = Number(reporteesRes.rows[0]?.count || 0);
    }

    const movedCounts = Object.keys(beforeTransferResults).reduce((acc, key) => {
      if (key === "approval_chain_breakdown") {
        const beforeBreakdown = beforeTransferResults.approval_chain_breakdown && typeof beforeTransferResults.approval_chain_breakdown === "object"
          ? beforeTransferResults.approval_chain_breakdown
          : {};
        const afterBreakdown = afterTransferResults.approval_chain_breakdown && typeof afterTransferResults.approval_chain_breakdown === "object"
          ? afterTransferResults.approval_chain_breakdown
          : {};
        acc.approval_chain_breakdown = Object.keys(beforeBreakdown).reduce((breakdownAcc, breakdownKey) => {
          breakdownAcc[breakdownKey] = Math.max(Number(beforeBreakdown[breakdownKey] || 0) - Number(afterBreakdown[breakdownKey] || 0), 0);
          return breakdownAcc;
        }, {});
        return acc;
      }
      acc[key] = Math.max(Number(beforeTransferResults[key] || 0) - Number(afterTransferResults[key] || 0), 0);
      return acc;
    }, {});
    movedCounts.reportees_moved = Math.max(beforeReportees - afterReportees, 0);

    const scopes = {
      include_closed: options.includeClosed,
      reassign_reportees: reassignReportees,
      transfer_leads: options.transferLeads,
      transfer_quotes: options.transferQuotes,
      transfer_sales_orders: options.transferSalesOrders,
      transfer_job_cards: options.transferJobCards,
      transfer_purchase_requisitions: options.transferPurchaseRequisitions,
      transfer_dispatches: options.transferDispatches,
      transfer_customer_invoices: options.transferCustomerInvoices,
      transfer_goods_receipts: options.transferGoodsReceipts,
      transfer_quality_controls: options.transferQualityControls,
      transfer_supplier_claims: options.transferSupplierClaims,
      transfer_purchase_returns: options.transferPurchaseReturns,
      transfer_sales_returns: options.transferSalesReturns,
      transfer_purchase_orders: options.transferPurchaseOrders,
      transfer_purchase_invoices: options.transferPurchaseInvoices,
      transfer_vendor_payments: options.transferVendorPayments,
      transfer_customer_receipts: options.transferCustomerReceipts,
      transfer_finance_entries: options.transferFinanceEntries,
      transfer_stock_adjustments: options.transferStockAdjustments,
      transfer_stock_transfers: options.transferStockTransfers,
      transfer_service_cases: options.transferServiceCases,
      transfer_amc_contracts: options.transferAmcContracts,
      transfer_approval_chains: options.transferApprovalChains,
    };

    const auditRes = await client.query(
      `
        insert into offboarding_audits (
          offboarded_user_id,
          replacement_user_id,
          performed_by,
          include_closed,
          reassign_reportees,
          scopes,
          before_counts,
          after_counts,
          moved_counts
        )
        values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)
        returning id
      `,
      [
        fromUserId,
        toUserId,
        req.user.id,
        Boolean(options.includeClosed),
        Boolean(reassignReportees),
        JSON.stringify(scopes),
        JSON.stringify({ ...beforeTransferResults, reportees_to_reassign: beforeReportees }),
        JSON.stringify({ ...afterTransferResults, reportees_remaining: afterReportees }),
        JSON.stringify(movedCounts),
      ]
    );
    const auditId = Number(auditRes.rows[0]?.id) || null;

    await client.query("commit");

    if (Number(transferResults.leads_transferred) > 0) {
      const count = Number(transferResults.leads_transferred);
      notifyUser({
        userId: toUserId,
        companyId: null,
        actorUserId: req.user.id,
        eventType: "lead_assigned",
        title: `${count} lead${count === 1 ? "" : "s"} transferred to you`,
        body: "Open Leads and continue follow-up on the work that was reassigned during offboarding.",
        page: "leads",
        entityId: null,
        payload: { transferred_count: count, from_user_id: fromUserId, source: "offboard" },
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      audit_id: auditId,
      deactivated_user_id: fromUserId,
      replacement_user_id: toUserId,
      reportees_reassigned: reporteesReassigned,
      exit: exitResult,
      ...transferResults,
    });
  } catch (err) {
    await client.query("rollback");
    if (err && err.status && typeof err.code === "string" && /^[A-Z_]+$/.test(err.code)) {
      return res.status(err.status).json({ ok: false, error: err.code, detail: err.detail || undefined });
    }
    return next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.createUser = createUser;
