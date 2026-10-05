import { useEffect, useMemo, useState } from "react";
import { buildReadinessSection, pickDangerFirstReadinessItems, pickReadinessItems } from "../shared/readinessWidgetRegistry";
import { DeskTopStrip } from "../shared/joshUi";

const LAST_READINESS_DRILLDOWN_KEY = "josh-last-readiness-drilldown";
const GO_LIVE_CHECKLIST_KEY = "josh-absstem-go-live-checklist-v1";

const GO_LIVE_CHECKLIST_ITEMS = [
  {
    id: "company_profiles",
    label: "AI and AT company profiles complete (GST, bank, logo, signature)",
    source: "live",
    page: "admin_masters",
    launch: { activeSection: "company" },
  },
  {
    id: "commercial_masters",
    label: "Commercial masters baseline (incoterms, payment, freight, tax, lead sources)",
    source: "live",
    page: "admin_masters",
    launch: { activeSection: "commercial" },
  },
  {
    id: "templates_stack",
    label: "Templates stack ready (letterhead, cover letter, quote terms per company)",
    source: "live",
    page: "templates",
    launch: { focus: "company_docs" },
  },
  {
    id: "purchase_approvals",
    label: "Purchase approval bands covered (PO / GRN / PI as used)",
    source: "live",
    page: "users",
    launch: { view: "orgchart" },
    caption: "Ceilings in Org & access; emergency bands via deep-link matrix only",
  },
  {
    id: "role_rights",
    label: "Org & access reviewed for pilot desks (identity, screens, authority)",
    source: "live",
    page: "users",
    launch: { view: "orgchart" },
  },
  {
    id: "access_preview",
    label: "Access Preview run for each pilot user before go-live",
    source: "live_or_manual",
    page: "user_access_preview",
    launch: { focusLane: "all" },
  },
  {
    id: "business_admin",
    label: "Business Admin role granted Admin Masters + Templates (not full SuperAdmin)",
    source: "manual",
    page: "users",
    launch: { view: "directory" },
  },
  {
    id: "pilot_users",
    label: "Pilot users onboarded with correct company + hierarchy",
    source: "live_or_manual",
    page: "users",
    launch: { view: "orgchart" },
  },
];

async function fetchJsonOrNull(path) {
  try {
    const response = await fetch(path, { credentials: "include" });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

function loadLastReadinessDrilldown() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_READINESS_DRILLDOWN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLastReadinessDrilldown(value) {
  if (typeof window === "undefined") return;
  try {
    if (!value) {
      window.localStorage.removeItem(LAST_READINESS_DRILLDOWN_KEY);
      return;
    }
    window.localStorage.setItem(LAST_READINESS_DRILLDOWN_KEY, JSON.stringify(value));
  } catch {
  }
}

function loadGoLiveChecklist() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(GO_LIVE_CHECKLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveGoLiveChecklist(value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GO_LIVE_CHECKLIST_KEY, JSON.stringify(value || {}));
  } catch {
  }
}

async function fetchGoLiveChecklistFromServer() {
  try {
    const res = await fetch("/api/admin/go-live-checklist", { credentials: "include" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return null;
    const items = data.checklist?.items_json;
    return items && typeof items === "object" ? items : {};
  } catch {
    return null;
  }
}

async function persistGoLiveChecklistToServer(items) {
  try {
    await fetch("/api/admin/go-live-checklist", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items || {} }),
    });
  } catch {
    /* localStorage remains fallback */
  }
}

function metricCardStyle(accent) {
  return {
    border: "1px solid #dfe5ef",
    borderRadius: 18,
    padding: 16,
    background: "#fff",
    boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
    borderTop: `4px solid ${accent}`,
  };
}

function groupCardStyle() {
  return {
    border: "1px solid #dfe5ef",
    borderRadius: 22,
    padding: 18,
    background: "linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)",
    boxShadow: "0 18px 42px rgba(25, 37, 61, 0.08)",
  };
}

function ActionCard({ title, body, actions, tone = "#1f5eff" }) {
  return (
    <div
      style={{
        border: "1px solid #dfe5ef",
        borderRadius: 20,
        padding: 18,
        background: "#fff",
        boxShadow: "0 14px 34px rgba(25, 37, 61, 0.07)",
      }}
    >
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Admin cluster</div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{title}</div>
      <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6 }}>{body}</div>
      <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
        {actions.map((item) => (
          <button
            key={item.page}
            type="button"
            onClick={item.onClick}
            style={{
              all: "unset",
              cursor: "pointer",
              border: "1px solid #e3e8f2",
              borderLeft: `4px solid ${tone}`,
              borderRadius: 14,
              padding: "12px 14px",
              background: "#fbfcff",
              display: "grid",
              gap: 4,
            }}
          >
            <strong style={{ fontSize: 14 }}>{item.label}</strong>
            <span style={{ fontSize: 12, opacity: 0.72 }}>{item.caption}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ label, tone, background }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        color: tone,
        background,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

export default function SuperAdminHome({ onNavigate }) {
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [lastDrilldown, setLastDrilldown] = useState(() => loadLastReadinessDrilldown());
  const [goLiveChecks, setGoLiveChecks] = useState(() => loadGoLiveChecklist());
  const [goLiveServerReady, setGoLiveServerReady] = useState(false);
  const [showOpsPulse, setShowOpsPulse] = useState(false);
  const [pilotFeedbackSummary, setPilotFeedbackSummary] = useState(null);
  const [storesPendingSummary, setStoresPendingSummary] = useState(null);
  const [storesShortageSummary, setStoresShortageSummary] = useState(null);
  const [manufacturingDashboard, setManufacturingDashboard] = useState(null);
  const [setupSnapshot, setSetupSnapshot] = useState({
    admin: null,
    templates: null,
    globalLetterhead: null,
    coverLetter: null,
    quoteTerms: null,
    approval: null,
    users: null,
    companyDocuments: [],
  });

  useEffect(() => {
    fetchGoLiveChecklistFromServer().then((items) => {
      if (!items) return;
      setGoLiveServerReady(true);
      setGoLiveChecks(items);
      saveGoLiveChecklist(items);
    });
  }, []);

  useEffect(() => {
    setOperationsLoading(true);
    Promise.all([
      fetch("/manufacturing-boms/bootstrap", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/job-cards/stores-pending-summary", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/job-cards/stores-shortage-dashboard", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
      fetchJsonOrNull("/hr/pilot-feedback/summary"),
    ])
      .then(([manufacturingData, pendingData, shortageData, feedbackData]) => {
        if (manufacturingData?.dashboard) setManufacturingDashboard(manufacturingData.dashboard || null);
        if (pendingData?.ok) setStoresPendingSummary(pendingData.summary || null);
        if (shortageData?.ok) setStoresShortageSummary(shortageData.summary || null);
        if (feedbackData?.ok) setPilotFeedbackSummary(feedbackData.summary || null);
      })
      .catch(() => {})
      .finally(() => setOperationsLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSetupSnapshot() {
      setSetupLoading(true);
      try {
        const [admin, templates, globalLetterhead, coverLetter, quoteTerms, approval, users] = await Promise.all([
          fetchJsonOrNull("/admin-masters/bootstrap"),
          fetchJsonOrNull("/templates/admin-data"),
          fetchJsonOrNull("/templates/letterhead/global"),
          fetchJsonOrNull("/templates/quote-cover-letter"),
          fetchJsonOrNull("/templates/quote-terms"),
          fetchJsonOrNull("/approval-policies/bootstrap"),
          fetchJsonOrNull("/users/bootstrap"),
        ]);

        const companyRows =
          (Array.isArray(templates?.companies) && templates.companies.length ? templates.companies : null) ||
          (Array.isArray(users?.companies) ? users.companies : []);

        const companyDocuments = await Promise.all(
          companyRows.map(async (company) => {
            const companyId = company?.id || company?.company_id;
            const [letterheadData, coverData, termsData] = await Promise.all([
              fetchJsonOrNull(`/templates/letterhead/company/${companyId}`),
              fetchJsonOrNull(`/templates/quote-cover-letter?company_id=${encodeURIComponent(companyId)}`),
              fetchJsonOrNull(`/templates/quote-terms?company_id=${encodeURIComponent(companyId)}`),
            ]);

            return {
              company_id: companyId,
              company_code: company?.company_code || company?.code || `C${companyId}`,
              display_name: company?.display_name || company?.legal_name || company?.company_name || company?.company_code || `Company ${companyId}`,
              has_letterhead: Boolean(letterheadData?.template?.file_name),
              has_cover_letter: Boolean(String(coverData?.template?.template_body || "").trim()),
              has_quote_terms: Boolean(String(termsData?.template?.template_body || "").trim()),
            };
          })
        );

        if (cancelled) return;
        setSetupSnapshot({
          admin,
          templates,
          globalLetterhead,
          coverLetter,
          quoteTerms,
          approval,
          users,
          companyDocuments,
        });
      } catch {
      } finally {
        if (!cancelled) setSetupLoading(false);
      }
    }

    loadSetupSnapshot();
    return () => {
      cancelled = true;
    };
  }, []);

  function openStoresDesk(storesShortageBucket = "all") {
    onNavigate("job_cards", {
      resetQuote: true,
      jobCardsLaunch: { panel: "stores", storesShortageBucket },
    });
  }

  function openManufacturingDesk() {
    onNavigate("manufacturing_boms", { resetQuote: true });
  }

  function openAdminDesk(page, adminLaunch = {}, label = "") {
    const companies = Array.isArray(setupSnapshot.users?.companies) ? setupSnapshot.users.companies : Array.isArray(setupSnapshot.templates?.companies) ? setupSnapshot.templates.companies : [];
    const companyRow = companies.find((item) => String(item.id || item.company_id) === String(adminLaunch.companyId || adminLaunch.textCompanyId || ""));
    const resolvedLabel =
      label ||
      (page === "admin_masters"
        ? `Admin Masters${adminLaunch.selectedMasterKey ? ` / ${adminLaunch.selectedMasterKey}` : adminLaunch.activeSection ? ` / ${adminLaunch.activeSection}` : ""}`
        : page === "templates"
          ? `Templates${companyRow ? ` / ${companyRow.company_code || companyRow.display_name || companyRow.company_name}` : adminLaunch.focus === "global_text" ? " / Global text" : ""}`
          : page === "users"
            ? `Org & access${companyRow ? ` / ${companyRow.company_code || companyRow.company_name}` : ""}${adminLaunch.view ? ` / ${adminLaunch.view}` : ""}`
            : page === "approval_policy_matrix"
              ? `Approval Matrix${adminLaunch.docType ? ` / ${adminLaunch.docType}` : ""}`
              : page === "user_access_preview"
                ? `User Access Preview${adminLaunch.userId ? ` / User ${adminLaunch.userId}` : adminLaunch.focusLane ? ` / ${adminLaunch.focusLane}` : ""}`
                : page);
    const record = {
      page,
      adminLaunch,
      label: resolvedLabel,
      saved_at: new Date().toISOString(),
    };
    setLastDrilldown(record);
    saveLastReadinessDrilldown(record);
    onNavigate(page, {
      resetQuote: true,
      adminLaunch,
    });
  }

  function reopenLastDrilldown() {
    if (!lastDrilldown?.page) return;
    onNavigate(lastDrilldown.page, {
      resetQuote: true,
      adminLaunch: lastDrilldown.adminLaunch || {},
    });
  }

  const goLiveLiveStatus = useMemo(() => {
    const admin = setupSnapshot.admin || {};
    const users = setupSnapshot.users || {};
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    const companyProfiles = Array.isArray(admin.company_profiles) ? admin.company_profiles : [];
    const companies = Array.isArray(users.companies) ? users.companies : [];
    const missingCommercialMasters = [
      !Array.isArray(admin.incoterms) || !admin.incoterms.length,
      !Array.isArray(admin.payment_terms) || !admin.payment_terms.length,
      !Array.isArray(admin.freight_terms) || !admin.freight_terms.length,
      !Array.isArray(admin.tax_codes) || !admin.tax_codes.length,
      !Array.isArray(admin.lead_sources) || !admin.lead_sources.length,
    ].filter(Boolean).length;
    const approvalPolicies = Array.isArray(setupSnapshot.approval?.approval_policies) ? setupSnapshot.approval.approval_policies : [];
    const docTypes = Array.isArray(setupSnapshot.approval?.doc_types) ? setupSnapshot.approval.doc_types : [];
    const covered = new Set(approvalPolicies.filter((row) => row?.is_active !== false).map((row) => String(row.doc_type || "")));
    const uncovered = docTypes.filter((item) => !covered.has(String(item?.key || "")));
    const globalReady =
      Boolean(setupSnapshot.globalLetterhead?.template?.file_name) &&
      Boolean(String(setupSnapshot.coverLetter?.template?.template_body || "").trim()) &&
      Boolean(String(setupSnapshot.quoteTerms?.template?.template_body || "").trim());
    const companyDocsReady =
      companyDocuments.length > 0 &&
      companyDocuments.every((item) => item.has_letterhead && item.has_cover_letter && item.has_quote_terms);
    const roles = Array.isArray(users.roles) ? users.roles : [];
    const userGroups = Array.isArray(users.user_groups) ? users.user_groups : [];
    const departments = Array.isArray(users.departments) ? users.departments : [];
    const designations = Array.isArray(users.designations) ? users.designations : [];
    const health = users.access_health || {};
    const accessClear =
      Number(health.unapproved_count || 0) === 0 &&
      Number(health.zero_company_count || 0) === 0 &&
      Number(health.quotes_hidden_count || 0) === 0;

    return {
      company_profiles: companies.length > 0 && companyProfiles.length >= companies.length,
      commercial_masters: missingCommercialMasters === 0,
      templates_stack: globalReady && companyDocsReady,
      purchase_approvals: docTypes.length > 0 && uncovered.length === 0,
      role_rights: roles.length > 0 && userGroups.length > 0 && departments.length > 0 && designations.length > 0,
      access_preview: accessClear,
      pilot_users: accessClear && Number(users.active_user_count || users.users?.length || 0) > 0,
    };
  }, [setupSnapshot]);

  function isGoLiveItemDone(item) {
    const live = Boolean(goLiveLiveStatus[item.id]);
    const manual = Boolean(goLiveChecks[item.id]);
    if (item.source === "live") return live;
    if (item.source === "live_or_manual") return live || manual;
    return manual;
  }

  const goLiveDoneCount = GO_LIVE_CHECKLIST_ITEMS.filter((item) => isGoLiveItemDone(item)).length;

  function toggleGoLiveCheck(id) {
    const item = GO_LIVE_CHECKLIST_ITEMS.find((row) => row.id === id);
    if (!item || item.source === "live") return;
    setGoLiveChecks((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveGoLiveChecklist(next);
      persistGoLiveChecklistToServer(next);
      return next;
    });
  }

  function clearLastDrilldown() {
    setLastDrilldown(null);
    saveLastReadinessDrilldown(null);
  }

  const readinessSections = useMemo(() => {
    const admin = setupSnapshot.admin || {};
    const templates = setupSnapshot.templates || {};
    const approval = setupSnapshot.approval || {};
    const users = setupSnapshot.users || {};
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    const companyProfiles = Array.isArray(admin.company_profiles) ? admin.company_profiles : [];
    const vendors = Array.isArray(admin.vendors) ? admin.vendors : [];
    const userGroups = Array.isArray(users.user_groups) ? users.user_groups : [];
    const roles = Array.isArray(users.roles) ? users.roles : [];
    const departments = Array.isArray(users.departments) ? users.departments : [];
    const designations = Array.isArray(users.designations) ? users.designations : [];
    const companies = Array.isArray(users.companies) ? users.companies : [];
    const productGroups = Array.isArray(templates.product_groups) ? templates.product_groups : [];
    const approvalPolicies = Array.isArray(approval.approval_policies) ? approval.approval_policies : [];
    const docTypes = Array.isArray(approval.doc_types) ? approval.doc_types : [];
    const activePolicies = approvalPolicies.filter((row) => row?.is_active !== false);
    const policyCoveredDocTypes = new Set(activePolicies.map((row) => String(row.doc_type || "")));
    const companyFallbackId = companyDocuments[0]?.company_id || companies[0]?.id || companies[0]?.company_id || companyProfiles[0]?.company_id || "";
    const firstIncompleteCompany = companyDocuments.find((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms));
    const missingCommercialMasters = [
      !Array.isArray(admin.incoterms) || !admin.incoterms.length ? { label: "Incoterms", key: "incoterms" } : null,
      !Array.isArray(admin.payment_terms) || !admin.payment_terms.length ? { label: "Payment terms", key: "payment_terms" } : null,
      !Array.isArray(admin.freight_terms) || !admin.freight_terms.length ? { label: "Freight terms", key: "freight_terms" } : null,
      !Array.isArray(admin.tax_codes) || !admin.tax_codes.length ? { label: "Tax codes", key: "tax_codes" } : null,
      !Array.isArray(admin.lead_sources) || !admin.lead_sources.length ? { label: "Lead sources", key: "lead_sources" } : null,
    ].filter(Boolean);
    const uncoveredDocTypes = docTypes.filter((item) => !policyCoveredDocTypes.has(String(item?.key || "")));
    const globalDocumentReadyCount = [
      Boolean(setupSnapshot.globalLetterhead?.template?.file_name),
      Boolean(String(setupSnapshot.coverLetter?.template?.template_body || "").trim()),
      Boolean(String(setupSnapshot.quoteTerms?.template?.template_body || "").trim()),
    ].filter(Boolean).length;
    const fullyReadyCompanyDocuments = companyDocuments.filter((item) => item.has_letterhead && item.has_cover_letter && item.has_quote_terms);
    const missingCompanyDocuments = companyDocuments.filter((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms));
    const attentionItems = pickDangerFirstReadinessItems(
      [
        (!companies.length || !companyProfiles.length) && {
          title: "Company setup is incomplete",
          note: "At least one company profile is still missing, so desk-level setup can drift before operations scale.",
          tone: "danger",
          value: `${companyProfiles.length}/${companies.length || 0}`,
          actionLabel: "Open Admin Masters",
          onClick: () => openAdminDesk("admin_masters", { activeSection: "company", companyId: companyFallbackId }),
          badge: "Foundation",
        },
        !vendors.length && {
          title: "Vendor master is still empty",
          note: "Procurement and payables readiness will stall until supplier records are available in the shared master setup.",
          tone: "danger",
          value: "0",
          actionLabel: "Open Admin Masters",
          onClick: () => openAdminDesk("admin_masters", { activeSection: "vendors", companyId: companyFallbackId }),
          badge: "Procurement",
        },
        missingCommercialMasters.length > 0 && {
          title: "Commercial master coverage has gaps",
          note: `${missingCommercialMasters.slice(0, 3).map((item) => item.label).join(", ")}${missingCommercialMasters.length > 3 ? " and more" : ""} still need setup before the commercial flow is fully safe.`,
          tone: "warning",
          value: String(missingCommercialMasters.length),
          actionLabel: "Review Master Setup",
          onClick: () => openAdminDesk("admin_masters", { activeSection: "commercial", selectedMasterKey: missingCommercialMasters[0]?.key, companyId: companyFallbackId }),
          badge: "Masters",
        },
        (!setupSnapshot.globalLetterhead?.template?.file_name || !String(setupSnapshot.coverLetter?.template?.template_body || "").trim() || !String(setupSnapshot.quoteTerms?.template?.template_body || "").trim()) && {
          title: "Quote document assets are not fully ready",
          note: "Global letterhead, cover letter text, or quote terms text are still missing and can weaken issue readiness.",
          tone: "warning",
          value: `${globalDocumentReadyCount}/3`,
          actionLabel: "Open Templates",
          onClick: () => openAdminDesk("templates", { focus: "global_text", syncTextCompany: false }),
          badge: "Templates",
        },
        missingCompanyDocuments.length > 0 && {
          title: "Company-specific quote assets are incomplete",
          note: `${missingCompanyDocuments
            .slice(0, 3)
            .map((item) => item.company_code)
            .join(", ")}${missingCompanyDocuments.length > 3 ? " and other companies" : ""} still need letterhead, cover text, or quote terms alignment.`,
          tone: missingCompanyDocuments.length === companyDocuments.length ? "danger" : "warning",
          value: `${fullyReadyCompanyDocuments.length}/${companyDocuments.length || companies.length || 0}`,
          actionLabel: "Open Templates",
          onClick: () =>
            openAdminDesk("templates", {
              companyId: missingCompanyDocuments[0]?.company_id,
              textCompanyId: missingCompanyDocuments[0]?.company_id,
              focus: "company_docs",
            }),
          badge: "Company docs",
        },
        (!roles.length || !userGroups.length || !departments.length || !designations.length) && {
          title: "People governance setup is missing reference masters",
          note: "Roles, user groups, departments, and designations should all exist before user provisioning spreads further.",
          tone: "warning",
          value: `${roles.length}/${userGroups.length}/${departments.length}/${designations.length}`,
          actionLabel: "Open Org & access",
          onClick: () => openAdminDesk("users", { companyId: companyFallbackId, view: "directory" }),
          badge: "People",
        },
        uncoveredDocTypes.length > 0 && {
          title: "Purchase approval band coverage is incomplete",
          note: `${uncoveredDocTypes.slice(0, 2).map((item) => item?.label || item?.key).filter(Boolean).join(", ")}${uncoveredDocTypes.length > 2 ? " and other document types" : ""} still need an active purchase band. Set per-user ceilings in Org & access; use the emergency band matrix only for coverage/overlap fixes.`,
          tone: "warning",
          value: String(uncoveredDocTypes.length),
          actionLabel: "Open Org & access",
          onClick: () => openAdminDesk("users", { companyId: companyFallbackId, view: "orgchart" }, "Org & access / authority"),
          badge: "Approvals",
        },
        users.offboarding_audits_ready === false && {
          title: "Offboarding audit readiness is not enabled",
          note: "Transfer-and-deactivate governance is still blocked until the audit migration path is available in Org & access.",
          tone: "danger",
          actionLabel: "Open Org & access",
          onClick: () => openAdminDesk("users", { view: "offboarding", companyId: companyFallbackId }),
          badge: "Governance",
        },
        Number(users.access_health?.unapproved_count) > 0 && {
          title: "Users waiting for access approval",
          note: `${users.access_health.unapproved_count} active user(s) are still unapproved and cannot use desks.`,
          tone: "danger",
          value: String(users.access_health.unapproved_count),
          actionLabel: "Open Org & access",
          onClick: () => openAdminDesk("users", { view: "directory", companyId: companyFallbackId }, "Org & access / unapproved"),
          badge: "Access",
        },
        Number(users.access_health?.zero_company_count) > 0 && {
          title: "Users with zero company memberships",
          note: `${users.access_health.zero_company_count} active user(s) have no Works For company and will see empty desks.`,
          tone: "danger",
          value: String(users.access_health.zero_company_count),
          actionLabel: "Open Org & access",
          onClick: () => openAdminDesk("users", { view: "orgchart", companyId: companyFallbackId }, "Org & access / companies"),
          badge: "Access",
        },
        Number(users.access_health?.quotes_hidden_count) > 0 && {
          title: "Quotes screen is hidden for some users",
          note: `${users.access_health.quotes_hidden_count} approved user(s) cannot view Quotes — diagnose in Access Preview, fix exceptions in Org & access.`,
          tone: "warning",
          value: String(users.access_health.quotes_hidden_count),
          actionLabel: "Open Access Preview",
          onClick: () => openAdminDesk("user_access_preview", { focusLane: "blocked", companyId: companyFallbackId }, "Access Preview / blocked"),
          badge: "Access",
        },
      ].filter(Boolean)
    );
    const nextActionItems = pickReadinessItems(
      [
        {
          title: "Lock the master baseline first",
          note: "Confirm company profiles, vendors, and missing commercial masters before expanding desk usage.",
          tone: "neutral",
          actionLabel: "Open Admin Masters",
          onClick: () => openAdminDesk("admin_masters", { activeSection: missingCommercialMasters.length ? "commercial" : "company", selectedMasterKey: missingCommercialMasters[0]?.key, companyId: companyFallbackId }),
          badge: "Step 1",
        },
        {
          title: "Finish the quote document stack",
          note: "Keep global and company-level letterheads, cover letter text, quote terms, and product-group scope assets aligned from one desk.",
          tone: "neutral",
          actionLabel: "Open Templates",
          onClick: () =>
            openAdminDesk("templates", {
              companyId: missingCompanyDocuments[0]?.company_id || companyFallbackId,
              textCompanyId: missingCompanyDocuments[0]?.company_id || companyFallbackId,
              focus: "company_docs",
            }),
          badge: "Step 2",
        },
        {
          title: "Complete user and access governance",
          note: "Review hierarchy, role defaults, user-level exceptions, and effective visibility before new users scale further.",
          tone: "neutral",
          actionLabel: "Open Access Preview",
          onClick: () => openAdminDesk("user_access_preview", { companyId: companyFallbackId, focusLane: "exceptions" }, "Access Preview / exceptions"),
          badge: "Step 3",
        },
        {
          title: "Close approval-rule coverage",
          note: "Set per-user financial authority from the org chart drawer so purchase ceilings stay identity-scoped.",
          tone: "neutral",
          actionLabel: "Open Org & access",
          onClick: () => openAdminDesk("users", { companyId: companyFallbackId, view: "orgchart" }, "Org & access / authority"),
          badge: "Step 4",
        },
        companies.length > 1 && {
          title: "Review AI ↔ AT partner mappings",
          note: "Intercompany relationships should stay explicit as the two-company operating model hardens.",
          tone: "neutral",
          actionLabel: "Open Intercompany",
          onClick: () => onNavigate("intercompany_partners", { resetQuote: true }),
          badge: "Structure",
        },
        productGroups.length > 0 && {
          title: "Check product-group scope coverage",
          note: `${productGroups.length} product groups are available for scope-PDF governance and should be reviewed as setup stabilizes.`,
          tone: "success",
          value: String(productGroups.length),
          actionLabel: "Open Templates",
          onClick: () => openAdminDesk("templates", { selectedGroupId: productGroups[0]?.id }),
          badge: "Coverage",
        },
      ],
      4
    );

    const journeyItems = pickReadinessItems(
      [
        {
          title: "1. Lock master and company baseline",
          note: "Use Admin Masters first so company identity, vendor compliance, and commercial masters do not drift.",
          tone: "neutral",
          actionLabel: "Open Admin Masters",
          onClick: () =>
            openAdminDesk(
              "admin_masters",
              { activeSection: missingCommercialMasters.length ? "commercial" : "company", companyId: firstIncompleteCompany?.company_id || companyFallbackId },
              "Admin Masters / baseline"
            ),
          badge: "Foundation",
        },
        {
          title: "2. Finish document stack",
          note: "Then move to Templates to close letterhead, cover-letter, terms, and scope-PDF gaps.",
          tone: "neutral",
          actionLabel: "Open Templates",
          onClick: () =>
            openAdminDesk(
              "templates",
              {
                companyId: firstIncompleteCompany?.company_id || companyFallbackId,
                textCompanyId: firstIncompleteCompany?.company_id || companyFallbackId,
                focus: "company_docs",
              },
              "Templates / company docs"
            ),
          badge: "Documents",
        },
        {
          title: "3. Close approval routing",
          note: "Per-user financial authority should be settled in Org & access before transactions expand.",
          tone: "neutral",
          actionLabel: "Open Org & access",
          onClick: () =>
            openAdminDesk(
              "users",
              { companyId: companyFallbackId, view: "orgchart" },
              "Org & access / authority"
            ),
          badge: "Controls",
        },
        {
          title: "4. Verify user visibility",
          note: "Use Org & access for identity and screen overrides, then Access Preview to verify effective outcomes.",
          tone: "neutral",
          actionLabel: "Open Access Preview",
          onClick: () => openAdminDesk("user_access_preview", { focusLane: "changed" }, "Access Preview / changed"),
          badge: "Access",
        },
      ],
      4
    );

    return [
      buildReadinessSection({
        eyebrow: "What needs attention",
        title: "Operational setup risks",
        description: setupLoading
          ? "Loading the first readiness checks across setup, governance, templates, and approvals."
          : "See which foundational gaps are still blocking safe day-to-day operation before you dive into the detailed admin desks.",
        items: attentionItems,
        emptyMessage: setupLoading ? "Loading readiness checks..." : "Core setup, people governance, and document controls look materially ready from this first-pass scan.",
      }),
      buildReadinessSection({
        eyebrow: "Next actions",
        title: "SuperAdmin setup runbook",
        description: "Use the shortest path to move the platform from partially configured to operator-safe without changing existing desk flows.",
        items: nextActionItems,
        emptyMessage: "Next setup actions will appear here as more readiness signals become available.",
      }),
      buildReadinessSection({
        eyebrow: "Cross-desk journey",
        title: "Fix sequence",
        description: "Follow the admin desks in the order that produces the cleanest governance outcome with the least backtracking.",
        items: journeyItems,
        emptyMessage: "The cross-desk sequence will appear here once setup signals are available.",
      }),
    ];
  }, [onNavigate, setupLoading, setupSnapshot]);

  const summary = useMemo(() => {
    const attention = readinessSections[0]?.items || [];
    const actions = readinessSections[1]?.items || [];
    const journey = readinessSections[2]?.items || [];
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    const readyCompanyDocuments = companyDocuments.filter((item) => item.has_letterhead && item.has_cover_letter && item.has_quote_terms).length;
    const approvalPolicies = Array.isArray(setupSnapshot.approval?.approval_policies) ? setupSnapshot.approval.approval_policies : [];
    const docTypes = Array.isArray(setupSnapshot.approval?.doc_types) ? setupSnapshot.approval.doc_types : [];
    const activePolicyDocTypes = new Set(approvalPolicies.filter((row) => row?.is_active !== false).map((row) => String(row.doc_type || "")));
    const coveredDocTypes = docTypes.filter((item) => activePolicyDocTypes.has(String(item?.key || ""))).length;
    const admin = setupSnapshot.admin || {};
    const missingCommercialMasters = [
      !Array.isArray(admin.incoterms) || !admin.incoterms.length,
      !Array.isArray(admin.payment_terms) || !admin.payment_terms.length,
      !Array.isArray(admin.freight_terms) || !admin.freight_terms.length,
      !Array.isArray(admin.tax_codes) || !admin.tax_codes.length,
      !Array.isArray(admin.lead_sources) || !admin.lead_sources.length,
    ].filter(Boolean).length;
    const dangerCount = attention.filter((item) => item.tone === "danger").length;
    const warningCount = attention.filter((item) => item.tone === "warning").length;

    return [
      {
        label: "Attention now",
        value: setupLoading ? "…" : String(attention.length),
        note: setupLoading ? "readiness checks loading" : `${dangerCount} critical, ${warningCount} warning items active`,
        accent: dangerCount ? "#e30513" : warningCount ? "#d97706" : "#14804a",
      },
      {
        label: "Company docs ready",
        value: setupLoading ? "…" : `${readyCompanyDocuments}/${companyDocuments.length || 0}`,
        note: "letterhead + cover + terms aligned per company",
        accent: "#1f5eff",
      },
      {
        label: "Approval coverage",
        value: setupLoading ? "…" : `${coveredDocTypes}/${docTypes.length || 0}`,
        note: "document types with an active approval path",
        accent: "#8b5cf6",
      },
      {
        label: "Fix sequence",
        value: setupLoading ? "…" : `${journey.length}/4`,
        note: "cross-desk path ready for guided correction",
        accent: journey.length === 4 ? "#14804a" : "#1f5eff",
      },
    ];
  }, [readinessSections, setupLoading, setupSnapshot]);

  const topMetrics = useMemo(() => {
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    const firstMissingCompany = companyDocuments.find((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms));
    const companies = Array.isArray(setupSnapshot.users?.companies) ? setupSnapshot.users.companies : [];
    const companyFallbackId = firstMissingCompany?.company_id || companies[0]?.id || companies[0]?.company_id || null;
    return [
      {
        label: "Attention now",
        value: summary[0]?.value || "0",
        tone: summary[0]?.accent || "#e30513",
        note: summary[0]?.note || "Readiness checks",
        onClick: () => openAdminDesk("admin_masters", { activeSection: "company" }, "Admin Masters / attention"),
      },
      {
        label: "Company docs ready",
        value: summary[1]?.value || "0/0",
        tone: summary[1]?.accent || "#1f5eff",
        note: summary[1]?.note || "Company templates",
        onClick: () => openAdminDesk("templates", { companyId: firstMissingCompany?.company_id, textCompanyId: firstMissingCompany?.company_id, focus: "company_docs" }),
      },
      {
        label: "Approval coverage",
        value: summary[2]?.value || "0/0",
        tone: summary[2]?.accent || "#8b5cf6",
        note: summary[2]?.note || "Per-user authority via Org & access",
        onClick: () => openAdminDesk("users", { companyId: companyFallbackId, view: "orgchart" }, "Org & access / authority"),
      },
      {
        label: "Visibility checks",
        value: summary[3]?.value || "0/4",
        tone: summary[3]?.accent || "#1f5eff",
        note: summary[3]?.note || "Cross-desk sequence",
        onClick: () => openAdminDesk("user_access_preview", { focusLane: "changed" }, "Access Preview / changed"),
      },
    ];
  }, [summary, setupSnapshot.companyDocuments, setupSnapshot.users]);

  const deskScores = useMemo(() => {
    const admin = setupSnapshot.admin || {};
    const approval = setupSnapshot.approval || {};
    const users = setupSnapshot.users || {};
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    const companies = Array.isArray(users.companies) ? users.companies : [];
    const mastersChecks = [
      Array.isArray(admin.company_profiles) && admin.company_profiles.length > 0,
      Array.isArray(admin.vendors) && admin.vendors.length > 0,
      Array.isArray(admin.incoterms) && admin.incoterms.length > 0,
      Array.isArray(admin.payment_terms) && admin.payment_terms.length > 0,
      Array.isArray(admin.freight_terms) && admin.freight_terms.length > 0,
      Array.isArray(admin.tax_codes) && admin.tax_codes.length > 0,
      Array.isArray(admin.lead_sources) && admin.lead_sources.length > 0,
    ];
    const templateChecksTotal = 3 + companyDocuments.length * 3;
    const templateChecksReady =
      [setupSnapshot.globalLetterhead?.template?.file_name, String(setupSnapshot.coverLetter?.template?.template_body || "").trim(), String(setupSnapshot.quoteTerms?.template?.template_body || "").trim()].filter(Boolean).length +
      companyDocuments.reduce((sum, item) => sum + Number(item.has_letterhead) + Number(item.has_cover_letter) + Number(item.has_quote_terms), 0);
    const docTypes = Array.isArray(approval.doc_types) ? approval.doc_types : [];
    const activePolicies = Array.isArray(approval.approval_policies) ? approval.approval_policies.filter((row) => row?.is_active !== false) : [];
    const coveredDocTypes = new Set(activePolicies.map((row) => String(row.doc_type || "")));
    const approvalsReady = docTypes.filter((item) => coveredDocTypes.has(String(item?.key || ""))).length;
    const usersChecks = [
      Array.isArray(users.roles) && users.roles.length > 0,
      Array.isArray(users.user_groups) && users.user_groups.length > 0,
      Array.isArray(users.departments) && users.departments.length > 0,
      Array.isArray(users.designations) && users.designations.length > 0,
      companies.length > 0,
      users.offboarding_audits_ready !== false,
    ];
    const toPercent = (ready, total) => (total > 0 ? Math.round((ready / total) * 100) : 0);
    return [
      {
        label: "Admin Masters",
        value: `${toPercent(mastersChecks.filter(Boolean).length, mastersChecks.length)}%`,
        note: `${mastersChecks.filter(Boolean).length}/${mastersChecks.length} baseline checks ready`,
        accent: mastersChecks.every(Boolean) ? "#14804a" : "#d97706",
        onClick: () => openAdminDesk("admin_masters", { activeSection: "company", companyId: companies[0]?.id }),
      },
      {
        label: "Templates",
        value: `${toPercent(templateChecksReady, templateChecksTotal || 1)}%`,
        note: `${templateChecksReady}/${templateChecksTotal || 0} document checks ready`,
        accent: templateChecksReady === templateChecksTotal && templateChecksTotal > 0 ? "#14804a" : "#1f5eff",
        onClick: () => openAdminDesk("templates", { companyId: companyDocuments.find((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms))?.company_id || companies[0]?.id }),
      },
      {
        label: "Approvals",
        value: `${toPercent(approvalsReady, docTypes.length || 1)}%`,
        note: `${approvalsReady}/${docTypes.length || 0} document types covered — manage ceilings in Org & access`,
        accent: approvalsReady === docTypes.length && docTypes.length > 0 ? "#14804a" : "#8b5cf6",
        onClick: () => openAdminDesk("users", { companyId: companies[0]?.id, view: "orgchart" }, "Org & access / authority"),
      },
      {
        label: "Users",
        value: `${toPercent(usersChecks.filter(Boolean).length, usersChecks.length)}%`,
        note: `${usersChecks.filter(Boolean).length}/${usersChecks.length} governance checks ready`,
        accent: usersChecks.every(Boolean) ? "#14804a" : "#d97706",
        onClick: () => openAdminDesk("users", { companyId: companies[0]?.id, view: users.offboarding_audits_ready === false ? "offboarding" : "directory" }),
      },
      {
        label: "Visibility",
        value: Array.isArray(users.users) && users.users.length ? "Live" : "Pending",
        note: Array.isArray(users.users) && users.users.length ? "effective user checks can be simulated now" : "user list not loaded for visibility simulation",
        accent: Array.isArray(users.users) && users.users.length ? "#1f5eff" : "#d97706",
        onClick: () => openAdminDesk("user_access_preview", { focusLane: "all" }, "User Access Preview"),
      },
    ];
  }, [setupSnapshot]);

  const companyStatusChips = useMemo(() => {
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    return companyDocuments.map((item) => {
      const readyCount = Number(item.has_letterhead) + Number(item.has_cover_letter) + Number(item.has_quote_terms);
      const percent = Math.round((readyCount / 3) * 100);
      const status = percent === 100 ? "Ready" : percent >= 67 ? "Close" : percent > 0 ? "Partial" : "Missing";
      const tone = percent === 100 ? "#14804a" : percent >= 67 ? "#1f5eff" : percent > 0 ? "#d97706" : "#e30513";
      return {
        ...item,
        readyCount,
        percent,
        status,
        tone,
      };
    });
  }, [setupSnapshot.companyDocuments]);

  const groups = [
    {
      title: "Core Setup",
      body: "Company profile, distributors, vendors, and commercial lookup masters stay together so foundational setup no longer gets buried.",
      tone: "#1f5eff",
      actions: [
        { label: "Admin Masters", caption: "Company, distributor, vendor, lookup masters", page: "admin_masters" },
        { label: "Intercompany Partners", caption: "AI ↔ AT company links and mappings", page: "intercompany_partners" },
        { label: "Templates", caption: "Letterheads, scope PDFs, quote texts", page: "templates" },
      ],
    },
    {
      title: "People & Access",
      body: "One path: add users guided or from the org chart, diagnose in Access Preview, edit in Org & access.",
      tone: "#14804a",
      actions: [
        { label: "Org & access", caption: "Chart, identity, screens, and approval ceilings", page: "users" },
        { label: "Access Preview", caption: "Diagnose visibility, then jump to edit", page: "user_access_preview" },
        { label: "Add user (guided)", caption: "Onboarding wizard for internal and distributor users", page: "onboarding" },
      ],
    },
    {
      title: "Commercial & assets",
      body: "SKU registry and aftermarket asset governance without crowding the triage desk.",
      tone: "#d97706",
      actions: [
        { label: "Product Master", caption: "Shared catalog, company policy, IC pair", page: "product_master" },
        { label: "Job Assets", caption: "Deployed assets and aftermarket rules", page: "job_asset_admin" },
        { label: "Pilot Notes", caption: "Live blocked / confusing / suggestion queue", page: "pilot_feedback" },
        { label: "Chat Readiness", caption: "Who receives alerts in Google Chat", page: "chat_readiness" },
      ],
    },
  ];

  const quickActions = [
    { label: "Open Org & access", page: "users" },
    { label: "Open Access Preview", page: "user_access_preview" },
    { label: "Open Product Desk", page: "product_master" },
    { label: "Open Master Setup", page: "admin_masters" },
  ];

  const focusNowActions = useMemo(
    () =>
      (readinessSections[0]?.items || []).map((item, index) => ({
        page: `focus-${index}`,
        label: item.title,
        caption: `${item.badge ? `${item.badge} • ` : ""}${item.note}`,
        onClick: item.onClick,
      })),
    [readinessSections]
  );

  const governancePriorityActions = useMemo(() => {
    const companyDocuments = Array.isArray(setupSnapshot.companyDocuments) ? setupSnapshot.companyDocuments : [];
    const firstMissingCompany = companyDocuments.find((item) => !(item.has_letterhead && item.has_cover_letter && item.has_quote_terms));
    const approvalPolicies = Array.isArray(setupSnapshot.approval?.approval_policies) ? setupSnapshot.approval.approval_policies : [];
    const docTypes = Array.isArray(setupSnapshot.approval?.doc_types) ? setupSnapshot.approval.doc_types : [];
    const coveredDocTypes = new Set(approvalPolicies.filter((row) => row?.is_active !== false).map((row) => String(row.doc_type || "")));
    const firstUncoveredDocType = docTypes.find((item) => !coveredDocTypes.has(String(item?.key || "")));
    const actions = [];
    if (lastDrilldown?.page) {
      actions.push({
        page: "resume-last",
        label: "Resume last fix",
        caption: lastDrilldown.label || "Jump back into the last interrupted admin correction.",
        onClick: reopenLastDrilldown,
      });
    }
    actions.push(
      {
        page: "users-priority",
        label: "Open org & access",
        caption: "Org chart, identity, screen exceptions, and per-user approval ceilings.",
        onClick: () => openAdminDesk("users", { view: "orgchart" }, "Org & access / chart"),
      },
      {
        page: "visibility-priority",
        label: "Open visibility simulator",
        caption: "See the effective user outcome, changed results, and exception impact.",
        onClick: () => openAdminDesk("user_access_preview", { focusLane: "changed" }, "Access Preview / changed"),
      },
      {
        page: "templates-priority",
        label: "Open document stack",
        caption: "Jump into incomplete company docs and quote assets from the home desk.",
        onClick: () =>
          openAdminDesk("templates", {
            companyId: firstMissingCompany?.company_id,
            textCompanyId: firstMissingCompany?.company_id,
            focus: "company_docs",
          }),
      }
    );
    return actions;
  }, [lastDrilldown, openAdminDesk, reopenLastDrilldown, setupSnapshot]);

  return (
    <div style={{ maxWidth: 1320, width: "100%", display: "grid", gap: 18 }}>
      <DeskTopStrip
        title="SuperAdmin Home"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {quickActions.map((item) => (
              <button key={item.page} type="button" onClick={() => onNavigate(item.page, { resetQuote: true })}>
                {item.label}
              </button>
            ))}
            {lastDrilldown?.page ? <button type="button" onClick={reopenLastDrilldown}>Resume Last Fix</button> : null}
            {lastDrilldown?.page ? <button type="button" onClick={clearLastDrilldown}>Clear Saved Jump</button> : null}
          </div>
        }
        metrics={topMetrics}
      />

      {lastDrilldown?.label ? <div style={{ fontSize: 12, opacity: 0.72 }}>Last drill-down: {lastDrilldown.label}</div> : null}

      <section style={groupCardStyle()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "start" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Live pilot channel</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>Pilot notes</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6, maxWidth: 760 }}>
              In-app notes from pilot users. Triage blockers first. Access issues still come by reply-all welcome mail.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <StatusChip
              label={`${pilotFeedbackSummary?.open_count ?? 0} open`}
              tone={(pilotFeedbackSummary?.blocked_open || 0) > 0 ? "#b91c1c" : "#1f5eff"}
              background={(pilotFeedbackSummary?.blocked_open || 0) > 0 ? "rgba(185, 28, 28, 0.1)" : "rgba(31, 94, 255, 0.1)"}
            />
            <button type="button" className="button-primary compact-button" onClick={() => onNavigate("pilot_feedback", { resetQuote: true })}>
              Open queue
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 16 }}>
          {[
            { label: "Blocked", value: pilotFeedbackSummary?.blocked_open ?? 0 },
            { label: "Confusing", value: pilotFeedbackSummary?.confusing_open ?? 0 },
            { label: "Suggestions", value: pilotFeedbackSummary?.suggestion_open ?? 0 },
            { label: "Total", value: pilotFeedbackSummary?.total ?? 0 },
          ].map((item) => (
            <div key={item.label} style={{ border: "1px solid #e3e8f2", borderRadius: 14, padding: "12px 14px", background: "#fbfcff" }}>
              <div style={{ fontSize: 12, opacity: 0.62 }}>{item.label}</div>
              <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{item.value}</div>
            </div>
          ))}
        </div>
      </section>

      {(() => {
        const health = setupSnapshot.users?.access_health || {};
        const blockers = [
          {
            key: "unapproved",
            label: "Unapproved",
            value: Number(health.unapproved_count) || 0,
            note: "Active users still waiting for approval",
            onClick: () => openAdminDesk("users", { view: "directory" }, "Org & access / unapproved"),
          },
          {
            key: "zero_company",
            label: "No company",
            value: Number(health.zero_company_count) || 0,
            note: "Active users with zero Works For memberships",
            onClick: () => openAdminDesk("users", { view: "orgchart" }, "Org & access / companies"),
          },
          {
            key: "quotes_hidden",
            label: "Quotes hidden",
            value: Number(health.quotes_hidden_count) || 0,
            note: "Approved users who cannot see Quotes",
            onClick: () => openAdminDesk("user_access_preview", { focusLane: "blocked" }, "Access Preview / blocked"),
          },
        ];
        const total = blockers.reduce((sum, item) => sum + item.value, 0);
        return (
          <section style={groupCardStyle()}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "start" }}>
              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Access blockers</div>
                <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>Who cannot work yet</div>
                <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6, maxWidth: 760 }}>
                  Unapproved accounts, missing company memberships, and Quotes-hidden outcomes. Diagnose in Access Preview; edit exceptions in Org &amp; access.
                </div>
              </div>
              <StatusChip
                label={total > 0 ? `${total} blocker${total === 1 ? "" : "s"}` : "Clear"}
                tone={total > 0 ? "#b91c1c" : "#14804a"}
                background={total > 0 ? "rgba(185, 28, 28, 0.1)" : "rgba(20, 128, 74, 0.1)"}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 16 }}>
              {blockers.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onClick}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e3e8f2",
                    borderRadius: 14,
                    padding: "12px 14px",
                    background: item.value > 0 ? "#fff7f7" : "#fbfcff",
                  }}
                >
                  <div style={{ fontSize: 12, opacity: 0.62 }}>{item.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{item.value}</div>
                  <div style={{ fontSize: 12, opacity: 0.68, marginTop: 6, lineHeight: 1.45 }}>{item.note}</div>
                </button>
              ))}
            </div>
          </section>
        );
      })()}

      <section style={groupCardStyle()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "start" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Absstem go-live</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>Pilot checklist</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6, maxWidth: 760 }}>
              Live items auto-check from the same readiness scan as Fix Now. Soft items sync to the server when migration 189 is applied{goLiveServerReady ? " (server-backed)." : " (browser fallback until migration)."}
            </div>
          </div>
          <StatusChip
            label={`${goLiveDoneCount}/${GO_LIVE_CHECKLIST_ITEMS.length} done`}
            tone={goLiveDoneCount === GO_LIVE_CHECKLIST_ITEMS.length ? "#14804a" : "#1f5eff"}
            background={goLiveDoneCount === GO_LIVE_CHECKLIST_ITEMS.length ? "rgba(20, 128, 74, 0.1)" : "rgba(31, 94, 255, 0.1)"}
          />
        </div>
        <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
          {GO_LIVE_CHECKLIST_ITEMS.map((item) => {
            const done = isGoLiveItemDone(item);
            const liveDone = Boolean(goLiveLiveStatus[item.id]);
            const isLiveOnly = item.source === "live";
            return (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  border: "1px solid #e3e8f2",
                  borderRadius: 14,
                  padding: "12px 14px",
                  background: done ? "#f2fff6" : "#fbfcff",
                }}
              >
                <input
                  type="checkbox"
                  checked={done}
                  disabled={isLiveOnly}
                  onChange={() => toggleGoLiveCheck(item.id)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, lineHeight: 1.5, textDecoration: done ? "line-through" : "none", opacity: done ? 0.72 : 1 }}>
                    {item.label}
                  </div>
                  {item.caption ? <div style={{ fontSize: 12, opacity: 0.68, marginTop: 4 }}>{item.caption}</div> : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
                    <StatusChip
                      label={isLiveOnly ? (liveDone ? "Live ready" : "Live gap") : liveDone ? "Live ready" : item.source === "manual" ? "Manual sign-off" : "Live or manual"}
                      tone={liveDone || done ? "#14804a" : "#8b5a00"}
                      background={liveDone || done ? "rgba(20, 128, 74, 0.1)" : "rgba(217, 119, 6, 0.12)"}
                    />
                    {item.page ? (
                      <button
                        type="button"
                        onClick={() => openAdminDesk(item.page, item.launch || {}, item.label)}
                        style={{ borderRadius: 999, border: "1px solid #d8e1f0", background: "#fff", padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                      >
                        Open
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button type="button" onClick={() => openAdminDesk("user_access_preview", { focusLane: "all" }, "Access Preview")}>
            Open Access Preview
          </button>
          <button type="button" onClick={() => openAdminDesk("admin_masters", { activeSection: "company" }, "Admin Masters / baseline")}>
            Open Admin Masters
          </button>
          <button
            type="button"
            onClick={() => {
              const cleared = {};
              saveGoLiveChecklist(cleared);
              persistGoLiveChecklistToServer(cleared);
              setGoLiveChecks(cleared);
            }}
          >
            Reset manual checks
          </button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1.08fr 0.92fr", gap: 16 }}>
        <ActionCard
          title="Fix Now"
          body="All danger items plus outstanding warnings from the live readiness scan. Start here."
          actions={
            focusNowActions.length
              ? focusNowActions
              : [
                  {
                    page: "no-focus",
                    label: "No urgent blockers",
                    caption: "The current readiness scan does not show an immediate setup blocker.",
                    onClick: () => onNavigate("admin_masters", { resetQuote: true }),
                  },
                ]
          }
          tone="#e30513"
        />

        <ActionCard
          title="Governance Queue"
          body="Keep identity, screen access, and financial authority fixes in Org & access so governance gaps stay in one operating lane."
          actions={governancePriorityActions}
          tone="#14804a"
        />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 14 }}>
        {deskScores.map((item) => (
          <button key={item.label} type="button" onClick={item.onClick} style={{ ...metricCardStyle(item.accent), cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 12, opacity: 0.62 }}>{item.label} score</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{item.value}</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8 }}>{item.note}</div>
          </button>
        ))}
      </section>

      <section style={groupCardStyle()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "start" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Admin jump lanes</div>
            <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>Go straight to the control surface you need</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6, maxWidth: 760 }}>
              Keep setup, governance, commercial control, and guided onboarding reachable in one dense command grid.
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, marginTop: 16 }}>
          {groups.map((group) => (
            <div
              key={group.title}
              style={{
                border: "1px solid #e3e8f2",
                borderRadius: 18,
                padding: 14,
                background: "#ffffff",
                boxShadow: "0 12px 28px rgba(15, 23, 42, 0.05)",
                display: "grid",
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: group.tone, fontWeight: 800 }}>Lane</div>
                <div style={{ fontSize: 18, fontWeight: 800, marginTop: 6 }}>{group.title}</div>
                <div style={{ fontSize: 13, opacity: 0.74, marginTop: 6, lineHeight: 1.6 }}>{group.body}</div>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {group.actions.map((item) => (
                  <button
                    key={item.page}
                    type="button"
                    onClick={() => onNavigate(item.page, { resetQuote: true })}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      border: "1px solid #e3e8f2",
                      borderLeft: `4px solid ${group.tone}`,
                      borderRadius: 14,
                      padding: "10px 12px",
                      background: "#fbfcff",
                      display: "grid",
                      gap: 4,
                    }}
                  >
                    <strong style={{ fontSize: 14 }}>{item.label}</strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.caption}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {companyStatusChips.length ? (
        <section style={groupCardStyle()}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "start" }}>
            <div>
              <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Company readiness</div>
              <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>Document status by company</div>
              <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8, lineHeight: 1.6, maxWidth: 760 }}>
                Scan AI/AT-style company setup at a glance, then jump directly into the matching template context when something is partial or missing.
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, marginTop: 16 }}>
            {companyStatusChips.map((item) => (
              <button
                key={item.company_id}
                type="button"
                onClick={() => openAdminDesk("templates", { companyId: item.company_id, textCompanyId: item.company_id })}
                style={{
                  border: `1px solid ${item.tone}22`,
                  background: "#fff",
                  borderRadius: 18,
                  padding: "12px 14px",
                  textAlign: "left",
                  cursor: "pointer",
                  boxShadow: "0 12px 28px rgba(15, 23, 42, 0.05)",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <strong>{item.company_code}</strong>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: 22,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: `${item.tone}14`,
                      color: item.tone,
                      fontSize: 11,
                      fontWeight: 800,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    {item.status}
                  </span>
                </div>
                <div style={{ fontSize: 13, opacity: 0.78 }}>{item.display_name}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: item.tone }}>{item.percent}%</div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>{item.readyCount}/3 document checks ready</div>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section style={groupCardStyle()}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Ops pulse</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>Manufacturing and stores (optional)</div>
            <div style={{ fontSize: 13, opacity: 0.74, marginTop: 6, lineHeight: 1.6, maxWidth: 720 }}>
              Kept off the primary triage path. Expand when you need factory or stores pressure without leaving SuperAdmin Home.
            </div>
          </div>
          <button type="button" onClick={() => setShowOpsPulse((value) => !value)}>
            {showOpsPulse ? "Hide ops pulse" : "Show ops pulse"}
          </button>
        </div>
        {showOpsPulse ? (
          <div style={{ display: "grid", gap: 18, marginTop: 16 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={openManufacturingDesk}>
                Open Manufacturing Desk
              </button>
              <button type="button" onClick={() => openStoresDesk("all")}>
                Open Stores Desk
              </button>
              <button type="button" onClick={() => openStoresDesk("not_raised")}>
                Open Procurement Queue
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 14 }}>
              {[
                { label: "FG Ready", value: operationsLoading ? "…" : manufacturingDashboard?.fg_ready || 0, note: "finished goods ready", accent: "#14804a", onClick: openManufacturingDesk },
                { label: "Open MFG Jobs", value: operationsLoading ? "…" : manufacturingDashboard?.open_manufacturing_jobs || 0, note: "active manufacturing load", accent: "#1f5eff", onClick: openManufacturingDesk },
                { label: "Stores Pending", value: operationsLoading ? "…" : storesPendingSummary?.total || manufacturingDashboard?.stores_pending_jobs || 0, note: "waiting RM issue", accent: "#d97706", onClick: () => openStoresDesk("all") },
                { label: "Shortages Not Raised", value: operationsLoading ? "…" : storesShortageSummary?.procurementNotRaised || 0, note: "waiting PR handoff", accent: "#b45309", onClick: () => openStoresDesk("not_raised") },
                { label: "Ready Re-Issue", value: operationsLoading ? "…" : storesShortageSummary?.readyForReissue || 0, note: "covered for re-issue", accent: "#0a7a35", onClick: () => openStoresDesk("ready_for_reissue") },
                { label: "Oldest Blocked Age", value: operationsLoading ? "…" : `${storesShortageSummary?.oldestAgeDays || 0}d`, note: "oldest open shortage", accent: "#7c3aed", onClick: () => openStoresDesk("blocked") },
              ].map((item) => (
                <button key={item.label} type="button" onClick={item.onClick} style={{ ...metricCardStyle(item.accent), cursor: "pointer", textAlign: "left" }}>
                  <div style={{ fontSize: 12, opacity: 0.62 }}>{item.label}</div>
                  <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>{item.value}</div>
                  <div style={{ fontSize: 13, opacity: 0.74, marginTop: 8 }}>{item.note}</div>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

    </div>
  );
}
