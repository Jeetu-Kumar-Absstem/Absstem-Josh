import { useEffect, useMemo, useState } from "react";
import OrgChart from "./OrgChart";
import UserGovernanceDrawer from "./UserGovernanceDrawer";
import AddPerson from "./AddPerson";
import { applyRoleProfileToForm, formatRoleProfileSummary, groupRolesForSelect, resolveRoleProfile } from "./roleProfile";
import TypedConfirmModal from "../components/TypedConfirmModal";

async function apiFetch(path, options) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error("Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function formatWorkspaceFamilyLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Fallback";
  return text
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function SurfaceCard({ title, subtitle, actions, children }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 22,
        padding: 18,
        background: "#fff",
        boxShadow: "0 16px 38px rgba(25, 37, 61, 0.07)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 13, opacity: 0.74, lineHeight: 1.6, marginTop: 6 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, note, accent }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 18,
        padding: 14,
        background: "#fff",
        boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
        borderTop: `4px solid ${accent}`,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>{note}</div>
    </div>
  );
}

function HeaderChip({ label, tone = "#5f6f86", background = "rgba(0, 80, 158, 0.08)" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        padding: "4px 10px",
        borderRadius: 999,
        background,
        color: tone,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function ViewButton({ active, label, note, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: "14px 16px",
        border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
        background: active ? "linear-gradient(180deg, #eef4ff 0%, #f8fbff 100%)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14 }}>{label}</strong>
      <span style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function approvalBreakdownEntries(breakdown) {
  const source = breakdown && typeof breakdown === "object" ? breakdown : {};
  return [
    ["Draft Quote Prep", source.quote_draft_prepared_by || 0],
    ["Pending Quote Approvals", source.quote_pending_approvals || 0],
    ["PRQ Submitters", source.purchase_requisition_submitted_by || 0],
    ["PO Submitters", source.purchase_order_submitted_by || 0],
    ["GRN Submitters", source.goods_receipt_submitted_by || 0],
    ["PI Submitters", source.purchase_invoice_submitted_by || 0],
    ["VP Submitters", source.vendor_payment_submitted_by || 0],
    ["PRQ Approvers", source.purchase_requisition_approved_by || 0],
    ["PO Approvers", source.purchase_order_approved_by || 0],
    ["GRN Approvers", source.goods_receipt_approved_by || 0],
    ["PI Approvers", source.purchase_invoice_approved_by || 0],
    ["VP Approvers", source.vendor_payment_approved_by || 0],
  ];
}

const auditDepartmentGroups = [
  {
    title: "Sales / Marketing",
    items: [
      { key: "leads_transferred", label: "Leads" },
      { key: "quotes_transferred", label: "Quotes" },
      { key: "sales_orders_transferred", label: "Sales Orders" },
      { key: "dispatches_transferred", label: "Dispatches" },
      { key: "customer_invoices_transferred", label: "Invoices" },
      { key: "customer_receipts_transferred", label: "Customer Receipts" },
    ],
  },
  {
    title: "Purchase / Accounts",
    items: [
      { key: "purchase_requisitions_transferred", label: "Requisitions" },
      { key: "purchase_orders_transferred", label: "Purchase Orders" },
      { key: "purchase_invoices_transferred", label: "Purchase Invoices" },
      { key: "goods_receipts_transferred", label: "GRN" },
      { key: "vendor_payments_transferred", label: "Vendor Payments" },
      { key: "finance_entries_transferred", label: "Bank Book" },
    ],
  },
  {
    title: "Factory / Stores",
    items: [
      { key: "job_cards_transferred", label: "Job Cards" },
      { key: "quality_controls_transferred", label: "QC" },
      { key: "stock_adjustments_transferred", label: "Stock Adjustments" },
      { key: "stock_transfers_transferred", label: "Stock Transfers" },
      { key: "purchase_returns_transferred", label: "Purchase Returns" },
      { key: "sales_returns_transferred", label: "Sales Returns" },
    ],
  },
  {
    title: "Service / AMC",
    items: [
      { key: "service_cases_transferred", label: "Service Cases" },
      { key: "amc_contracts_transferred", label: "AMC Contracts" },
      { key: "supplier_claims_transferred", label: "Claims" },
      { key: "supplier_claim_receipts_transferred", label: "Claim Receipts" },
    ],
  },
];

function emptyForm() {
  return {
    id: null,
    user_code: "System Generated",
    full_name: "",
    email: "",
    phone: "",
    designation: "",
    group_id: "",
    role_id: "",
    company_name: "",
    distributor_id: "",
    employee_code: "",
    department_key: "",
    employment_company_id: "",
    company_ids: [],
    primary_company_id: "",
    primary_manager_user_id: "",
    secondary_manager_user_id: "",
    date_of_joining: "",
    local_address: "",
    permanent_address: "",
    discount_threshold_pct: "",
    is_active: true,
    is_approved: true,
    password: "",
  };
}

function normalizeUserToForm(user) {
  return {
    id: user?.id ?? null,
    user_code: user?.user_code || "System Generated",
    full_name: user?.full_name || "",
    email: user?.email || "",
    phone: user?.phone || "",
    designation: user?.designation || "",
    group_id: user?.group_id ? String(user.group_id) : "",
    role_id: user?.role_id ? String(user.role_id) : "",
    company_name: user?.company_name || "",
    distributor_id: user?.distributor_id ? String(user.distributor_id) : "",
    employee_code: user?.employee_code || "",
    department_key: user?.department_key || "",
    employment_company_id: user?.employment_company_id ? String(user.employment_company_id) : "",
    company_ids: [],
    primary_company_id: "",
    primary_manager_user_id: user?.primary_manager_user_id ? String(user.primary_manager_user_id) : "",
    secondary_manager_user_id: user?.secondary_manager_user_id ? String(user.secondary_manager_user_id) : "",
    date_of_joining: user?.date_of_joining ? String(user.date_of_joining).slice(0, 10) : "",
    local_address: user?.local_address || "",
    permanent_address: user?.permanent_address || "",
    discount_threshold_pct:
      user?.discount_threshold_override === null || user?.discount_threshold_override === undefined
        ? ""
        : String(user.discount_threshold_override),
    is_active: user?.is_active !== false,
    is_approved: user?.is_approved !== false,
    password: "",
  };
}

export default function UserMaster({ launch, onConsumeLaunch, onNavigate = null }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("orgchart");
  const [accessMode, setAccessMode] = useState("off");
  const accessV2 = accessMode !== "off";
  const [pendingLaunchUserId, setPendingLaunchUserId] = useState(null);
  const [pendingGovernanceTab, setPendingGovernanceTab] = useState("identity");
  const [governanceInitialTab, setGovernanceInitialTab] = useState("identity");
  const [offboardingAuditsReady, setOffboardingAuditsReady] = useState(true);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("");
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [roles, setRoles] = useState([]);
  const [distributors, setDistributors] = useState([]);
  const [managers, setManagers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [governanceUserId, setGovernanceUserId] = useState(null);
  const [includeInactiveInChart, setIncludeInactiveInChart] = useState(false);
  const [showLonelyRoots, setShowLonelyRoots] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [transferFromId, setTransferFromId] = useState("");
  const [transferToId, setTransferToId] = useState("");
  const [transferIncludeClosed, setTransferIncludeClosed] = useState(false);
  const [transferLeads, setTransferLeads] = useState(true);
  const [transferQuotes, setTransferQuotes] = useState(true);
  const [transferSalesOrders, setTransferSalesOrders] = useState(true);
  const [transferJobCards, setTransferJobCards] = useState(true);
  const [transferPurchaseRequisitions, setTransferPurchaseRequisitions] = useState(true);
  const [transferDispatches, setTransferDispatches] = useState(true);
  const [transferCustomerInvoices, setTransferCustomerInvoices] = useState(true);
  const [transferGoodsReceipts, setTransferGoodsReceipts] = useState(true);
  const [transferQualityControls, setTransferQualityControls] = useState(true);
  const [transferSupplierClaims, setTransferSupplierClaims] = useState(true);
  const [transferPurchaseReturns, setTransferPurchaseReturns] = useState(true);
  const [transferSalesReturns, setTransferSalesReturns] = useState(true);
  const [transferPurchaseOrders, setTransferPurchaseOrders] = useState(true);
  const [transferPurchaseInvoices, setTransferPurchaseInvoices] = useState(true);
  const [transferVendorPayments, setTransferVendorPayments] = useState(true);
  const [transferCustomerReceipts, setTransferCustomerReceipts] = useState(true);
  const [transferFinanceEntries, setTransferFinanceEntries] = useState(true);
  const [transferStockAdjustments, setTransferStockAdjustments] = useState(true);
  const [transferStockTransfers, setTransferStockTransfers] = useState(true);
  const [transferServiceCases, setTransferServiceCases] = useState(true);
  const [transferAmcContracts, setTransferAmcContracts] = useState(true);
  const [transferApprovalChains, setTransferApprovalChains] = useState(false);
  const [transferResult, setTransferResult] = useState(null);
  const [offboardBusy, setOffboardBusy] = useState(false);
  const [offboardConfirmOpen, setOffboardConfirmOpen] = useState(false);
  const [offboardPreviewBusy, setOffboardPreviewBusy] = useState(false);
  const [offboardPreview, setOffboardPreview] = useState(null);
  const [offboardResult, setOffboardResult] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditQuery, setAuditQuery] = useState("");
  const [auditDateFrom, setAuditDateFrom] = useState("");
  const [auditDateTo, setAuditDateTo] = useState("");
  const [auditQuickFilter, setAuditQuickFilter] = useState("all");
  const [auditRows, setAuditRows] = useState([]);
  const [offboarding, setOffboarding] = useState({
    fromUserId: "",
    toUserId: "",
    includeClosed: false,
    reassignReportees: true,
    transferLeads: true,
    transferQuotes: true,
    transferSalesOrders: true,
    transferJobCards: true,
    transferPurchaseRequisitions: true,
    transferDispatches: true,
    transferCustomerInvoices: true,
    transferGoodsReceipts: true,
    transferQualityControls: true,
    transferSupplierClaims: true,
    transferPurchaseReturns: true,
    transferSalesReturns: true,
    transferPurchaseOrders: true,
    transferPurchaseInvoices: true,
    transferVendorPayments: true,
    transferCustomerReceipts: true,
    transferFinanceEntries: true,
    transferStockAdjustments: true,
    transferStockTransfers: true,
    transferServiceCases: true,
    transferAmcContracts: true,
    transferApprovalChains: false,
  });

  async function loadBootstrap() {
    const data = await apiFetch("/users/bootstrap");
    setGroups(Array.isArray(data?.user_groups) ? data.user_groups : []);
    setRoles(Array.isArray(data?.roles) ? data.roles : []);
    setDistributors(Array.isArray(data?.distributors) ? data.distributors : []);
    setManagers(Array.isArray(data?.managers) ? data.managers : []);
    setDepartments(Array.isArray(data?.departments) ? data.departments : []);
    setCompanies(Array.isArray(data?.companies) ? data.companies : []);
    setDesignations(Array.isArray(data?.designations) ? data.designations : []);
    setOffboardingAuditsReady(data?.offboarding_audits_ready !== false);
  }

  async function loadUsers() {
    const data = await apiFetch("/users");
    setUsers(Array.isArray(data?.users) ? data.users : []);
  }

  async function loadOffboardingAudits(nextQuery = auditQuery, nextDateFrom = auditDateFrom, nextDateTo = auditDateTo) {
    setAuditLoading(true);
    try {
      if (!offboardingAuditsReady) {
        setAuditRows([]);
        return;
      }
      const q = String(nextQuery || "").trim();
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (nextDateFrom) params.set("date_from", nextDateFrom);
      if (nextDateTo) params.set("date_to", nextDateTo);
      const data = await apiFetch(`/users/admin/offboarding-audits${params.toString() ? `?${params.toString()}` : ""}`);
      setAuditRows(Array.isArray(data?.audits) ? data.audits : []);
    } finally {
      setAuditLoading(false);
    }
  }

  async function refreshAll() {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadBootstrap(), loadUsers(), loadOffboardingAudits()]);
    } catch (e) {
      setError(e?.data?.error || "Failed to load User Master.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll().catch(() => {});
    apiFetch("/permissions/access/status")
      .then((s) => setAccessMode(s?.tables_ready && s?.mode && s.mode !== "off" ? s.mode : "off"))
      .catch(() => setAccessMode("off"));
  }, []);

  const selectedGroup = useMemo(() => groups.find((g) => String(g.id) === String(form.group_id)) || null, [groups, form.group_id]);
  const isDistributorUser = selectedGroup?.group_name === "Distributor";
  const managerOptions = useMemo(() => managers.filter((u) => String(u.id) !== String(form.id)), [managers, form.id]);
  const selectedUser = useMemo(() => users.find((u) => String(u.id) === String(form.id)) || null, [users, form.id]);
  const activeUsers = useMemo(() => users.filter((u) => u.is_active), [users]);
  const selectedOffboardFromUser = useMemo(() => users.find((u) => String(u.id) === String(offboarding.fromUserId)) || null, [users, offboarding.fromUserId]);
  const selectedOffboardToUser = useMemo(() => users.find((u) => String(u.id) === String(offboarding.toUserId)) || null, [users, offboarding.toUserId]);
  const selectedCompanyFilter = useMemo(() => companies.find((item) => String(item.id) === String(companyFilter)) || null, [companies, companyFilter]);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (groupFilter && String(u.group_id) !== String(groupFilter)) return false;
      if (statusFilter === "active" && !u.is_active) return false;
      if (statusFilter === "inactive" && u.is_active) return false;
      if (selectedCompanyFilter) {
        const companyLabel = String(u.company_name || "").trim().toLowerCase();
        const targetName = String(selectedCompanyFilter.company_name || "").trim().toLowerCase();
        const targetCode = String(selectedCompanyFilter.company_code || "").trim().toLowerCase();
        if (companyLabel !== targetName && (!targetCode || !companyLabel.includes(targetCode))) return false;
      }
      if (!q) return true;
      return [u.user_code, u.full_name, u.email, u.group_name, u.role_name, u.company_name, u.distributor_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [users, query, groupFilter, statusFilter, selectedCompanyFilter]);

  useEffect(() => {
    if (!launch) return;
    setView(launch.view || "orgchart");
    if (launch.companyId) {
      setCompanyFilter(String(launch.companyId));
    }
    if (launch.query) {
      setQuery(String(launch.query));
    }
    if (launch.statusFilter) {
      setStatusFilter(String(launch.statusFilter));
    }
    if (launch.userId) {
      setPendingLaunchUserId(Number(launch.userId));
      setPendingGovernanceTab(launch.governanceTab || "identity");
    }
    if (launch.governanceTab && !launch.userId) {
      setGovernanceInitialTab(String(launch.governanceTab));
    }
    onConsumeLaunch?.();
  }, [launch, onConsumeLaunch]);

  useEffect(() => {
    if (!pendingLaunchUserId) return;
    if (loading) return;
    const match = users.find((item) => Number(item.id) === Number(pendingLaunchUserId));
    setGovernanceInitialTab(pendingGovernanceTab || "identity");
    setView("orgchart");
    if (match) {
      editUser(match).catch(() => {});
    } else {
      openGovernance({ id: pendingLaunchUserId });
    }
    setPendingLaunchUserId(null);
  }, [pendingLaunchUserId, users, loading, pendingGovernanceTab]);

  const stats = useMemo(() => {
    const activeCount = users.filter((item) => item.is_active).length;
    const distributorCount = users.filter((item) => item.group_name === "Distributor").length;
    const connectedMailCount = users.filter((item) => item.mail_connected).length;
    return [
      { label: "Users", value: users.length, note: "full directory", accent: "#1f5eff" },
      { label: "Active", value: activeCount, note: "currently enabled", accent: "#14804a" },
      { label: "Distributor users", value: distributorCount, note: "channel-linked accounts", accent: "#d97706" },
      { label: "Mail connected", value: connectedMailCount, note: "mailbox visibility live", accent: "#8b5cf6" },
    ];
  }, [users]);
  const missingPeopleSetup = [
    !roles.length ? "roles" : null,
    !groups.length ? "user groups" : null,
    !departments.length ? "departments" : null,
    !designations.length ? "designations" : null,
    offboardingAuditsReady === false ? "offboarding audits" : null,
  ].filter(Boolean);
  const headerChips = [
    missingPeopleSetup.length
      ? { label: `${missingPeopleSetup.length} setup gaps`, tone: "#b45309", background: "rgba(217, 119, 6, 0.12)" }
      : { label: "People setup baseline ready", tone: "#14804a", background: "rgba(20, 128, 74, 0.1)" },
    companyFilter && selectedCompanyFilter
      ? { label: `Company filter: ${selectedCompanyFilter.company_code || selectedCompanyFilter.company_name}`, tone: "#1f5eff", background: "rgba(31, 94, 255, 0.1)" }
      : null,
    view === "offboarding"
      ? { label: offboardingAuditsReady ? "Offboarding flow ready" : "Audit migration required", tone: offboardingAuditsReady ? "#14804a" : "#e30513", background: offboardingAuditsReady ? "rgba(20, 128, 74, 0.1)" : "rgba(227, 5, 19, 0.1)" }
      : null,
  ].filter(Boolean);
  const inactiveCount = users.filter((item) => !item.is_active).length;
  const usersWithoutManagerCount = users.filter((item) => item.is_active && !item.primary_manager_user_id).length;
  const userFocusActions = [
    {
      label: "Org chart governance",
      note: "Click a person on the chart to manage identity, screen access, and approval ceilings.",
      onClick: () => setView("orgchart"),
      tone: "#1f5eff",
    },
    {
      label: "Directory operations",
      note: "Search people fast, correct records, and jump directly into editor context.",
      onClick: () => setView("directory"),
      tone: "#334155",
    },
    {
      label: "Ownership transfer",
      note: "Use this before deactivation when open work must move safely to a live owner.",
      onClick: () => setView("transfer"),
      tone: "#14804a",
    },
    {
      label: "Guided offboarding",
      note: offboardingAuditsReady
        ? "Run the full offboarding flow with transfer, reporting-line cleanup, and audit capture."
        : "Audit migration is still missing, so offboarding evidence is incomplete.",
      onClick: () => setView("offboarding"),
      tone: offboardingAuditsReady ? "#8b5cf6" : "#b45309",
    },
  ];
  const governanceAlerts = [
    missingPeopleSetup.length ? `${missingPeopleSetup.length} setup foundations still missing` : "Core user setup baseline is ready",
    inactiveCount ? `${inactiveCount} inactive users remain in the directory for review` : "No inactive-user cleanup pressure",
    usersWithoutManagerCount ? `${usersWithoutManagerCount} active users have no manager mapped` : "Reporting hierarchy coverage looks healthy",
  ];

  function openGovernance(user, tab = null) {
    if (tab) setGovernanceInitialTab(tab);
    setGovernanceUserId(user?.id ? Number(user.id) : null);
    setGovernanceOpen(true);
    setNotice("");
    setError("");
  }

  function startNew() {
    if (accessV2) {
      setView("add");
      setNotice("");
      setError("");
      return;
    }
    setForm(emptyForm());
    setGovernanceUserId(null);
    setGovernanceOpen(true);
    setNotice("");
    setError("");
  }

  async function editUser(user) {
    if (!user?.id) {
      setForm(normalizeUserToForm(user));
      setView("editor");
      setNotice("");
      setError("");
      return;
    }
    openGovernance(user);
    setDetailLoading(true);
    setNotice("");
    setError("");
    try {
      const data = await apiFetch(`/users/detail/${user.id}`);
      const saved = data?.user || user;
      const memberships = Array.isArray(data?.memberships) ? data.memberships : [];
      const companyIds = memberships.filter((m) => m.is_active !== false).map((m) => String(m.company_id));
      const primary = memberships.find((m) => m.is_primary) || null;
      const base = normalizeUserToForm(saved);
      setForm({
        ...base,
        company_ids: companyIds,
        primary_company_id: primary?.company_id ? String(primary.company_id) : base.employment_company_id || "",
        employment_company_id: base.employment_company_id || (primary?.company_id ? String(primary.company_id) : ""),
      });
    } catch (e) {
      setForm(normalizeUserToForm(user));
      setError(e?.data?.error || "Failed to load user details.");
    } finally {
      setDetailLoading(false);
    }
  }

  function openAuditUser(userId) {
    const user = users.find((item) => String(item.id) === String(userId));
    if (user) {
      editUser(user);
      return;
    }
    setError("User record is not available in the current directory list.");
  }

  function buildAuditExportPayload(row) {
    return {
      id: row?.id ?? null,
      created_at: row?.created_at ?? null,
      include_closed: row?.include_closed ?? null,
      reassign_reportees: row?.reassign_reportees ?? null,
      offboarded_user: {
        id: row?.offboarded_user_id ?? null,
        name: row?.offboarded_user_name ?? null,
        email: row?.offboarded_user_email ?? null,
      },
      replacement_user: {
        id: row?.replacement_user_id ?? null,
        name: row?.replacement_user_name ?? null,
        email: row?.replacement_user_email ?? null,
      },
      performed_by: {
        id: row?.performed_by ?? null,
        name: row?.performed_by_name ?? null,
        email: row?.performed_by_email ?? null,
      },
      scopes: row?.scopes ?? {},
      before_counts: row?.before_counts ?? {},
      after_counts: row?.after_counts ?? {},
      moved_counts: row?.moved_counts ?? {},
    };
  }

  async function copyTextToClipboard(text) {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }

  function downloadJsonFile(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function formatAuditKey(key) {
    return String(key || "")
      .replace(/_transferred$/i, "")
      .replace(/_moved$/i, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function getAuditMovementChips(row) {
    const moved = row && typeof row.moved_counts === "object" && row.moved_counts ? row.moved_counts : {};
    return Object.entries(moved)
      .filter(([, value]) => Number(value || 0) > 0)
      .map(([key, value]) => ({ key, label: formatAuditKey(key), value: Number(value || 0) }));
  }

  function getAuditApprovalBreakdown(row) {
    const moved = row && typeof row.moved_counts === "object" && row.moved_counts ? row.moved_counts : {};
    if (moved.approval_chain_breakdown && typeof moved.approval_chain_breakdown === "object") {
      return moved.approval_chain_breakdown;
    }
    const beforeCounts = row && typeof row.before_counts === "object" && row.before_counts ? row.before_counts : {};
    const afterCounts = row && typeof row.after_counts === "object" && row.after_counts ? row.after_counts : {};
    const beforeBreakdown = beforeCounts.approval_chain_breakdown && typeof beforeCounts.approval_chain_breakdown === "object" ? beforeCounts.approval_chain_breakdown : {};
    const afterBreakdown = afterCounts.approval_chain_breakdown && typeof afterCounts.approval_chain_breakdown === "object" ? afterCounts.approval_chain_breakdown : {};
    return Object.keys(beforeBreakdown).reduce((acc, key) => {
      acc[key] = Math.max(Number(beforeBreakdown[key] || 0) - Number(afterBreakdown[key] || 0), 0);
      return acc;
    }, {});
  }

  function getAuditApprovalCount(row) {
    const moved = row && typeof row.moved_counts === "object" && row.moved_counts ? row.moved_counts : {};
    const approvalBreakdown = getAuditApprovalBreakdown(row);
    const breakdownTotal = approvalBreakdownEntries(approvalBreakdown).reduce((sum, [, value]) => sum + Number(value || 0), 0);
    return Math.max(Number(moved.approval_chains_transferred || 0), breakdownTotal);
  }

  function getAuditDepartmentTotalsForRow(row) {
    const moved = row && typeof row.moved_counts === "object" && row.moved_counts ? row.moved_counts : {};
    return auditDepartmentGroups.reduce((acc, group) => {
      acc[group.title] = group.items.reduce((sum, item) => sum + Number(moved[item.key] || 0), 0);
      return acc;
    }, {});
  }

  const auditQuickFilters = useMemo(
    () => [
      { key: "all", label: "All" },
      { key: "approval", label: "Approval Handoffs" },
      { key: "reportees", label: "Reportees Rehomed" },
      { key: "sales", label: "Sales-heavy" },
      { key: "factory", label: "Factory-heavy" },
      { key: "no_moves", label: "No moved counts" },
    ],
    []
  );

  const auditRowsQuickFiltered = useMemo(() => {
    if (auditQuickFilter === "all") return auditRows;
    return auditRows.filter((row) => {
      const moved = row && typeof row.moved_counts === "object" && row.moved_counts ? row.moved_counts : {};
      const approvalCount = getAuditApprovalCount(row);
      const reporteesMoved = Number(moved.reportees_moved || 0);
      if (auditQuickFilter === "approval") return approvalCount > 0;
      if (auditQuickFilter === "reportees") return reporteesMoved > 0;
      if (auditQuickFilter === "sales") {
        const totals = getAuditDepartmentTotalsForRow(row);
        return Number(totals["Sales / Marketing"] || 0) > 0;
      }
      if (auditQuickFilter === "factory") {
        const totals = getAuditDepartmentTotalsForRow(row);
        return Number(totals["Factory / Stores"] || 0) > 0;
      }
      if (auditQuickFilter === "no_moves") {
        const chips = getAuditMovementChips(row);
        return chips.length === 0 && approvalCount === 0 && reporteesMoved === 0;
      }
      return true;
    });
  }, [auditRows, auditQuickFilter]);

  function getAuditSummary(rows) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const offboardedUsers = new Set();
    const replacementUsers = new Set();
    const topModules = new Map();
    const departmentTotals = auditDepartmentGroups.map((group) => ({ title: group.title, total: 0 }));
    let totalMovedItems = 0;
    let totalReporteesMoved = 0;
    let totalApprovalChainsMoved = 0;

    safeRows.forEach((row) => {
      if (row?.offboarded_user_id) offboardedUsers.add(String(row.offboarded_user_id));
      if (row?.replacement_user_id) replacementUsers.add(String(row.replacement_user_id));

      const moved = row && typeof row.moved_counts === "object" && row.moved_counts ? row.moved_counts : {};
      const approvalCount = getAuditApprovalCount(row);
      totalApprovalChainsMoved += approvalCount;
      totalReporteesMoved += Number(moved.reportees_moved || 0);

      auditDepartmentGroups.forEach((group, groupIndex) => {
        group.items.forEach((item) => {
          const value = Number(moved[item.key] || 0);
          departmentTotals[groupIndex].total += value;
          if (value > 0) {
            totalMovedItems += value;
            topModules.set(item.label, (topModules.get(item.label) || 0) + value);
          }
        });
      });
    });

    return {
      auditCount: safeRows.length,
      offboardedUsers: offboardedUsers.size,
      replacementUsers: replacementUsers.size,
      totalMovedItems,
      totalReporteesMoved,
      totalApprovalChainsMoved,
      departmentTotals,
      topModules: Array.from(topModules.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8),
    };
  }

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setRoleProfile(roleIdValue) {
    const role = roles.find((r) => String(r.id) === String(roleIdValue)) || null;
    if (!role) {
      setForm((prev) => ({ ...prev, role_id: "", group_id: "", department_key: "" }));
      return;
    }
    setForm((prev) => applyRoleProfileToForm(prev, role, groups, departments));
  }

  function setOffboardingField(key, value) {
    setOffboarding((prev) => ({ ...prev, [key]: value }));
    setOffboardPreview(null);
    setOffboardResult(null);
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const role = roles.find((r) => String(r.id) === String(form.role_id)) || null;
      const aligned = role ? applyRoleProfileToForm(form, role, groups, departments) : form;
      const payload = {
        full_name: aligned.full_name,
        email: aligned.email,
        phone: aligned.phone,
        designation: aligned.designation,
        group_id: aligned.group_id ? Number(aligned.group_id) : null,
        role_id: aligned.role_id ? Number(aligned.role_id) : null,
        company_name: aligned.company_name,
        distributor_id: isDistributorUser && aligned.distributor_id ? Number(aligned.distributor_id) : null,
        employee_code: aligned.employee_code,
        department_key: aligned.department_key || null,
        employment_company_id: aligned.employment_company_id ? Number(aligned.employment_company_id) : null,
        company_ids: Array.isArray(aligned.company_ids) ? aligned.company_ids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0) : [],
        primary_company_id: aligned.primary_company_id ? Number(aligned.primary_company_id) : null,
        primary_manager_user_id: aligned.primary_manager_user_id ? Number(aligned.primary_manager_user_id) : null,
        secondary_manager_user_id: aligned.secondary_manager_user_id ? Number(aligned.secondary_manager_user_id) : null,
        date_of_joining: aligned.date_of_joining || null,
        local_address: aligned.local_address,
        permanent_address: aligned.permanent_address,
        discount_threshold_pct: form.discount_threshold_pct === "" ? null : Number(form.discount_threshold_pct),
        is_active: Boolean(form.is_active),
        is_approved: Boolean(form.is_approved),
        password: form.password,
      };

      const data = form.id ? await apiFetch(`/users/${form.id}`, { method: "PUT", body: JSON.stringify(payload) }) : await apiFetch("/users", { method: "POST", body: JSON.stringify(payload) });
      const saved = data?.user || null;
      const memberships = Array.isArray(data?.memberships) ? data.memberships : [];
      await Promise.all([loadUsers(), loadBootstrap()]);
      if (saved) {
        const companyIds = memberships.filter((m) => m.is_active !== false).map((m) => String(m.company_id));
        const primary = memberships.find((m) => m.is_primary) || null;
        const base = normalizeUserToForm(saved);
        setForm({
          ...base,
          company_ids: companyIds,
          primary_company_id: primary?.company_id ? String(primary.company_id) : base.employment_company_id || "",
        });
      }
      else startNew();
      setNotice(form.id ? "User updated." : "User created.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "DUPLICATE_EMAIL") setError(e?.data?.detail || "This email is already assigned to another user.");
      else if (code === "DUPLICATE_USER") setError("Email or user code already exists.");
      else if (code === "INVALID_MANAGER") setError("A user cannot report to the same user record.");
      else if (code === "MISSING_FIELDS") setError("Full Name, Email, and Role Profile are required.");
      else setError(code || "Failed to save user.");
    } finally {
      setSaving(false);
    }
  }

  async function transferWork() {
    setTransferBusy(true);
    setError("");
    setNotice("");
    setTransferResult(null);
    try {
      const payload = {
        from_user_id: transferFromId ? Number(transferFromId) : null,
        to_user_id: transferToId ? Number(transferToId) : null,
        include_closed: Boolean(transferIncludeClosed),
        transfer_leads: Boolean(transferLeads),
        transfer_quotes: Boolean(transferQuotes),
        transfer_sales_orders: Boolean(transferSalesOrders),
        transfer_job_cards: Boolean(transferJobCards),
        transfer_purchase_requisitions: Boolean(transferPurchaseRequisitions),
        transfer_dispatches: Boolean(transferDispatches),
        transfer_customer_invoices: Boolean(transferCustomerInvoices),
        transfer_goods_receipts: Boolean(transferGoodsReceipts),
        transfer_quality_controls: Boolean(transferQualityControls),
        transfer_supplier_claims: Boolean(transferSupplierClaims),
        transfer_purchase_returns: Boolean(transferPurchaseReturns),
        transfer_sales_returns: Boolean(transferSalesReturns),
        transfer_purchase_orders: Boolean(transferPurchaseOrders),
        transfer_purchase_invoices: Boolean(transferPurchaseInvoices),
        transfer_vendor_payments: Boolean(transferVendorPayments),
        transfer_customer_receipts: Boolean(transferCustomerReceipts),
        transfer_finance_entries: Boolean(transferFinanceEntries),
        transfer_stock_adjustments: Boolean(transferStockAdjustments),
        transfer_stock_transfers: Boolean(transferStockTransfers),
        transfer_service_cases: Boolean(transferServiceCases),
        transfer_amc_contracts: Boolean(transferAmcContracts),
        transfer_approval_chains: Boolean(transferApprovalChains),
      };
      const data = await apiFetch("/users/admin/transfer-work", { method: "POST", body: JSON.stringify(payload) });
      const result = {
        leads: Number(data?.leads_transferred || 0),
        quotes: Number(data?.quotes_transferred || 0),
        salesOrders: Number(data?.sales_orders_transferred || 0),
        jobCards: Number(data?.job_cards_transferred || 0),
        purchaseRequisitions: Number(data?.purchase_requisitions_transferred || 0),
        dispatches: Number(data?.dispatches_transferred || 0),
        customerInvoices: Number(data?.customer_invoices_transferred || 0),
        goodsReceipts: Number(data?.goods_receipts_transferred || 0),
        qualityControls: Number(data?.quality_controls_transferred || 0),
        supplierClaims: Number(data?.supplier_claims_transferred || 0),
        supplierClaimReceipts: Number(data?.supplier_claim_receipts_transferred || 0),
        purchaseReturns: Number(data?.purchase_returns_transferred || 0),
        salesReturns: Number(data?.sales_returns_transferred || 0),
        purchaseOrders: Number(data?.purchase_orders_transferred || 0),
        purchaseInvoices: Number(data?.purchase_invoices_transferred || 0),
        vendorPayments: Number(data?.vendor_payments_transferred || 0),
        customerReceipts: Number(data?.customer_receipts_transferred || 0),
        financeEntries: Number(data?.finance_entries_transferred || 0),
        stockAdjustments: Number(data?.stock_adjustments_transferred || 0),
        stockTransfers: Number(data?.stock_transfers_transferred || 0),
        serviceCases: Number(data?.service_cases_transferred || 0),
        amcContracts: Number(data?.amc_contracts_transferred || 0),
        approvalChains: Number(data?.approval_chains_transferred || 0),
        approvalChainBreakdown: data?.approval_chain_breakdown || null,
      };
      setTransferResult(result);
      const parts = [];
      if (transferLeads) parts.push(`${result.leads} leads`);
      if (transferQuotes) parts.push(`${result.quotes} quotes`);
      if (transferSalesOrders) parts.push(`${result.salesOrders} sales orders`);
      if (transferJobCards) parts.push(`${result.jobCards} job cards`);
      if (transferPurchaseRequisitions) parts.push(`${result.purchaseRequisitions} requisitions`);
      if (transferDispatches) parts.push(`${result.dispatches} dispatches`);
      if (transferCustomerInvoices) parts.push(`${result.customerInvoices} invoices`);
      if (transferGoodsReceipts) parts.push(`${result.goodsReceipts} GRNs`);
      if (transferQualityControls) parts.push(`${result.qualityControls} QC`);
      if (transferSupplierClaims) parts.push(`${result.supplierClaims} claims`);
      if (transferPurchaseReturns) parts.push(`${result.purchaseReturns} purchase returns`);
      if (transferSalesReturns) parts.push(`${result.salesReturns} sales returns`);
      if (transferPurchaseOrders) parts.push(`${result.purchaseOrders} purchase orders`);
      if (transferPurchaseInvoices) parts.push(`${result.purchaseInvoices} purchase invoices`);
      if (transferVendorPayments) parts.push(`${result.vendorPayments} vendor payments`);
      if (transferCustomerReceipts) parts.push(`${result.customerReceipts} customer receipts`);
      if (transferFinanceEntries) parts.push(`${result.financeEntries} finance entries`);
      if (transferStockAdjustments) parts.push(`${result.stockAdjustments} stock adjustments`);
      if (transferStockTransfers) parts.push(`${result.stockTransfers} stock transfers`);
      if (transferServiceCases) parts.push(`${result.serviceCases} service cases`);
      if (transferAmcContracts) parts.push(`${result.amcContracts} AMC contracts`);
      if (transferApprovalChains) parts.push(`${result.approvalChains} approval chains`);
      setNotice(parts.length ? `Transferred ${parts.join(" • ")}.` : "No work scope selected.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "INVALID_TRANSFER") setError("Select different From and To users.");
      else if (code === "USER_NOT_FOUND") setError("User not found.");
      else setError(code || "Failed to transfer work.");
    } finally {
      setTransferBusy(false);
    }
  }

  async function offboardUser() {
    setOffboardBusy(true);
    setError("");
    setNotice("");
    setOffboardResult(null);
    try {
      const payload = {
        from_user_id: offboarding.fromUserId ? Number(offboarding.fromUserId) : null,
        to_user_id: offboarding.toUserId ? Number(offboarding.toUserId) : null,
        include_closed: Boolean(offboarding.includeClosed),
        reassign_reportees: Boolean(offboarding.reassignReportees),
        transfer_leads: Boolean(offboarding.transferLeads),
        transfer_quotes: Boolean(offboarding.transferQuotes),
        transfer_sales_orders: Boolean(offboarding.transferSalesOrders),
        transfer_job_cards: Boolean(offboarding.transferJobCards),
        transfer_purchase_requisitions: Boolean(offboarding.transferPurchaseRequisitions),
        transfer_dispatches: Boolean(offboarding.transferDispatches),
        transfer_customer_invoices: Boolean(offboarding.transferCustomerInvoices),
        transfer_goods_receipts: Boolean(offboarding.transferGoodsReceipts),
        transfer_quality_controls: Boolean(offboarding.transferQualityControls),
        transfer_supplier_claims: Boolean(offboarding.transferSupplierClaims),
        transfer_purchase_returns: Boolean(offboarding.transferPurchaseReturns),
        transfer_sales_returns: Boolean(offboarding.transferSalesReturns),
        transfer_purchase_orders: Boolean(offboarding.transferPurchaseOrders),
        transfer_purchase_invoices: Boolean(offboarding.transferPurchaseInvoices),
        transfer_vendor_payments: Boolean(offboarding.transferVendorPayments),
        transfer_customer_receipts: Boolean(offboarding.transferCustomerReceipts),
        transfer_finance_entries: Boolean(offboarding.transferFinanceEntries),
        transfer_stock_adjustments: Boolean(offboarding.transferStockAdjustments),
        transfer_stock_transfers: Boolean(offboarding.transferStockTransfers),
        transfer_service_cases: Boolean(offboarding.transferServiceCases),
        transfer_amc_contracts: Boolean(offboarding.transferAmcContracts),
        transfer_approval_chains: Boolean(offboarding.transferApprovalChains),
      };
      const data = await apiFetch("/users/admin/offboard-user", { method: "POST", body: JSON.stringify(payload) });
      const result = {
        leads: Number(data?.leads_transferred || 0),
        quotes: Number(data?.quotes_transferred || 0),
        salesOrders: Number(data?.sales_orders_transferred || 0),
        jobCards: Number(data?.job_cards_transferred || 0),
        purchaseRequisitions: Number(data?.purchase_requisitions_transferred || 0),
        dispatches: Number(data?.dispatches_transferred || 0),
        customerInvoices: Number(data?.customer_invoices_transferred || 0),
        goodsReceipts: Number(data?.goods_receipts_transferred || 0),
        qualityControls: Number(data?.quality_controls_transferred || 0),
        supplierClaims: Number(data?.supplier_claims_transferred || 0),
        supplierClaimReceipts: Number(data?.supplier_claim_receipts_transferred || 0),
        purchaseReturns: Number(data?.purchase_returns_transferred || 0),
        salesReturns: Number(data?.sales_returns_transferred || 0),
        purchaseOrders: Number(data?.purchase_orders_transferred || 0),
        purchaseInvoices: Number(data?.purchase_invoices_transferred || 0),
        vendorPayments: Number(data?.vendor_payments_transferred || 0),
        customerReceipts: Number(data?.customer_receipts_transferred || 0),
        financeEntries: Number(data?.finance_entries_transferred || 0),
        stockAdjustments: Number(data?.stock_adjustments_transferred || 0),
        stockTransfers: Number(data?.stock_transfers_transferred || 0),
        serviceCases: Number(data?.service_cases_transferred || 0),
        amcContracts: Number(data?.amc_contracts_transferred || 0),
        approvalChains: Number(data?.approval_chains_transferred || 0),
        approvalChainBreakdown: data?.approval_chain_breakdown || null,
        reporteesReassigned: Number(data?.reportees_reassigned || 0),
      };
      setOffboardResult(result);
      setOffboardConfirmOpen(false);
      await refreshAll();
      const parts = [];
      if (offboarding.transferLeads) parts.push(`${result.leads} leads`);
      if (offboarding.transferQuotes) parts.push(`${result.quotes} quotes`);
      if (offboarding.transferSalesOrders) parts.push(`${result.salesOrders} sales orders`);
      if (offboarding.transferJobCards) parts.push(`${result.jobCards} job cards`);
      if (offboarding.transferPurchaseRequisitions) parts.push(`${result.purchaseRequisitions} requisitions`);
      if (offboarding.transferDispatches) parts.push(`${result.dispatches} dispatches`);
      if (offboarding.transferCustomerInvoices) parts.push(`${result.customerInvoices} invoices`);
      if (offboarding.transferGoodsReceipts) parts.push(`${result.goodsReceipts} GRNs`);
      if (offboarding.transferQualityControls) parts.push(`${result.qualityControls} QC`);
      if (offboarding.transferSupplierClaims) parts.push(`${result.supplierClaims} claims`);
      if (offboarding.transferPurchaseReturns) parts.push(`${result.purchaseReturns} purchase returns`);
      if (offboarding.transferSalesReturns) parts.push(`${result.salesReturns} sales returns`);
      if (offboarding.transferPurchaseOrders) parts.push(`${result.purchaseOrders} purchase orders`);
      if (offboarding.transferPurchaseInvoices) parts.push(`${result.purchaseInvoices} purchase invoices`);
      if (offboarding.transferVendorPayments) parts.push(`${result.vendorPayments} vendor payments`);
      if (offboarding.transferCustomerReceipts) parts.push(`${result.customerReceipts} customer receipts`);
      if (offboarding.transferFinanceEntries) parts.push(`${result.financeEntries} finance entries`);
      if (offboarding.transferStockAdjustments) parts.push(`${result.stockAdjustments} stock adjustments`);
      if (offboarding.transferStockTransfers) parts.push(`${result.stockTransfers} stock transfers`);
      if (offboarding.transferServiceCases) parts.push(`${result.serviceCases} service cases`);
      if (offboarding.transferAmcContracts) parts.push(`${result.amcContracts} AMC contracts`);
      if (offboarding.transferApprovalChains) parts.push(`${result.approvalChains} approval chains`);
      if (offboarding.reassignReportees) parts.push(`${result.reporteesReassigned} reportees re-linked`);
      setNotice(parts.length ? `User deactivated and transferred ${parts.join(" • ")}.` : "User deactivated.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "INVALID_TRANSFER") setError("Select different source and replacement users.");
      else if (code === "USER_NOT_FOUND") setError("Selected user was not found.");
      else if (code === "USER_ALREADY_INACTIVE") setError("This user is already inactive.");
      else if (code === "TARGET_USER_INACTIVE") setError("Replacement user must stay active.");
      else if (code === "SELF_OFFBOARD_NOT_ALLOWED") setError("You cannot offboard your own active login from this flow.");
      else setError(code || "Failed to offboard user.");
    } finally {
      setOffboardBusy(false);
    }
  }

  async function previewOffboarding() {
    setOffboardPreviewBusy(true);
    setError("");
    setNotice("");
    setOffboardPreview(null);
    try {
      const payload = {
        from_user_id: offboarding.fromUserId ? Number(offboarding.fromUserId) : null,
        to_user_id: offboarding.toUserId ? Number(offboarding.toUserId) : null,
        include_closed: Boolean(offboarding.includeClosed),
        reassign_reportees: Boolean(offboarding.reassignReportees),
        transfer_leads: Boolean(offboarding.transferLeads),
        transfer_quotes: Boolean(offboarding.transferQuotes),
        transfer_sales_orders: Boolean(offboarding.transferSalesOrders),
        transfer_job_cards: Boolean(offboarding.transferJobCards),
        transfer_purchase_requisitions: Boolean(offboarding.transferPurchaseRequisitions),
        transfer_dispatches: Boolean(offboarding.transferDispatches),
        transfer_customer_invoices: Boolean(offboarding.transferCustomerInvoices),
        transfer_goods_receipts: Boolean(offboarding.transferGoodsReceipts),
        transfer_quality_controls: Boolean(offboarding.transferQualityControls),
        transfer_supplier_claims: Boolean(offboarding.transferSupplierClaims),
        transfer_purchase_returns: Boolean(offboarding.transferPurchaseReturns),
        transfer_sales_returns: Boolean(offboarding.transferSalesReturns),
        transfer_purchase_orders: Boolean(offboarding.transferPurchaseOrders),
        transfer_purchase_invoices: Boolean(offboarding.transferPurchaseInvoices),
        transfer_vendor_payments: Boolean(offboarding.transferVendorPayments),
        transfer_customer_receipts: Boolean(offboarding.transferCustomerReceipts),
        transfer_finance_entries: Boolean(offboarding.transferFinanceEntries),
        transfer_stock_adjustments: Boolean(offboarding.transferStockAdjustments),
        transfer_stock_transfers: Boolean(offboarding.transferStockTransfers),
        transfer_service_cases: Boolean(offboarding.transferServiceCases),
        transfer_amc_contracts: Boolean(offboarding.transferAmcContracts),
        transfer_approval_chains: Boolean(offboarding.transferApprovalChains),
      };
      const data = await apiFetch("/users/admin/offboard-preview", { method: "POST", body: JSON.stringify(payload) });
      setOffboardPreview({
        leads: Number(data?.leads_transferred || 0),
        quotes: Number(data?.quotes_transferred || 0),
        salesOrders: Number(data?.sales_orders_transferred || 0),
        jobCards: Number(data?.job_cards_transferred || 0),
        purchaseRequisitions: Number(data?.purchase_requisitions_transferred || 0),
        dispatches: Number(data?.dispatches_transferred || 0),
        customerInvoices: Number(data?.customer_invoices_transferred || 0),
        goodsReceipts: Number(data?.goods_receipts_transferred || 0),
        qualityControls: Number(data?.quality_controls_transferred || 0),
        supplierClaims: Number(data?.supplier_claims_transferred || 0),
        supplierClaimReceipts: Number(data?.supplier_claim_receipts_transferred || 0),
        purchaseReturns: Number(data?.purchase_returns_transferred || 0),
        salesReturns: Number(data?.sales_returns_transferred || 0),
        purchaseOrders: Number(data?.purchase_orders_transferred || 0),
        purchaseInvoices: Number(data?.purchase_invoices_transferred || 0),
        vendorPayments: Number(data?.vendor_payments_transferred || 0),
        customerReceipts: Number(data?.customer_receipts_transferred || 0),
        financeEntries: Number(data?.finance_entries_transferred || 0),
        stockAdjustments: Number(data?.stock_adjustments_transferred || 0),
        stockTransfers: Number(data?.stock_transfers_transferred || 0),
        serviceCases: Number(data?.service_cases_transferred || 0),
        amcContracts: Number(data?.amc_contracts_transferred || 0),
        approvalChains: Number(data?.approval_chains_transferred || 0),
        approvalChainBreakdown: data?.approval_chain_breakdown || null,
        reporteesToReassign: Number(data?.reportees_to_reassign || 0),
      });
      setNotice("Preview loaded. Review impact, then run Transfer + Deactivate.");
    } catch (e) {
      const code = e?.data?.error;
      if (code === "INVALID_TRANSFER") setError("Select different source and replacement users.");
      else if (code === "USER_NOT_FOUND") setError("Selected user was not found.");
      else if (code === "USER_ALREADY_INACTIVE") setError("This user is already inactive.");
      else if (code === "TARGET_USER_INACTIVE") setError("Replacement user must stay active.");
      else if (code === "SELF_OFFBOARD_NOT_ALLOWED") setError("You cannot offboard your own active login from this flow.");
      else setError(code || "Failed to preview offboarding impact.");
    } finally {
      setOffboardPreviewBusy(false);
    }
  }

  function renderDirectory() {
    return (
      <SurfaceCard
        title="User directory"
        subtitle="Search by code, name, email, company, or role and open a user directly into the editor."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={startNew}>
              New User
            </button>
            <button type="button" onClick={() => refreshAll().catch(() => {})} disabled={loading}>
              Refresh
            </button>
          </div>
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 160px 200px", gap: 10, marginBottom: 14 }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by code, name, email, group, role, company" />
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="">All groups</option>
            {groups.map((group) => (
              <option key={group.id} value={String(group.id)}>
                {group.group_name}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
          <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
            <option value="">All companies</option>
            {companies.map((company) => (
              <option key={company.id} value={String(company.id)}>
                {company.company_code} - {company.company_name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 12 }}>{filteredUsers.length} users in view</div>
        <div style={{ display: "grid", gap: 10, maxHeight: "72vh", overflowY: "auto", paddingRight: 4 }}>
          {loading ? (
            <div style={{ padding: 12 }}>Loading…</div>
          ) : filteredUsers.length ? (
            filteredUsers.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => editUser(u)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  border: "1px solid #e3e8f2",
                  borderRadius: 16,
                  padding: 14,
                  background: String(u.id) === String(form.id) ? "#eef4ff" : "#fbfcff",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <strong>{u.full_name || "Unnamed user"}</strong>
                  <span style={{ fontSize: 12, opacity: 0.72 }}>{u.user_code || "—"}</span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{u.email || "No email"} • {u.phone || "No phone"}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>
                  {u.group_name || "No group"} • {u.role_name || "No role"} • {u.company_name || u.distributor_name || "No company"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  Manager: {u.primary_manager_name || "—"} • Mail: {u.mail_connected ? u.mailbox_email || "Connected" : "Not connected"} • {u.is_active ? "Active" : "Inactive"}
                </div>
              </button>
            ))
          ) : (
            <div style={{ padding: 12, opacity: 0.72 }}>No users found.</div>
          )}
        </div>
      </SurfaceCard>
    );
  }

  function renderEditor() {
    return (
      <SurfaceCard
        title="User editor"
        subtitle="Hierarchy, access, authority, and password setup are grouped into one focused editor."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={startNew}>
              Reset Draft
            </button>
            <button type="button" onClick={save} disabled={saving || loading}>
              {saving ? "Saving..." : "Save User"}
            </button>
          </div>
        }
      >
        <div style={{ border: "1px solid #edf1f7", borderRadius: 16, padding: 14, background: "#fbfcff", marginBottom: 16 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
            {form.id ? "Editing user" : "Creating user"}
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{form.full_name || "New user draft"}</div>
          <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8 }}>
            {form.user_code || "System Generated"} • {selectedGroup?.group_name || "Select group"} • {selectedUser?.mail_connected ? selectedUser.mailbox_email || "Mailbox connected" : "Mailbox not connected"}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <SurfaceCard title="Identity" subtitle="Role Profile sets group and department automatically.">
            <Field label="Legacy Code (Clan)">
              <input value={form.user_code} disabled />
            </Field>
            <Field label="Full Name">
              <input value={form.full_name} onChange={(e) => setField("full_name", e.target.value)} />
            </Field>
            <Field label="Email ID">
              <input value={form.email} onChange={(e) => setField("email", e.target.value)} />
            </Field>
            <Field label="Phone No.">
              <input value={form.phone} onChange={(e) => setField("phone", e.target.value)} />
            </Field>
            <Field label="Designation">
              <input list="designation-options" value={form.designation} onChange={(e) => setField("designation", e.target.value)} />
              <datalist id="designation-options">
                {designations
                  .map((d) => String(d?.designation_name || "").trim())
                  .filter(Boolean)
                  .map((name) => (
                    <option key={name} value={name} />
                  ))}
              </datalist>
            </Field>
            <Field label="Access profile">
              <select value={form.role_id} onChange={(e) => setRoleProfile(e.target.value)}>
                <option value="">-- Select --</option>
                {groupRolesForSelect(roles).map((bucket) => (
                  <optgroup key={bucket.family} label={bucket.label}>
                    {bucket.roles.map((r) => (
                      <option key={r.id} value={String(r.id)}>
                        {r.role_name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            {form.role_id ? (
              <div style={{ marginBottom: 12, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                {formatRoleProfileSummary(
                  resolveRoleProfile(
                    roles.find((r) => String(r.id) === String(form.role_id)),
                    groups,
                    departments
                  ),
                  departments
                )}
              </div>
            ) : null}
            <Field label="Legacy Company Name (Clan)">
              <input value={form.company_name} onChange={(e) => setField("company_name", e.target.value)} />
            </Field>
            {isDistributorUser ? (
              <Field label="Channel Partner">
                <select
                  value={form.distributor_id}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const picked = distributors.find((d) => String(d.id) === String(nextId));
                    setForm((prev) => ({ ...prev, distributor_id: nextId, company_name: prev.company_name || picked?.company_name || "" }));
                  }}
                >
                  <option value="">-- Select --</option>
                  {distributors.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.company_name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </SurfaceCard>

          <SurfaceCard title="Reporting & access" subtitle="Managers, date of joining, password, and approval flags live here.">
            <Field label="Employee Code (Josh)">
              <input value={form.employee_code} onChange={(e) => setField("employee_code", e.target.value)} />
            </Field>
            <div style={{ marginBottom: 12, fontSize: 12, opacity: 0.68, lineHeight: 1.6 }}>
              Home family: {formatWorkspaceFamilyLabel(roles.find((r) => String(r.id) === String(form.role_id))?.default_workspace_family)}.
              Department is derived from Role Profile ({form.department_key || "none"}).
            </div>
            <Field label="Employment Company">
              <select value={form.employment_company_id} onChange={(e) => setField("employment_company_id", e.target.value)}>
                <option value="">-- Select --</option>
                {companies.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.company_code} - {c.company_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Works For (Companies)">
              <div style={{ display: "grid", gap: 8 }}>
                {companies.map((c) => {
                  const cid = String(c.id);
                  const checked = Array.isArray(form.company_ids) && form.company_ids.includes(cid);
                  return (
                    <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextChecked = e.target.checked;
                          setForm((prev) => {
                            const existing = Array.isArray(prev.company_ids) ? prev.company_ids : [];
                            const next = nextChecked ? Array.from(new Set([...existing, cid])) : existing.filter((x) => x !== cid);
                            const primaryOk = prev.primary_company_id && next.includes(String(prev.primary_company_id));
                            return {
                              ...prev,
                              company_ids: next,
                              primary_company_id: primaryOk ? prev.primary_company_id : next[0] || "",
                            };
                          });
                        }}
                      />
                      {c.company_code} - {c.company_name}
                    </label>
                  );
                })}
              </div>
            </Field>
            <Field label="Primary (Employment) Company">
              <select
                value={form.primary_company_id}
                onChange={(e) => setField("primary_company_id", e.target.value)}
                disabled={!Array.isArray(form.company_ids) || !form.company_ids.length}
              >
                <option value="">-- Select --</option>
                {companies
                  .filter((c) => Array.isArray(form.company_ids) && form.company_ids.includes(String(c.id)))
                  .map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.company_code} - {c.company_name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Primary Manager">
              <select value={form.primary_manager_user_id} onChange={(e) => setField("primary_manager_user_id", e.target.value)}>
                <option value="">-- None --</option>
                {managerOptions.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {(u.full_name || u.email) + (u.user_code ? ` (${u.user_code})` : "")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Secondary Manager">
              <select value={form.secondary_manager_user_id} onChange={(e) => setField("secondary_manager_user_id", e.target.value)}>
                <option value="">-- None --</option>
                {managerOptions.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {(u.full_name || u.email) + (u.user_code ? ` (${u.user_code})` : "")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date of Joining">
              <input type="date" value={form.date_of_joining} onChange={(e) => setField("date_of_joining", e.target.value)} />
            </Field>
            <Field label={form.id ? "Reset / Set Local Password" : "Set Initial Local Password"}>
              <input type="password" value={form.password} onChange={(e) => setField("password", e.target.value)} placeholder={form.id ? "Leave blank to keep current password" : "Optional for local login users"} />
            </Field>
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.is_approved} onChange={(e) => setField("is_approved", e.target.checked)} />
                Approved
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.is_active} onChange={(e) => setField("is_active", e.target.checked)} />
                Active
              </label>
            </div>
            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 10 }}>
              Discount fallback: {selectedGroup ? `${selectedGroup.max_autonomous_discount_pct}% from group` : "select a group"}
            </div>
          </SurfaceCard>

          <SurfaceCard title="Commercial authority" subtitle="Discount override and mailing context stay visible for the selected user.">
            <Field label="Discount Threshold %">
              <input type="number" min="0" max="100" step="0.01" value={form.discount_threshold_pct} onChange={(e) => setField("discount_threshold_pct", e.target.value)} />
            </Field>
            <div style={{ fontSize: 12, opacity: 0.72 }}>
              Mailbox status: {selectedUser?.mail_connected ? selectedUser.mailbox_email || "Connected" : "Not connected"}
            </div>
          </SurfaceCard>

          <SurfaceCard title="Address details" subtitle="Local and permanent address stay available for admin reference.">
            <Field label="Local Address">
              <textarea rows={3} value={form.local_address} onChange={(e) => setField("local_address", e.target.value)} />
            </Field>
            <Field label="Permanent Address">
              <textarea rows={3} value={form.permanent_address} onChange={(e) => setField("permanent_address", e.target.value)} />
            </Field>
          </SurfaceCard>
        </div>
      </SurfaceCard>
    );
  }

  function renderTransferDesk() {
    return (
      <SurfaceCard title="Transfer work" subtitle="Move open work from one user to another so queues stay manageable when people shift roles.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr)) 220px", gap: 12, alignItems: "end" }}>
          <Field label="From User">
            <select value={transferFromId} onChange={(e) => setTransferFromId(e.target.value)}>
              <option value="">-- Select --</option>
              {users.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.full_name || u.email} ({u.user_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="To User">
            <select value={transferToId} onChange={(e) => setTransferToId(e.target.value)}>
              <option value="">-- Select --</option>
              {users.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.full_name || u.email} ({u.user_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scope">
            <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, minHeight: 38 }}>
              <input type="checkbox" checked={transferIncludeClosed} onChange={(e) => setTransferIncludeClosed(e.target.checked)} />
              Include closed/non-open leads
            </label>
          </Field>
          <button type="button" onClick={transferWork} disabled={transferBusy}>
            {transferBusy ? "Transferring..." : "Transfer Work"}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferLeads} onChange={(e) => setTransferLeads(e.target.checked)} />
            Leads
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferQuotes} onChange={(e) => setTransferQuotes(e.target.checked)} />
            Quotes
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferSalesOrders} onChange={(e) => setTransferSalesOrders(e.target.checked)} />
            Sales Orders
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferJobCards} onChange={(e) => setTransferJobCards(e.target.checked)} />
            Job Cards
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferPurchaseRequisitions} onChange={(e) => setTransferPurchaseRequisitions(e.target.checked)} />
            Requisitions
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferDispatches} onChange={(e) => setTransferDispatches(e.target.checked)} />
            Dispatches
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferCustomerInvoices} onChange={(e) => setTransferCustomerInvoices(e.target.checked)} />
            Invoices
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferGoodsReceipts} onChange={(e) => setTransferGoodsReceipts(e.target.checked)} />
            GRN
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferQualityControls} onChange={(e) => setTransferQualityControls(e.target.checked)} />
            QC
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferSupplierClaims} onChange={(e) => setTransferSupplierClaims(e.target.checked)} />
            Claims
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferPurchaseReturns} onChange={(e) => setTransferPurchaseReturns(e.target.checked)} />
            Purchase Returns
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferSalesReturns} onChange={(e) => setTransferSalesReturns(e.target.checked)} />
            Sales Returns
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferPurchaseOrders} onChange={(e) => setTransferPurchaseOrders(e.target.checked)} />
            Purchase Orders
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferPurchaseInvoices} onChange={(e) => setTransferPurchaseInvoices(e.target.checked)} />
            Purchase Invoices
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferVendorPayments} onChange={(e) => setTransferVendorPayments(e.target.checked)} />
            Vendor Payments
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferCustomerReceipts} onChange={(e) => setTransferCustomerReceipts(e.target.checked)} />
            Customer Receipts
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferFinanceEntries} onChange={(e) => setTransferFinanceEntries(e.target.checked)} />
            Bank Book
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferStockAdjustments} onChange={(e) => setTransferStockAdjustments(e.target.checked)} />
            Stock Adjustments
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferStockTransfers} onChange={(e) => setTransferStockTransfers(e.target.checked)} />
            Stock Transfers
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferServiceCases} onChange={(e) => setTransferServiceCases(e.target.checked)} />
            Service Cases
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferAmcContracts} onChange={(e) => setTransferAmcContracts(e.target.checked)} />
            AMC Contracts
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={transferApprovalChains} onChange={(e) => setTransferApprovalChains(e.target.checked)} />
            Approval chains
          </label>
        </div>

        {transferResult ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
            <StatCard label="Leads" value={transferResult.leads} note="assigned_to updated + assignment logged" accent="#1f5eff" />
            <StatCard label="Quotes" value={transferResult.quotes} note="created_by moved for open quotes" accent="#8b5cf6" />
            <StatCard label="Sales Orders" value={transferResult.salesOrders} note="created_by moved for open SOs" accent="#14804a" />
            <StatCard label="Job Cards" value={transferResult.jobCards} note="created_by moved for open jobs" accent="#d97706" />
            <StatCard label="Requisitions" value={transferResult.purchaseRequisitions} note="created_by moved for open PRQs" accent="#7c3aed" />
            <StatCard label="Dispatches" value={transferResult.dispatches} note="created_by moved for open dispatches" accent="#0f766e" />
            <StatCard label="Invoices" value={transferResult.customerInvoices} note="created_by moved for open invoices" accent="#1d4ed8" />
            <StatCard label="GRN" value={transferResult.goodsReceipts} note="created_by moved for GRNs" accent="#7c2d12" />
            <StatCard label="QC" value={transferResult.qualityControls} note="created_by moved for QC" accent="#b45309" />
            <StatCard label="Claims" value={transferResult.supplierClaims} note="created_by moved for claims" accent="#6d28d9" />
            <StatCard label="Claim Rcpts" value={transferResult.supplierClaimReceipts} note="created_by moved for claim receipts" accent="#9333ea" />
            <StatCard label="Purchase Returns" value={transferResult.purchaseReturns} note="created_by moved for returns" accent="#be123c" />
            <StatCard label="Sales Returns" value={transferResult.salesReturns} note="created_by moved for returns" accent="#9f1239" />
            <StatCard label="Purchase Orders" value={transferResult.purchaseOrders} note="created_by moved for open POs" accent="#0f766e" />
            <StatCard label="Purchase Invoices" value={transferResult.purchaseInvoices} note="created_by moved for purchase invoices" accent="#155e75" />
            <StatCard label="Vendor Payments" value={transferResult.vendorPayments} note="created_by moved for vendor payments" accent="#0c4a6e" />
            <StatCard label="Cust Receipts" value={transferResult.customerReceipts} note="created_by moved for customer receipts" accent="#1e40af" />
            <StatCard label="Bank Book" value={transferResult.financeEntries} note="created_by moved for finance entries" accent="#4338ca" />
            <StatCard label="Stock Adjust" value={transferResult.stockAdjustments} note="created_by moved for adjustments" accent="#92400e" />
            <StatCard label="Stock Transfers" value={transferResult.stockTransfers} note="created_by moved for transfers" accent="#7c2d12" />
            <StatCard label="Service Cases" value={transferResult.serviceCases} note="created_by moved for service cases" accent="#166534" />
            <StatCard label="AMC Contracts" value={transferResult.amcContracts} note="created_by moved for AMC contracts" accent="#365314" />
            <StatCard label="Approval chains" value={transferResult.approvalChains} note="pending submit/approve/prepared reassigned" accent="#111827" />
          </div>
        ) : null}

        {transferResult?.approvalChains > 0 ? (
          <div style={{ marginTop: 14, border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Approval chain breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 10 }}>
              {approvalBreakdownEntries(transferResult.approvalChainBreakdown).map(([label, value]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, border: "1px solid #edf1f7", borderRadius: 12, padding: "10px 12px", background: "#fff", fontSize: 13 }}>
                  <span>{label}</span>
                  <strong>{Number(value || 0)}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 16, border: "1px solid #edf1f7", borderRadius: 16, padding: 14, background: "#fbfcff", fontSize: 13, opacity: 0.76, lineHeight: 1.7 }}>
          Ownership fields used for access control are moved to the new user. Historical transaction authorship (issued movements, approvals) stays unchanged.
        </div>
      </SurfaceCard>
    );
  }

  function renderOffboardingDesk() {
    const coverageImpact = offboardPreview || null;
    const coverageGroups = coverageImpact
      ? [
          {
            title: "Sales / Marketing",
            items: [
              { label: "Leads", selected: offboarding.transferLeads, count: coverageImpact.leads },
              { label: "Quotes", selected: offboarding.transferQuotes, count: coverageImpact.quotes },
              { label: "Sales Orders", selected: offboarding.transferSalesOrders, count: coverageImpact.salesOrders },
              { label: "Dispatches", selected: offboarding.transferDispatches, count: coverageImpact.dispatches },
              { label: "Invoices", selected: offboarding.transferCustomerInvoices, count: coverageImpact.customerInvoices },
              { label: "Customer Receipts", selected: offboarding.transferCustomerReceipts, count: coverageImpact.customerReceipts },
            ],
          },
          {
            title: "Purchase / Accounts",
            items: [
              { label: "Requisitions", selected: offboarding.transferPurchaseRequisitions, count: coverageImpact.purchaseRequisitions },
              { label: "Purchase Orders", selected: offboarding.transferPurchaseOrders, count: coverageImpact.purchaseOrders },
              { label: "Purchase Invoices", selected: offboarding.transferPurchaseInvoices, count: coverageImpact.purchaseInvoices },
              { label: "GRN", selected: offboarding.transferGoodsReceipts, count: coverageImpact.goodsReceipts },
              { label: "Vendor Payments", selected: offboarding.transferVendorPayments, count: coverageImpact.vendorPayments },
              { label: "Bank Book", selected: offboarding.transferFinanceEntries, count: coverageImpact.financeEntries },
            ],
          },
          {
            title: "Factory / Stores",
            items: [
              { label: "Job Cards", selected: offboarding.transferJobCards, count: coverageImpact.jobCards },
              { label: "QC", selected: offboarding.transferQualityControls, count: coverageImpact.qualityControls },
              { label: "Stock Adjustments", selected: offboarding.transferStockAdjustments, count: coverageImpact.stockAdjustments },
              { label: "Stock Transfers", selected: offboarding.transferStockTransfers, count: coverageImpact.stockTransfers },
              { label: "Purchase Returns", selected: offboarding.transferPurchaseReturns, count: coverageImpact.purchaseReturns },
              { label: "Sales Returns", selected: offboarding.transferSalesReturns, count: coverageImpact.salesReturns },
            ],
          },
          {
            title: "Service / AMC",
            items: [
              { label: "Service Cases", selected: offboarding.transferServiceCases, count: coverageImpact.serviceCases },
              { label: "AMC Contracts", selected: offboarding.transferAmcContracts, count: coverageImpact.amcContracts },
              { label: "Claims", selected: offboarding.transferSupplierClaims, count: coverageImpact.supplierClaims },
              { label: "Claim Receipts", selected: offboarding.transferSupplierClaims, count: coverageImpact.supplierClaimReceipts },
            ],
          },
        ]
      : [];

    return (
      <SurfaceCard title="Guided offboarding" subtitle="Deactivate a user only after transferring open work and re-homing reportees to the replacement owner.">
        {renderOffboardingAuditMigrationWarning()}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, alignItems: "end" }}>
          <Field label="Offboard User">
            <select value={offboarding.fromUserId} onChange={(e) => setOffboardingField("fromUserId", e.target.value)}>
              <option value="">-- Select active user --</option>
              {activeUsers.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.full_name || u.email} ({u.user_code})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Replacement User">
            <select value={offboarding.toUserId} onChange={(e) => setOffboardingField("toUserId", e.target.value)}>
              <option value="">-- Select active user --</option>
              {activeUsers
                .filter((u) => String(u.id) !== String(offboarding.fromUserId))
                .map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.full_name || u.email} ({u.user_code})
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Document Scope">
            <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, minHeight: 38 }}>
              <input type="checkbox" checked={offboarding.includeClosed} onChange={(e) => setOffboardingField("includeClosed", e.target.checked)} />
              Include closed/final records too
            </label>
          </Field>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" onClick={previewOffboarding} disabled={offboardPreviewBusy}>
              {offboardPreviewBusy ? "Previewing..." : "Preview Impact"}
            </button>
            <button type="button" onClick={() => setOffboardConfirmOpen(true)} disabled={offboardBusy || !offboardingAuditsReady}>
              {!offboardingAuditsReady ? "Migration required" : offboardBusy ? "Offboarding..." : "Transfer + Deactivate"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferLeads} onChange={(e) => setOffboardingField("transferLeads", e.target.checked)} />
            Leads
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferQuotes} onChange={(e) => setOffboardingField("transferQuotes", e.target.checked)} />
            Quotes
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferSalesOrders} onChange={(e) => setOffboardingField("transferSalesOrders", e.target.checked)} />
            Sales Orders
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferJobCards} onChange={(e) => setOffboardingField("transferJobCards", e.target.checked)} />
            Job Cards
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferPurchaseRequisitions} onChange={(e) => setOffboardingField("transferPurchaseRequisitions", e.target.checked)} />
            Requisitions
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferDispatches} onChange={(e) => setOffboardingField("transferDispatches", e.target.checked)} />
            Dispatches
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferCustomerInvoices} onChange={(e) => setOffboardingField("transferCustomerInvoices", e.target.checked)} />
            Invoices
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferGoodsReceipts} onChange={(e) => setOffboardingField("transferGoodsReceipts", e.target.checked)} />
            GRN
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferQualityControls} onChange={(e) => setOffboardingField("transferQualityControls", e.target.checked)} />
            QC
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferSupplierClaims} onChange={(e) => setOffboardingField("transferSupplierClaims", e.target.checked)} />
            Claims
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferPurchaseReturns} onChange={(e) => setOffboardingField("transferPurchaseReturns", e.target.checked)} />
            Purchase Returns
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferSalesReturns} onChange={(e) => setOffboardingField("transferSalesReturns", e.target.checked)} />
            Sales Returns
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferPurchaseOrders} onChange={(e) => setOffboardingField("transferPurchaseOrders", e.target.checked)} />
            Purchase Orders
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferPurchaseInvoices} onChange={(e) => setOffboardingField("transferPurchaseInvoices", e.target.checked)} />
            Purchase Invoices
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferVendorPayments} onChange={(e) => setOffboardingField("transferVendorPayments", e.target.checked)} />
            Vendor Payments
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferCustomerReceipts} onChange={(e) => setOffboardingField("transferCustomerReceipts", e.target.checked)} />
            Customer Receipts
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferFinanceEntries} onChange={(e) => setOffboardingField("transferFinanceEntries", e.target.checked)} />
            Bank Book
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferStockAdjustments} onChange={(e) => setOffboardingField("transferStockAdjustments", e.target.checked)} />
            Stock Adjustments
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferStockTransfers} onChange={(e) => setOffboardingField("transferStockTransfers", e.target.checked)} />
            Stock Transfers
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferServiceCases} onChange={(e) => setOffboardingField("transferServiceCases", e.target.checked)} />
            Service Cases
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferAmcContracts} onChange={(e) => setOffboardingField("transferAmcContracts", e.target.checked)} />
            AMC Contracts
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.transferApprovalChains} onChange={(e) => setOffboardingField("transferApprovalChains", e.target.checked)} />
            Approval chains
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, padding: "10px 12px", borderRadius: 14, border: "1px solid #e3e8f2", background: "#fbfcff" }}>
            <input type="checkbox" checked={offboarding.reassignReportees} onChange={(e) => setOffboardingField("reassignReportees", e.target.checked)} />
            Reassign Reportees
          </label>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 16 }}>
          <div style={{ border: "1px solid #edf1f7", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Source user</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{selectedOffboardFromUser?.full_name || "Select a user"}</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6 }}>
              {selectedOffboardFromUser
                ? `${selectedOffboardFromUser.email || "No email"} • ${selectedOffboardFromUser.group_name || "No group"} • ${selectedOffboardFromUser.is_active ? "Active" : "Inactive"}`
                : "The current owner to be deactivated after handoff."}
            </div>
          </div>
          <div style={{ border: "1px solid #edf1f7", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Replacement owner</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{selectedOffboardToUser?.full_name || "Select a replacement"}</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6 }}>
              {selectedOffboardToUser
                ? `${selectedOffboardToUser.email || "No email"} • ${selectedOffboardToUser.group_name || "No group"} • ${selectedOffboardToUser.is_active ? "Active" : "Inactive"}`
                : "Open work and reportees move here before the source user is disabled."}
            </div>
          </div>
        </div>

        {offboardPreview ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
            <StatCard label="Leads" value={offboardPreview.leads} note="would move lead ownership" accent="#1f5eff" />
            <StatCard label="Quotes" value={offboardPreview.quotes} note="would move open quote ownership" accent="#8b5cf6" />
            <StatCard label="Sales Orders" value={offboardPreview.salesOrders} note="would move open SO ownership" accent="#14804a" />
            <StatCard label="Job Cards" value={offboardPreview.jobCards} note="would move open job ownership" accent="#d97706" />
            <StatCard label="Requisitions" value={offboardPreview.purchaseRequisitions} note="would move open PRQ ownership" accent="#7c3aed" />
            <StatCard label="Dispatches" value={offboardPreview.dispatches} note="would move open dispatch ownership" accent="#0f766e" />
            <StatCard label="Invoices" value={offboardPreview.customerInvoices} note="would move open invoice ownership" accent="#1d4ed8" />
            <StatCard label="GRN" value={offboardPreview.goodsReceipts} note="would move GRN ownership" accent="#7c2d12" />
            <StatCard label="QC" value={offboardPreview.qualityControls} note="would move QC ownership" accent="#b45309" />
            <StatCard label="Claims" value={offboardPreview.supplierClaims} note="would move claim ownership" accent="#6d28d9" />
            <StatCard label="Claim Rcpts" value={offboardPreview.supplierClaimReceipts} note="would move claim receipt ownership" accent="#9333ea" />
            <StatCard label="Purchase Returns" value={offboardPreview.purchaseReturns} note="would move return ownership" accent="#be123c" />
            <StatCard label="Sales Returns" value={offboardPreview.salesReturns} note="would move return ownership" accent="#9f1239" />
            <StatCard label="Purchase Orders" value={offboardPreview.purchaseOrders} note="would move open PO ownership" accent="#0f766e" />
            <StatCard label="Purchase Invoices" value={offboardPreview.purchaseInvoices} note="would move purchase invoice ownership" accent="#155e75" />
            <StatCard label="Vendor Payments" value={offboardPreview.vendorPayments} note="would move vendor payment ownership" accent="#0c4a6e" />
            <StatCard label="Cust Receipts" value={offboardPreview.customerReceipts} note="would move customer receipt ownership" accent="#1e40af" />
            <StatCard label="Bank Book" value={offboardPreview.financeEntries} note="would move finance entry ownership" accent="#4338ca" />
            <StatCard label="Stock Adjust" value={offboardPreview.stockAdjustments} note="would move adjustment ownership" accent="#92400e" />
            <StatCard label="Stock Transfers" value={offboardPreview.stockTransfers} note="would move transfer ownership" accent="#7c2d12" />
            <StatCard label="Service Cases" value={offboardPreview.serviceCases} note="would move service case ownership" accent="#166534" />
            <StatCard label="AMC Contracts" value={offboardPreview.amcContracts} note="would move AMC ownership" accent="#365314" />
            {offboarding.transferApprovalChains ? (
              <StatCard label="Approval chains" value={offboardPreview.approvalChains} note="would reassign pending submit/approve/prepared" accent="#111827" />
            ) : null}
            <StatCard label="Reportees" value={offboardPreview.reporteesToReassign} note="would re-link to replacement" accent="#b91c1c" />
          </div>
        ) : null}

        {offboarding.transferApprovalChains && offboardPreview?.approvalChains > 0 ? (
          <div style={{ marginTop: 14, border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Approval chain breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 10 }}>
              {approvalBreakdownEntries(offboardPreview.approvalChainBreakdown).map(([label, value]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, border: "1px solid #edf1f7", borderRadius: 12, padding: "10px 12px", background: "#fff", fontSize: 13 }}>
                  <span>{label}</span>
                  <strong>{Number(value || 0)}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {offboardPreview ? (
          <div style={{ marginTop: 16, border: "1px solid #edf1f7", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "start" }}>
              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Department coverage summary</div>
                <div style={{ fontSize: 14, marginTop: 6, opacity: 0.84, lineHeight: 1.6 }}>
                  Confirms the selected transfer scope across Sales, Marketing, Purchase, Accounts, Factory, Stores, and Service before you deactivate the user.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ padding: "6px 12px", borderRadius: 999, background: "#eef4ff", color: "#234a8f", fontSize: 12, fontWeight: 800 }}>
                  Reportees to reassign: {offboarding.reassignReportees ? Number(offboardPreview.reporteesToReassign || 0) : 0}
                </span>
                {offboarding.transferApprovalChains ? (
                  <span style={{ padding: "6px 12px", borderRadius: 999, background: "#f6f7fb", color: "#111827", fontSize: 12, fontWeight: 800 }}>
                    Approval chains: {Number(offboardPreview.approvalChains || 0)}
                  </span>
                ) : null}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
              {coverageGroups.map((group) => {
                const selectedItems = group.items.filter((item) => item.selected);
                const selectedCount = selectedItems.reduce((sum, item) => sum + Number(item.count || 0), 0);
                return (
                  <div key={group.title} style={{ border: "1px solid #e3e8f2", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{group.title}</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "#234a8f" }}>{selectedCount}</div>
                    </div>
                    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                      {group.items.map((item) => (
                        <div
                          key={item.label}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 12,
                            fontSize: 13,
                            opacity: item.selected ? 0.92 : 0.46,
                          }}
                        >
                          <div>{item.label}</div>
                          <div style={{ fontWeight: 800 }}>{item.selected ? Number(item.count || 0) : 0}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {offboardResult ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
            <StatCard label="Leads" value={offboardResult.leads} note="lead ownership moved" accent="#1f5eff" />
            <StatCard label="Quotes" value={offboardResult.quotes} note="open quote ownership moved" accent="#8b5cf6" />
            <StatCard label="Sales Orders" value={offboardResult.salesOrders} note="open SO ownership moved" accent="#14804a" />
            <StatCard label="Job Cards" value={offboardResult.jobCards} note="open job ownership moved" accent="#d97706" />
            <StatCard label="Requisitions" value={offboardResult.purchaseRequisitions} note="open PRQ ownership moved" accent="#7c3aed" />
            <StatCard label="Dispatches" value={offboardResult.dispatches} note="dispatch ownership moved" accent="#0f766e" />
            <StatCard label="Invoices" value={offboardResult.customerInvoices} note="invoice ownership moved" accent="#1d4ed8" />
            <StatCard label="GRN" value={offboardResult.goodsReceipts} note="GRN ownership moved" accent="#7c2d12" />
            <StatCard label="QC" value={offboardResult.qualityControls} note="QC ownership moved" accent="#b45309" />
            <StatCard label="Claims" value={offboardResult.supplierClaims} note="claim ownership moved" accent="#6d28d9" />
            <StatCard label="Claim Rcpts" value={offboardResult.supplierClaimReceipts} note="claim receipt ownership moved" accent="#9333ea" />
            <StatCard label="Purchase Returns" value={offboardResult.purchaseReturns} note="return ownership moved" accent="#be123c" />
            <StatCard label="Sales Returns" value={offboardResult.salesReturns} note="return ownership moved" accent="#9f1239" />
            <StatCard label="Purchase Orders" value={offboardResult.purchaseOrders} note="PO ownership moved" accent="#0f766e" />
            <StatCard label="Purchase Invoices" value={offboardResult.purchaseInvoices} note="purchase invoice ownership moved" accent="#155e75" />
            <StatCard label="Vendor Payments" value={offboardResult.vendorPayments} note="vendor payment ownership moved" accent="#0c4a6e" />
            <StatCard label="Cust Receipts" value={offboardResult.customerReceipts} note="customer receipt ownership moved" accent="#1e40af" />
            <StatCard label="Bank Book" value={offboardResult.financeEntries} note="finance entry ownership moved" accent="#4338ca" />
            <StatCard label="Stock Adjust" value={offboardResult.stockAdjustments} note="adjustment ownership moved" accent="#92400e" />
            <StatCard label="Stock Transfers" value={offboardResult.stockTransfers} note="transfer ownership moved" accent="#7c2d12" />
            <StatCard label="Service Cases" value={offboardResult.serviceCases} note="service case ownership moved" accent="#166534" />
            <StatCard label="AMC Contracts" value={offboardResult.amcContracts} note="AMC ownership moved" accent="#365314" />
            {offboarding.transferApprovalChains ? (
              <StatCard label="Approval chains" value={offboardResult.approvalChains} note="pending submit/approve/prepared reassigned" accent="#111827" />
            ) : null}
            <StatCard label="Reportees" value={offboardResult.reporteesReassigned} note="users re-linked to replacement" accent="#b91c1c" />
          </div>
        ) : null}

        {offboarding.transferApprovalChains && offboardResult?.approvalChains > 0 ? (
          <div style={{ marginTop: 14, border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Approval chain breakdown</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 10 }}>
              {approvalBreakdownEntries(offboardResult.approvalChainBreakdown).map(([label, value]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, border: "1px solid #edf1f7", borderRadius: 12, padding: "10px 12px", background: "#fff", fontSize: 13 }}>
                  <span>{label}</span>
                  <strong>{Number(value || 0)}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 16, border: "1px solid #f3d4d4", borderRadius: 16, padding: 14, background: "#fff7f7", fontSize: 13, color: "#8a1c1c", lineHeight: 1.7 }}>
          This flow deactivates the source user at the end. Historical actions remain intact, but queue ownership and manager links move to the replacement user you choose here.
        </div>
      </SurfaceCard>
    );
  }

  function renderOffboardingAuditMigrationWarning() {
    if (offboardingAuditsReady) return null;
    return (
      <div style={{ border: "1px solid #f3d4d4", borderRadius: 16, padding: 14, background: "#fff7f7", color: "#8a1c1c", marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 900 }}>Offboarding audit migration required</div>
        <div style={{ fontSize: 13, opacity: 0.86, marginTop: 8, lineHeight: 1.6 }}>
          Apply the migration for <strong>offboarding_audits</strong> before running Transfer + Deactivate. Preview is safe to run, but offboarding will be blocked until this is applied.
        </div>
        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.86 }}>
          SQL file: <strong>server/db/migrations/067_offboarding_audits_v1.sql</strong>
        </div>
        <pre style={{ marginTop: 10, marginBottom: 0, whiteSpace: "pre-wrap", fontSize: 12, background: "#fff", border: "1px solid #f2caca", borderRadius: 12, padding: 10, color: "#4c0d0d" }}>
{`docker exec -i josh-postgres psql -U josh -d josh -v ON_ERROR_STOP=1 < server/db/migrations/067_offboarding_audits_v1.sql
docker compose -f docker-compose.prod.yml up -d --build`}
        </pre>
      </div>
    );
  }

  function renderAuditViewer() {
    const auditSummary = getAuditSummary(auditRowsQuickFiltered);
    return (
      <SurfaceCard
        title="Offboarding audit viewer"
        subtitle="Review who offboarded whom, when it happened, and the before/after movement counts captured at execution time."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={auditQuery}
              onChange={(e) => setAuditQuery(e.target.value)}
              placeholder="Search by offboarded user, replacement, or actor"
              style={{ minWidth: 320 }}
              disabled={!offboardingAuditsReady}
            />
            <input type="date" value={auditDateFrom} onChange={(e) => setAuditDateFrom(e.target.value)} disabled={!offboardingAuditsReady} />
            <input type="date" value={auditDateTo} onChange={(e) => setAuditDateTo(e.target.value)} disabled={!offboardingAuditsReady} />
            <button type="button" onClick={() => loadOffboardingAudits().catch(() => {})} disabled={auditLoading || !offboardingAuditsReady}>
              {auditLoading ? "Loading..." : "Search"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAuditQuery("");
                setAuditDateFrom("");
                setAuditDateTo("");
                setAuditQuickFilter("all");
                loadOffboardingAudits("", "", "").catch(() => {});
              }}
              disabled={auditLoading || !offboardingAuditsReady}
            >
              Reset
            </button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: 12 }}>
          {!offboardingAuditsReady ? (
            renderOffboardingAuditMigrationWarning()
          ) : null}
          {offboardingAuditsReady && auditRows.length ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Quick filters</span>
                {auditQuickFilters.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setAuditQuickFilter(item.key)}
                    disabled={auditLoading}
                    style={{
                      borderRadius: 999,
                      padding: "6px 12px",
                      border: auditQuickFilter === item.key ? "1px solid #96b5ff" : "1px solid #dfe5ef",
                      background: auditQuickFilter === item.key ? "linear-gradient(180deg, #eef4ff 0%, #f8fbff 100%)" : "#fff",
                      fontSize: 12,
                      fontWeight: 800,
                      color: "#111827",
                      cursor: auditLoading ? "not-allowed" : "pointer",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
                {auditQuickFilter !== "all" ? (
                  <span style={{ fontSize: 12, opacity: 0.72 }}>
                    Showing {auditRowsQuickFiltered.length} of {auditRows.length}
                  </span>
                ) : null}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12 }}>
                <StatCard label="Audit Events" value={auditSummary.auditCount} note="rows in the current filter" accent="#1f5eff" />
                <StatCard label="Users Offboarded" value={auditSummary.offboardedUsers} note="distinct source users affected" accent="#14804a" />
                <StatCard label="Work Items Moved" value={auditSummary.totalMovedItems} note="ownership transfers across live queues" accent="#d97706" />
                <StatCard label="Approval Handoffs" value={auditSummary.totalApprovalChainsMoved} note="pending workflow reassignment captured" accent="#111827" />
                <StatCard label="Reportees Rehomed" value={auditSummary.totalReporteesMoved} note="manager links moved to replacement users" accent="#b91c1c" />
              </div>

              <div style={{ border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "start" }}>
                  <div>
                    <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Movement coverage summary</div>
                    <div style={{ fontSize: 14, marginTop: 6, opacity: 0.82, lineHeight: 1.6 }}>
                      Aggregates the currently filtered audit history into the same department buckets used during preview, so SuperAdmin can spot where exits are concentrating.
                    </div>
                  </div>
                  <div style={{ padding: "6px 12px", borderRadius: 999, background: "#eef4ff", color: "#234a8f", fontSize: 12, fontWeight: 800 }}>
                    Replacement users involved: {auditSummary.replacementUsers}
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
                  {auditSummary.departmentTotals.map((group) => (
                    <div key={group.title} style={{ border: "1px solid #e3e8f2", borderRadius: 14, padding: 12, background: "#fff" }}>
                      <div style={{ fontSize: 13, fontWeight: 800 }}>{group.title}</div>
                      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>{group.total}</div>
                      <div style={{ fontSize: 12, opacity: 0.68, marginTop: 6 }}>moved items in this filtered history</div>
                    </div>
                  ))}
                </div>

                {auditSummary.topModules.length ? (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 10 }}>Top moved scopes</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {auditSummary.topModules.map(([label, value]) => (
                        <span key={label} style={{ padding: "6px 12px", borderRadius: 999, background: "#fff", border: "1px solid #dfe5ef", color: "#111827", fontSize: 12, fontWeight: 800 }}>
                          {label}: {value}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          {auditRowsQuickFiltered.length ? (
            auditRowsQuickFiltered.map((row) => {
              const chips = getAuditMovementChips(row);
              const approvalBreakdown = getAuditApprovalBreakdown(row);
              const approvalBreakdownTotal = approvalBreakdownEntries(approvalBreakdown).reduce((sum, [, value]) => sum + Number(value || 0), 0);
              const approvalSummaryChips = approvalBreakdownEntries(approvalBreakdown).filter(([, value]) => Number(value || 0) > 0);
              return (
              <details key={row.id} style={{ border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: "#fbfcff" }}>
                <summary style={{ cursor: "pointer", display: "grid", gap: 8 }}>
                  <strong>#{row.id} • {row.offboarded_user_name || row.offboarded_user_email || "Unknown user"} → {row.replacement_user_name || row.replacement_user_email || "Unknown replacement"}</strong>
                  <span style={{ fontSize: 12, opacity: 0.72 }}>
                    By {row.performed_by_name || row.performed_by_email || "Unknown"} • {row.created_at ? new Date(row.created_at).toLocaleString() : "Unknown time"}
                  </span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {chips.length ? (
                      chips.map((chip) => (
                        <span key={chip.key} style={{ padding: "4px 10px", borderRadius: 999, background: "#eef4ff", color: "#234a8f", fontSize: 12, fontWeight: 700 }}>
                          {chip.label}: {chip.value}
                        </span>
                      ))
                    ) : (
                      <span style={{ padding: "4px 10px", borderRadius: 999, background: "#f6f7fb", color: "#58627a", fontSize: 12, fontWeight: 700 }}>
                        No moved counts recorded
                      </span>
                    )}
                  </div>
                  {approvalBreakdownTotal > 0 ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {approvalSummaryChips.map(([label, value]) => (
                        <span key={label} style={{ padding: "4px 10px", borderRadius: 999, background: "#f6f7fb", color: "#111827", fontSize: 12, fontWeight: 700 }}>
                          {label}: {Number(value || 0)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </summary>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                  <button type="button" onClick={() => openAuditUser(row.offboarded_user_id)}>
                    Open Offboarded User
                  </button>
                  <button type="button" onClick={() => openAuditUser(row.replacement_user_id)}>
                    Open Replacement User
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError("");
                      setNotice("");
                      try {
                        const payload = buildAuditExportPayload(row);
                        downloadJsonFile(`offboarding_audit_${row.id || "unknown"}.json`, payload);
                        setNotice(`Audit #${row.id} downloaded.`);
                      } catch (e) {
                        setError("Failed to export audit JSON.");
                      }
                    }}
                  >
                    Download JSON
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setError("");
                      setNotice("");
                      try {
                        const payload = buildAuditExportPayload(row);
                        await copyTextToClipboard(JSON.stringify(payload, null, 2));
                        setNotice(`Audit #${row.id} copied.`);
                      } catch (e) {
                        setError("Failed to copy audit JSON.");
                      }
                    }}
                  >
                    Copy JSON
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
                  <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ fontSize: 12, opacity: 0.62, marginBottom: 8 }}>Scopes</div>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(row.scopes || {}, null, 2)}</pre>
                  </div>
                  <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ fontSize: 12, opacity: 0.62, marginBottom: 8 }}>Before Counts</div>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(row.before_counts || {}, null, 2)}</pre>
                  </div>
                  <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ fontSize: 12, opacity: 0.62, marginBottom: 8 }}>After / Moved</div>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify({ after_counts: row.after_counts || {}, moved_counts: row.moved_counts || {} }, null, 2)}</pre>
                  </div>
                </div>
                {approvalBreakdownTotal > 0 ? (
                  <div style={{ marginTop: 14, border: "1px solid #e3e8f2", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ fontSize: 12, opacity: 0.62, marginBottom: 10 }}>Approval Chain Breakdown</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                      {approvalBreakdownEntries(approvalBreakdown).map(([label, value]) => (
                        <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, border: "1px solid #edf1f7", borderRadius: 12, padding: "10px 12px", background: "#fbfcff", fontSize: 13 }}>
                          <span>{label}</span>
                          <strong>{Number(value || 0)}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </details>
            );
            })
          ) : (
            <div style={{ padding: 12, opacity: 0.72 }}>
              {offboardingAuditsReady ? (auditLoading ? "Loading audit history..." : auditRows.length ? "No audits match the current quick filter." : "No offboarding audits found yet.") : "Audit history is unavailable until the migration is applied."}
            </div>
          )}
        </div>
      </SurfaceCard>
    );
  }

  return (
    <div style={{ maxWidth: 1320, width: "100%", minWidth: 0, display: "grid", gap: 16 }}>
      <section
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 24,
          padding: view === "orgchart" ? 16 : 22,
          background: "linear-gradient(135deg, #f7fbff 0%, #ffffff 58%, #f9fbff 100%)",
          boxShadow: "0 18px 42px rgba(25, 37, 61, 0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Org and access</div>
            <h2 style={{ margin: "8px 0 0", fontSize: view === "orgchart" ? 24 : 32, lineHeight: 1.15 }}>
              {view === "orgchart"
                ? "Click a person to govern identity, screens, and authority."
                : "Org chart first — click a person to govern identity, screens, and authority."}
            </h2>
            {view === "orgchart" ? null : (
              <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.76, maxWidth: 760, lineHeight: 1.7 }}>
                Hierarchy is the primary surface. Transfer, offboarding, and the classic directory remain available as supporting lanes.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {headerChips.map((chip) => (
                <HeaderChip key={chip.label} {...chip} />
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={startNew}>
              New User
            </button>
            <button type="button" onClick={() => refreshAll().catch(() => {})} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>
      </section>

      {view === "orgchart" ? null : (
        <>
          <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
            {stats.map((item) => (
              <StatCard key={item.label} {...item} />
            ))}
          </section>

          {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
          {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}

          <section style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 16 }}>
            <SurfaceCard title="Fix Now" subtitle="Use the user governance lane that best matches the operational issue in front of you.">
              <div style={{ display: "grid", gap: 10 }}>
                {userFocusActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={action.onClick}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      borderRadius: 18,
                      border: "1px solid #dfe5ef",
                      padding: "14px 16px",
                      background: "#fff",
                      boxShadow: "0 10px 22px rgba(15, 23, 42, 0.05)",
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <strong style={{ fontSize: 14, color: action.tone }}>{action.label}</strong>
                    <span style={{ fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>{action.note}</span>
                  </button>
                ))}
              </div>
            </SurfaceCard>

            <SurfaceCard title="Governance Alerts" subtitle="Keep structural user issues visible before they turn into access drift or offboarding misses.">
              <div style={{ display: "grid", gap: 10 }}>
                {governanceAlerts.map((note) => (
                  <div key={note} style={{ borderRadius: 16, border: "1px solid #dfe5ef", padding: 12, background: "#fff" }}>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>{note}</div>
                  </div>
                ))}
              </div>
            </SurfaceCard>
          </section>
        </>
      )}

      {view === "orgchart" && (error || notice) ? (
        <div>
          {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
          {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}
        </div>
      ) : null}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 12 }}>
        <ViewButton active={view === "orgchart"} label="Org Chart" note="Primary surface. Click a node to open identity, screens, and authority." onClick={() => setView("orgchart")} />
        {accessV2 ? (
          <>
            <ViewButton active={view === "directory"} label="Directory" note="Search people and open their identity, access and authority in one editor." onClick={() => setView("directory")} />
            <ViewButton active={view === "add"} label="Add Person" note="Identity, org placement, access profile and exceptions in one save." onClick={() => setView("add")} />
          </>
        ) : (
          <>
            <ViewButton active={view === "directory"} label="Directory + Editor" note="Search and open users quickly, then edit on the same screen." onClick={() => setView("directory")} />
            <ViewButton active={view === "editor"} label="Focused Editor" note="Jump straight into user creation or a selected-user edit session." onClick={() => setView("editor")} />
          </>
        )}
        <ViewButton active={view === "transfer"} label="Transfer Work" note="Move open work from one user to another with a dedicated control panel." onClick={() => setView("transfer")} />
        <ViewButton active={view === "offboarding"} label="Guided Offboarding" note="Transfer work, reassign reportees, and deactivate the user in one flow." onClick={() => setView("offboarding")} />
        <ViewButton active={view === "audit"} label="Audit Viewer" note="Review offboarding history with before/after movement snapshots." onClick={() => setView("audit")} />
      </section>

      {view === "audit" ? (
        renderAuditViewer()
      ) : view === "offboarding" ? (
        renderOffboardingDesk()
      ) : view === "transfer" ? (
        renderTransferDesk()
      ) : view === "add" && accessV2 ? (
        <SurfaceCard title="Add person" subtitle="One page, one save: identity, companies, access profile and any exceptions are created together.">
          <AddPerson
            bootstrap={{ roles, departments, companies, designations, managers }}
            onCancel={() => setView("orgchart")}
            onCreated={async (user) => {
              await refreshAll().catch(() => {});
              setView("orgchart");
              setNotice(`${user?.full_name || "Person"} created.`);
              if (user?.id) openGovernance(user, "access");
            }}
          />
        </SurfaceCard>
      ) : (view === "directory" || view === "editor") && accessV2 ? (
        renderDirectory()
      ) : view === "orgchart" ? (
        <SurfaceCard
          title="Organization chart"
          subtitle="Printable hierarchy from primary manager links. Click a person to open the governance drawer."
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={includeInactiveInChart} onChange={(e) => setIncludeInactiveInChart(e.target.checked)} />
                Show inactive
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={showLonelyRoots} onChange={(e) => setShowLonelyRoots(e.target.checked)} />
                Show lonely roots
              </label>
              <button type="button" onClick={startNew}>
                New User
              </button>
              <button type="button" onClick={() => refreshAll().catch(() => {})} disabled={loading}>
                Refresh
              </button>
            </div>
          }
        >
          <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
            <OrgChart
              users={users}
              selectedUserId={governanceUserId}
              includeInactive={includeInactiveInChart}
              hideLonelyRoots={!showLonelyRoots}
              onSelectUser={(user, tab) => openGovernance(user, tab || "identity")}
              accessV2={accessV2}
            />
          </div>
        </SurfaceCard>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: view === "editor" ? "0.72fr 1.28fr" : "0.85fr 1.15fr", gap: 16 }}>
          {renderDirectory()}
          {renderEditor()}
        </div>
      )}

      <UserGovernanceDrawer
        open={governanceOpen}
        onClose={() => setGovernanceOpen(false)}
        userId={governanceUserId}
        initialTab={governanceInitialTab}
        bootstrap={{ groups, roles, distributors, managers, departments, companies, designations }}
        onSaved={async () => {
          await refreshAll().catch(() => {});
        }}
        onOpenAccessPreview={(userId) => {
          if (typeof onNavigate === "function") {
            onNavigate("user_access_preview", {
              resetQuote: true,
              adminLaunch: { userId, focusLane: "all" },
            });
          }
        }}
      />

      <TypedConfirmModal
        open={offboardConfirmOpen}
        title="Transfer + deactivate user"
        message={`Offboard ${selectedOffboardFromUser?.full_name || selectedOffboardFromUser?.email || "selected user"} and transfer open work. Type OFFBOARD to continue.`}
        confirmPhrase="OFFBOARD"
        confirmLabel="Transfer + deactivate"
        busy={offboardBusy}
        onCancel={() => setOffboardConfirmOpen(false)}
        onConfirm={offboardUser}
      />
    </div>
  );
}
