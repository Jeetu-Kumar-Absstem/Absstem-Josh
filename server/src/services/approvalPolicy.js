const DOC_TYPES = [
  { key: "purchase_requisition", label: "Purchase Requisition / Indent" },
  { key: "purchase_order", label: "Purchase Order" },
  { key: "goods_receipt", label: "GRN / Inward" },
  { key: "purchase_invoice", label: "Purchase Invoice" },
  { key: "vendor_payment", label: "Vendor Payment" },
  { key: "leave_request", label: "Leave Request" },
  { key: "expense_claim", label: "Expense Claim" },
];

const DOC_CONFIG = {
  purchase_order: {
    screenKey: "purchase_orders",
    table: "purchase_orders",
    idColumn: "id",
    numberColumn: "po_number",
    dateColumn: "po_date",
    statusColumn: "po_status",
    pendingStatuses: ["submitted"],
    totalColumn: "grand_total_order",
    vendorColumn: "vendor_id",
    totalCurrencyJoin: "left join currencies curr on curr.id = d.order_currency_id",
    totalCurrencyCode: "curr.currency_code",
    vendorJoin: "join vendors v on v.id = d.vendor_id",
    vendorName: "v.company_name",
    postStatus: "closed",
  },
  purchase_requisition: {
    screenKey: "purchase_requisitions",
    table: "purchase_requisitions",
    idColumn: "id",
    numberColumn: "requisition_number",
    dateColumn: "requisition_date",
    statusColumn: "requisition_status",
    pendingStatuses: ["submitted"],
    totalColumn: "estimated_total",
    vendorColumn: "null",
    totalCurrencyJoin: "left join currencies curr on curr.id = 1",
    totalCurrencyCode: "'INR'",
    vendorJoin: "left join erp_users rq on rq.id = d.created_by",
    vendorName: "coalesce(d.department, rq.full_name, 'Internal Requisition')",
    postStatus: "closed",
  },
  goods_receipt: {
    screenKey: "goods_receipts",
    table: "goods_receipts",
    idColumn: "id",
    numberColumn: "grn_number",
    dateColumn: "receipt_date",
    statusColumn: "receipt_status",
    pendingStatuses: ["submitted"],
    totalColumn: "0",
    vendorColumn: "vendor_id",
    totalCurrencyJoin: "left join currencies curr on curr.id = 1",
    totalCurrencyCode: "'INR'",
    vendorJoin: "join vendors v on v.id = d.vendor_id",
    vendorName: "v.company_name",
    postStatus: "posted",
  },
  purchase_invoice: {
    screenKey: "purchase_invoices",
    table: "purchase_invoices",
    idColumn: "id",
    numberColumn: "purchase_invoice_number",
    dateColumn: "invoice_date",
    statusColumn: "invoice_status",
    pendingStatuses: ["submitted"],
    totalColumn: "grand_total_invoice",
    vendorColumn: "vendor_id",
    totalCurrencyJoin: "left join currencies curr on curr.id = d.invoice_currency_id",
    totalCurrencyCode: "curr.currency_code",
    vendorJoin: "join vendors v on v.id = d.vendor_id",
    vendorName: "v.company_name",
    postStatus: "posted",
  },
  vendor_payment: {
    screenKey: "vendor_payments",
    table: "vendor_payments",
    idColumn: "id",
    numberColumn: "payment_number",
    dateColumn: "payment_date",
    statusColumn: "payment_status",
    pendingStatuses: ["submitted"],
    totalColumn: "payment_amount",
    vendorColumn: "vendor_id",
    totalCurrencyJoin: "left join currencies curr on curr.id = d.payment_currency_id",
    totalCurrencyCode: "curr.currency_code",
    vendorJoin: "join vendors v on v.id = d.vendor_id",
    vendorName: "v.company_name",
    postStatus: "posted",
  },
  leave_request: {
    screenKey: "leave",
    table: "hr_leave_requests",
    idColumn: "id",
    numberColumn: "('LV-' || d.id::text)",
    dateColumn: "start_date",
    statusColumn: "leave_status",
    pendingStatuses: ["pending"],
    totalColumn: "coalesce(d.total_days, 0)",
    vendorColumn: "null",
    totalCurrencyJoin: "",
    totalCurrencyCode: "'INR'",
    vendorJoin: "left join erp_users emp on emp.id = d.employee_user_id",
    vendorName: "coalesce(d.employee_name, emp.full_name, 'Employee')",
    postStatus: "approved",
    hasApprovalLevels: false,
  },
  expense_claim: {
    screenKey: "expenses",
    table: "hr_expense_claims",
    idColumn: "id",
    numberColumn: "('EX-' || d.id::text)",
    dateColumn: "created_at::date",
    statusColumn: "claim_status",
    pendingStatuses: ["manager_pending"],
    totalColumn: "coalesce(d.amount, 0)",
    vendorColumn: "null",
    totalCurrencyJoin: "",
    totalCurrencyCode: "'INR'",
    vendorJoin: "left join erp_users emp on emp.id = d.employee_user_id",
    vendorName: "coalesce(d.employee_name, emp.full_name, 'Employee')",
    postStatus: "accounts_pending",
    hasApprovalLevels: false,
  },
};

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Number(qty(value).toFixed(2));
}

function getDocTypeOptions() {
  return DOC_TYPES.map((item) => ({ ...item }));
}

function getDocConfig(docType) {
  return DOC_CONFIG[docType] || null;
}

function docTypeLabel(docType) {
  return DOC_TYPES.find((item) => item.key === docType)?.label || docType || "Document";
}

function userMatchesPolicy(user, policy) {
  if (!user || !policy) return false;
  if (user.group_name === "SuperAdmin") return true;

  // Identity-centric: user-owned policy matches only that user.
  const policyUserId = Number(policy.user_id);
  if (Number.isFinite(policyUserId) && policyUserId > 0) {
    const actorId = Number(user.id || user.user_id);
    return Number.isFinite(actorId) && actorId === policyUserId;
  }

  if (Number.isFinite(Number(policy.role_id)) && Number(policy.role_id) > 0 && Number(policy.role_id) !== Number(user.primary_role_id)) {
    return false;
  }
  if (Number.isFinite(Number(policy.group_id)) && Number(policy.group_id) > 0 && Number(policy.group_id) !== Number(user.group_id)) {
    return false;
  }
  return true;
}

function formatPolicyScope(policy) {
  if (!policy) return "Open approver";
  if (Number.isFinite(Number(policy.user_id)) && Number(policy.user_id) > 0) {
    return policy.user_full_name || policy.user_name || `User #${policy.user_id}`;
  }
  const parts = [];
  if (policy.group_name) parts.push(policy.group_name);
  if (policy.role_name) parts.push(policy.role_name);
  return parts.length ? parts.join(" / ") : "Open approver";
}

async function getPolicyBootstrap(client) {
  const [rolesRes, groupsRes, vendorsRes] = await Promise.all([
    client.query(
      `
        select id, role_key, role_name
        from roles
        where is_active = true
        order by role_name asc
      `
    ),
    client.query(
      `
        select id, group_name
        from user_groups
        where is_active = true
        order by group_name asc
      `
    ),
    client.query(
      `
        select id, company_name
        from vendors
        where is_active = true
        order by company_name asc
      `
    ),
  ]);

  return {
    roles: rolesRes.rows,
    groups: groupsRes.rows,
    vendors: vendorsRes.rows,
    doc_types: getDocTypeOptions(),
  };
}

async function listApprovalPolicies(client, companyId) {
  if (!Number.isFinite(Number(companyId)) || Number(companyId) <= 0) return [];
  const res = await client.query(
    `
      select
        p.*,
        r.role_name,
        ug.group_name,
        v.company_name as vendor_name,
        cu.full_name as created_by_name,
        uu.full_name as user_full_name
      from approval_policies p
      left join roles r on r.id = p.role_id
      left join user_groups ug on ug.id = p.group_id
      left join vendors v on v.id = p.vendor_id
      left join erp_users cu on cu.id = p.created_by
      left join erp_users uu on uu.id = p.user_id
      where p.company_id = $1
      order by
        p.doc_type asc,
        p.level_no asc,
        case when p.user_id is not null then 0 else 1 end,
        p.min_amount asc,
        p.id asc
    `,
    [Number(companyId)]
  );
  return res.rows;
}

async function getDocumentSnapshot(client, docType, docId, companyId) {
  const config = getDocConfig(docType);
  if (!config) return null;
  const noLevels = config.hasApprovalLevels === false;
  const levelSelect = noLevels
    ? `0 as current_approval_level, 1 as required_approval_level`
    : `d.current_approval_level, d.required_approval_level`;
  const res = await client.query(
    `
      select
        d.${config.idColumn} as id,
        d.${config.numberColumn} as doc_number,
        d.${config.statusColumn} as doc_status,
        d.${config.dateColumn} as doc_date,
        d.${config.vendorColumn} as vendor_id,
        ${config.totalColumn} as total_amount,
        d.company_id as company_id,
        ${levelSelect}
      from ${config.table} d
      where d.${config.idColumn} = $1 and d.company_id = $2
      limit 1
    `,
    [docId, Number(companyId)]
  );
  return res.rows[0] || null;
}

async function getMatchingPoliciesForSnapshot(client, companyId, docType, snapshot) {
  const normalizedDocType = String(docType || "").trim();
  if (!getDocConfig(normalizedDocType)) return { policies: [], allByLevel: new Map() };
  const vendorId = Number.isFinite(Number(snapshot?.vendor_id)) && Number(snapshot.vendor_id) > 0 ? Number(snapshot.vendor_id) : null;
  const totalAmount = money(snapshot?.total_amount);

  const res = await client.query(
    `
      select
        p.*,
        r.role_name,
        ug.group_name,
        v.company_name as vendor_name,
        uu.full_name as user_full_name
      from approval_policies p
      left join roles r on r.id = p.role_id
      left join user_groups ug on ug.id = p.group_id
      left join vendors v on v.id = p.vendor_id
      left join erp_users uu on uu.id = p.user_id
      where p.is_active = true
        and p.company_id = $1
        and p.doc_type = $2
        and ($3::integer is null or p.vendor_id is null or p.vendor_id = $3)
        and p.min_amount <= $4
        and (p.max_amount is null or p.max_amount >= $4)
      order by
        p.level_no asc,
        case when p.user_id is not null then 1 else 0 end desc,
        case when p.vendor_id is not null then 1 else 0 end desc,
        case when p.group_id is not null then 1 else 0 end desc,
        case when p.role_id is not null then 1 else 0 end desc,
        p.id asc
    `,
    [Number(companyId), normalizedDocType, vendorId, totalAmount]
  );

  // Representative policy per level (user → vendor → group → role) for chain length.
  // allByLevel keeps every candidate so any matching identity/role/group approver can act.
  const byLevel = new Map();
  const allByLevel = new Map();
  for (const row of res.rows) {
    const levelNo = Number(row.level_no);
    if (!Number.isFinite(levelNo) || levelNo <= 0) continue;
    if (!allByLevel.has(levelNo)) allByLevel.set(levelNo, []);
    allByLevel.get(levelNo).push(row);
    if (!byLevel.has(levelNo)) byLevel.set(levelNo, row);
  }

  const policies = Array.from(byLevel.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row);

  return { policies, allByLevel };
}

async function resolveApprovalState(client, docType, snapshot, companyId) {
  const normalizedSnapshot = {
    id: Number(snapshot?.id || snapshot?.doc_id || 0) || 0,
    vendor_id: Number.isFinite(Number(snapshot?.vendor_id)) ? Number(snapshot.vendor_id) : null,
    company_id: Number.isFinite(Number(snapshot?.company_id)) ? Number(snapshot.company_id) : Number(companyId || 0) || null,
    total_amount: money(snapshot?.total_amount),
    current_approval_level: Math.max(0, Number(snapshot?.current_approval_level || 0)),
    required_approval_level: Math.max(0, Number(snapshot?.required_approval_level || 0)),
    doc_status: typeof snapshot?.doc_status === "string" ? snapshot.doc_status : "",
    doc_number: typeof snapshot?.doc_number === "string" ? snapshot.doc_number : "",
    doc_date: snapshot?.doc_date || null,
  };

  const matched = await getMatchingPoliciesForSnapshot(client, normalizedSnapshot.company_id, docType, normalizedSnapshot);
  const policies = Array.isArray(matched?.policies) ? matched.policies : [];
  const allByLevel = matched?.allByLevel instanceof Map ? matched.allByLevel : new Map();
  const requiredLevel = policies.length;
  const currentLevel = Math.min(normalizedSnapshot.current_approval_level, requiredLevel);
  const nextLevel = currentLevel + 1;
  const nextPolicy = policies.find((row) => Number(row.level_no) === nextLevel) || null;
  const policiesAtNextLevel = allByLevel.get(nextLevel) || (nextPolicy ? [nextPolicy] : []);

  return {
    snapshot: normalizedSnapshot,
    policies,
    policiesAtNextLevel,
    requiredLevel,
    currentLevel,
    nextLevel,
    nextPolicy,
  };
}

function evaluateApprovalPermission({ user, state, fallbackCanApprove = false }) {
  if (!state) {
    return {
      allowed: false,
      requiresPolicy: false,
      finalApproval: false,
      nextLevel: 0,
      nextPolicy: null,
      requiredLevel: 0,
    };
  }

  if (user?.group_name === "SuperAdmin") {
    return {
      allowed: true,
      requiresPolicy: state.requiredLevel > 0,
      finalApproval: true,
      nextLevel: state.requiredLevel > 0 ? Math.max(1, state.nextLevel) : 0,
      nextPolicy: state.nextPolicy,
      requiredLevel: state.requiredLevel,
    };
  }

  if (state.requiredLevel <= 0) {
    return {
      allowed: Boolean(fallbackCanApprove),
      requiresPolicy: false,
      finalApproval: true,
      nextLevel: 0,
      nextPolicy: null,
      requiredLevel: 0,
    };
  }

  const candidates =
    Array.isArray(state.policiesAtNextLevel) && state.policiesAtNextLevel.length
      ? state.policiesAtNextLevel
      : state.nextPolicy
        ? [state.nextPolicy]
        : [];
  const allowed = candidates.some((policy) => userMatchesPolicy(user, policy));
  return {
    allowed,
    requiresPolicy: true,
    finalApproval: state.nextLevel >= state.requiredLevel,
    nextLevel: state.nextLevel,
    nextPolicy: state.nextPolicy,
    requiredLevel: state.requiredLevel,
  };
}

async function insertApprovalHistory(client, { docType, docId, action, actionLevel = 0, policyId = null, remarks = null, actedBy = null }) {
  if (!client) return;
  await client.query(
    `
      insert into approval_action_history (
        doc_type,
        doc_id,
        action,
        action_level,
        policy_id,
        remarks,
        acted_by
      )
      values ($1,$2,$3,$4,$5,$6,$7)
    `,
    [
      docType,
      Number(docId),
      action,
      Math.max(0, Number(actionLevel || 0)),
      Number.isFinite(Number(policyId)) && Number(policyId) > 0 ? Number(policyId) : null,
      remarks || null,
      Number.isFinite(Number(actedBy)) && Number(actedBy) > 0 ? Number(actedBy) : null,
    ]
  );
}

module.exports = {
  DOC_CONFIG,
  docTypeLabel,
  evaluateApprovalPermission,
  formatPolicyScope,
  getDocConfig,
  getDocTypeOptions,
  getDocumentSnapshot,
  getPolicyBootstrap,
  insertApprovalHistory,
  listApprovalPolicies,
  resolveApprovalState,
  userMatchesPolicy,
};
