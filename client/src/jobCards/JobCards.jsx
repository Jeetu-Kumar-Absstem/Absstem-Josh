import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskPilotBanner, DeskStat, MiniMetric, PageHero, getDeskStatusAppearance, saveLastDeskFix } from "../shared/joshUi";
import { resolveHomeRoleFamily } from "../home/roleAccess";

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

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function toIsoDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function todayIsoDate() {
  return toIsoDate(new Date());
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pendingToIssueQty(line) {
  return Math.max(num(line?.qty_requested) - num(line?.qty_issued) + num(line?.qty_returned), 0);
}

function emptyLine() {
  return {
    product_id: null,
    item_code: "",
    item_name: "",
    uom: "",
    serial_no_required: false,
    qty_requested: 1,
    qty_consumed: 0,
    remarks: "",
  };
}

function createFormDefaults() {
  return {
    job_type: "service",
    manufacturing_mode: "standalone",
    service_case_id: "",
    sales_order_line_id: "",
    finished_good_product_id: "",
    bom_id: "",
    planned_output_qty: 1,
  };
}

function buildMovementForm(lines, current = {}) {
  const movementType = current.movement_type || "issue";
  const eligibleLines = Array.isArray(lines)
    ? lines.filter((line) => (movementType === "issue" ? true : num(line.qty_outstanding) > 0))
    : [];
  const selectedExists = eligibleLines.some((line) => String(line.id) === String(current.line_id || ""));
  return {
    line_id: selectedExists ? String(current.line_id || "") : eligibleLines[0] ? String(eligibleLines[0].id) : "",
    movement_type: movementType,
    qty: current.qty || "",
    movement_date: current.movement_date || todayIsoDate(),
    reference_no: current.reference_no || "",
    remarks: current.remarks || "",
    serial_text: current.serial_text || "",
  };
}

function buildStoresQuickIssueForm(lines, current = {}) {
  const eligibleLines = Array.isArray(lines) ? lines.filter((line) => pendingToIssueQty(line) > 0) : [];
  const selectedLine =
    eligibleLines.find((line) => String(line.id) === String(current.line_id || "")) ||
    eligibleLines[0] ||
    null;
  const selectedPendingQty = selectedLine ? pendingToIssueQty(selectedLine) : 0;
  const safeQty =
    current.qty !== undefined && current.qty !== null && current.qty !== ""
      ? Math.max(Math.min(num(current.qty), selectedPendingQty || num(current.qty)), 0)
      : null;
  return {
    line_id: selectedLine ? String(selectedLine.id) : "",
    qty:
      safeQty !== null
        ? safeQty.toFixed(4)
        : selectedLine
          ? pendingToIssueQty(selectedLine).toFixed(4)
          : "",
    movement_date: current.movement_date || todayIsoDate(),
    reference_no: current.reference_no || "",
    remarks: current.remarks || "",
    serial_text: current.serial_text || "",
  };
}

const SHORTAGE_ACTION_OPTIONS = [
  ["shortage_reported", "Shortage Reported"],
  ["blocked", "Blocked"],
  ["follow_up", "Follow Up"],
  ["resolved", "Resolved"],
];

function buildShortageActionForm(lines, current = {}) {
  const eligibleLines = Array.isArray(lines) ? lines.filter((line) => pendingToIssueQty(line) > 0) : [];
  const selectedLine =
    eligibleLines.find((line) => String(line.id) === String(current.line_id || "")) ||
    eligibleLines[0] ||
    null;
  return {
    line_id: selectedLine ? String(selectedLine.id) : "",
    action_type: current.action_type || "shortage_reported",
    shortage_qty:
      current.shortage_qty !== undefined && current.shortage_qty !== null
        ? current.shortage_qty
        : selectedLine
          ? pendingToIssueQty(selectedLine).toFixed(4)
          : "",
    action_date: current.action_date || todayIsoDate(),
    reference_no: current.reference_no || "",
    expected_date: current.expected_date || "",
    remarks: current.remarks || "",
  };
}

function shortageActionAppearance(type) {
  const key = String(type || "").toLowerCase();
  if (key === "shortage_reported") return { tone: "#fff7ea", color: "#8b5a00" };
  if (key === "blocked") return { tone: "#fff3f3", color: "#b00020" };
  if (key === "follow_up") return { tone: "#eef4ff", color: "#234a8f" };
  if (key === "resolved") return { tone: "#eefbf3", color: "#147a3d" };
  return { tone: "#f6f7fb", color: "#58627a" };
}

function shortageLifecycleAppearance(label) {
  const key = String(label || "").toLowerCase();
  if (key.includes("ready for re-issue")) return { tone: "#eefbf3", color: "#147a3d" };
  if (key.includes("fully received")) return { tone: "#eefbf3", color: "#0a7a35" };
  if (key.includes("fully ordered")) return { tone: "#eef4ff", color: "#234a8f" };
  if (key.includes("procurement raised")) return { tone: "#eef4ff", color: "#234a8f" };
  if (key.includes("issue closed") || key.includes("resolved")) return { tone: "#eefbf3", color: "#147a3d" };
  if (key.includes("not raised")) return { tone: "#fff7ea", color: "#8b5a00" };
  return { tone: "#f6f7fb", color: "#58627a" };
}

function materialReadinessStatusAppearance(status) {
  const key = String(status || "").toLowerCase();
  if (key === "ready") return { tone: "#eefbf3", color: "#147a3d", label: "Ready" };
  if (key === "missing_prefix") return { tone: "#fff2f2", color: "#a52323", label: "Missing Prefix" };
  if (key === "missing_fg_flag") return { tone: "#fff2f2", color: "#a52323", label: "Not Manufactured" };
  if (key === "missing_active_bom") return { tone: "#fff7ea", color: "#8b5a00", label: "Missing BOM" };
  if (key === "empty_bom") return { tone: "#fff7ea", color: "#8b5a00", label: "Empty BOM" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(status || "Check setup") };
}

function productionExecutionAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "ready_to_close") return { tone: "#eefbf3", color: "#147a3d", label: "Ready to Close/Post" };
  if (key === "output_pending_close") return { tone: "#eef4ff", color: "#234a8f", label: "Output Pending Close" };
  if (key === "receipt_missing") return { tone: "#fff7ea", color: "#8b5a00", label: "Receipt Missing" };
  if (key === "stalled_wip") return { tone: "#f6f7fb", color: "#58627a", label: "Stalled WIP" };
  if (key === "pending_rm") return { tone: "#fff7ea", color: "#8b5a00", label: "Pending RM" };
  if (key === "final_status_risk") return { tone: "#fff2f2", color: "#a52323", label: "Final Status Risk" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Execution") };
}

function fgReceiptReconciliationAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "receipt_not_reflected") return { tone: "#fff2f2", color: "#a52323", label: "Receipt Not Reflected" };
  if (key === "receipt_qty_mismatch") return { tone: "#fff7ea", color: "#8b5a00", label: "Qty Mismatch" };
  if (key === "receipt_date_mismatch") return { tone: "#fff7ea", color: "#8b5a00", label: "Date Mismatch" };
  if (key === "premature_receipt") return { tone: "#fff2f2", color: "#a52323", label: "Premature Receipt" };
  if (key === "final_without_output") return { tone: "#fff2f2", color: "#a52323", label: "Final Without Output" };
  if (key === "awaiting_final_post") return { tone: "#eef4ff", color: "#234a8f", label: "Awaiting Final Post" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "FG Receipt") };
}

function consumptionVarianceAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "consumed_without_issue") return { tone: "#fff2f2", color: "#a52323", label: "Consumed > Issued" };
  if (key === "low_stock_blocked") return { tone: "#fff7ea", color: "#8b5a00", label: "Low Stock Block" };
  if (key === "pending_issue") return { tone: "#eef4ff", color: "#234a8f", label: "Pending Issue" };
  if (key === "issued_not_consumed") return { tone: "#eefbf3", color: "#147a3d", label: "Issued Not Consumed" };
  if (key === "no_issue_logged") return { tone: "#f6f7fb", color: "#58627a", label: "No Issue Logged" };
  if (key === "return_logged") return { tone: "#fff7ea", color: "#8b5a00", label: "Return Logged" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Variance") };
}

function completionDispatchReadinessAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "awaiting_completion") return { tone: "#f6f7fb", color: "#58627a", label: "Awaiting Completion" };
  if (key === "fg_not_received") return { tone: "#fff7ea", color: "#8b5a00", label: "FG Not Received" };
  if (key === "receipt_mismatch") return { tone: "#fff2f2", color: "#a52323", label: "Receipt Mismatch" };
  if (key === "stock_short") return { tone: "#fff7ea", color: "#8b5a00", label: "FG Stock Short" };
  if (key === "ready_for_dispatch") return { tone: "#eefbf3", color: "#147a3d", label: "Ready for Dispatch" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Dispatch Readiness") };
}

function planningReleaseAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "release_blocked_setup") return { tone: "#fff2f2", color: "#a52323", label: "Blocked by Setup" };
  if (key === "ready_for_release") return { tone: "#eefbf3", color: "#147a3d", label: "Ready for Release" };
  if (key === "released_material_blocked") return { tone: "#fff7ea", color: "#8b5a00", label: "Released Material Block" };
  if (key === "released_in_execution") return { tone: "#eef4ff", color: "#234a8f", label: "Released In Execution" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Release") };
}

function planningCapacityAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "capacity_overdue") return { tone: "#fff2f2", color: "#a52323", label: "Overdue Backlog" };
  if (key === "capacity_due_7d") return { tone: "#fff7ea", color: "#8b5a00", label: "Due 7 Days" };
  if (key === "capacity_future") return { tone: "#eef4ff", color: "#234a8f", label: "Future Backlog" };
  if (key === "capacity_unassigned_department") return { tone: "#f6f7fb", color: "#58627a", label: "Unassigned Dept" };
  if (key === "capacity_ready_for_release") return { tone: "#eefbf3", color: "#147a3d", label: "Ready to Release" };
  if (key === "capacity_setup_blocked") return { tone: "#fff2f2", color: "#a52323", label: "Setup Blocked" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Capacity") };
}

function productionCostAppearance(bucket) {
  const key = String(bucket || "").toLowerCase();
  if (key === "issued_no_output") return { tone: "#fff2f2", color: "#a52323", label: "Issued No Output" };
  if (key === "over_issue_vs_bom") return { tone: "#fff7ea", color: "#8b5a00", label: "Over-Issue Vs BOM" };
  if (key === "under_issue_vs_bom") return { tone: "#eef4ff", color: "#234a8f", label: "Under-Issue Vs BOM" };
  if (key === "stalled_wip_value") return { tone: "#f6f7fb", color: "#58627a", label: "Stalled WIP Value" };
  if (key === "margin_at_risk") return { tone: "#fff2f2", color: "#a52323", label: "Margin At Risk" };
  if (key === "ready_cost_review") return { tone: "#eefbf3", color: "#147a3d", label: "Ready Cost Review" };
  return { tone: "#f6f7fb", color: "#58627a", label: String(bucket || "Cost Control") };
}

function attentionAppearance(level) {
  if (level === "high") return { tone: "#fff1f1", color: "#a43f3f" };
  if (level === "medium") return { tone: "#fff7ea", color: "#8b5a00" };
  return { tone: "#eef7ef", color: "#1d6b3a" };
}

function formatDayAge(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return "Fresh";
  if (days === 0) return "Updated today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

function QueueReasonCard({ text }) {
  return (
    <div style={{ marginTop: 2, padding: 12, borderRadius: 14, background: "#f8fbff", border: "1px solid #e6eef8" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>Why this needs attention</div>
      <div style={{ fontSize: 13, lineHeight: 1.7 }}>{text || "Review this item and take the next operational step."}</div>
    </div>
  );
}

function QueueActionSummary({ actionLabel, items = [] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 10,
        padding: 12,
        borderRadius: 14,
        background: "#fcfdff",
        border: "1px solid #edf1f8",
      }}
    >
      <div>
        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Next action</div>
        <div style={{ marginTop: 4, fontWeight: 700 }}>{actionLabel || "Open item"}</div>
      </div>
      {items.map((item) => (
        <div key={item.label}>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{item.label}</div>
          <div style={{ marginTop: 4, fontWeight: 700 }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function statusOptionsForType(jobType) {
  if (jobType === "manufacturing") {
    return [
      ["draft", "Draft"],
      ["submitted", "Submitted"],
      ["approved", "Approved"],
      ["open", "Open"],
      ["closed", "Closed"],
      ["posted", "Posted"],
      ["cancelled", "Cancelled"],
    ];
  }
  if (jobType === "service" || jobType === "installation") {
    return [
      ["draft", "Draft"],
      ["submitted", "Submitted"],
      ["approved", "Approved"],
      ["open", "Open"],
      ["closed", "Closed"],
      ["cancelled", "Cancelled"],
    ];
  }
  return [
    ["draft", "Draft"],
    ["open", "Open"],
    ["closed", "Closed"],
    ["cancelled", "Cancelled"],
  ];
}

function friendlyError(code, fallback) {
  if (code === "COMPANY_NOT_SELECTED") return "Select company first.";
  if (code === "PRODUCT_NOT_MARKED_MANUFACTURED") return "Finished good is not marked as Manufactured FG in Product Master.";
  if (code === "PRODUCT_MFG_PREFIX_MISSING") return "Finished good is missing manufacturing JobID prefix in Product Master.";
  if (code === "PRODUCT_INTERCOMPANY_SUPPLIED") return "This finished good is supplied from the intercompany source company. Keep the BOM and manufacturing job in that company.";
  if (code === "INVALID_SALES_ORDER_LINE") return "Selected sales order line is invalid.";
  if (code === "SALES_ORDER_NOT_READY") return "Sales order must be Confirmed or Closed before creating manufacturing job.";
  if (code === "OUTPUT_EXCEEDS_PLANNED") return "Actual output cannot exceed planned output.";
  if (code === "CONSUMPTION_EXCEEDS_OUTSTANDING") return "Consumed qty cannot exceed issued minus returned qty.";
  if (code === "ISSUE_EXCEEDS_REQUESTED") return "Issued qty cannot exceed requested qty.";
  if (code === "RETURN_EXCEEDS_OUTSTANDING") return "Return qty cannot exceed issued minus returned qty.";
  if (code === "SERIAL_COUNT_MISMATCH") return "Serial-controlled items require one serial per unit.";
  if (code === "INVALID_COST_VALUES") return "Enter valid costing inputs (labor hours, labor rate, overhead amount).";
  if (code === "INVALID_COST_PROFILE_VALUES") return "Enter valid cost profile defaults (non-negative values).";
  if (code === "INVALID_MATERIAL_RATE_BASIS") return "Choose a valid material rate basis for the cost profile.";
  if (code === "COSTING_ONLY_FOR_MANUFACTURING") return "Costing is only available for manufacturing jobs.";
  if (code === "INVALID_SHORTAGE_ACTION_TYPE") return "Choose a valid shortage action.";
  if (code === "INVALID_SHORTAGE_QTY") return "Enter a valid shortage qty.";
  if (code === "SHORTAGE_QTY_EXCEEDS_PENDING") return "Shortage qty cannot exceed pending stores qty.";
  if (code === "NO_PENDING_STORES_QTY") return "This line no longer has pending stores qty.";
  if (code === "SHORTAGE_ACTION_ALREADY_RESOLVED") return "Resolved shortage actions cannot raise a requisition.";
  if (code === "NO_PENDING_SHORTAGE_QTY") return "No pending shortage qty is available for requisition.";
  if (code === "SHORTAGE_REQUISITION_ALREADY_RAISED") return "A requisition is already raised for this shortage action.";
  if (code === "APPROVAL_FORBIDDEN") return "Service Head approval right (job_cards can_approve) is required.";
  if (code === "ISSUE_REQUIRES_APPROVAL") return "Approve this service MRN before issuing stock.";
  if (code === "SHORTAGE_ONLY_FOR_MANUFACTURING_OR_SERVICE_MRN") return "Shortage actions are only for manufacturing or service/installation MRNs.";
  if (code === "SHORTAGE_SOURCE_JOB_TYPE_NOT_ALLOWED") return "This shortage source job type cannot raise a purchase requisition.";
  if (code === "SERVICE_TICKET_NOT_FOUND") return "Service ticket not found.";
  if (code === "SERVICE_TICKET_COMPANY_MISMATCH") return "Service ticket belongs to another company.";
  return fallback;
}

function openJobDocument(path) {
  window.open(path, "_blank", "noopener,noreferrer");
}

function openTraveler(id) {
  openJobDocument(`/job-cards/${id}/traveler`);
}

function openTravelerPdf(id) {
  openJobDocument(`/job-cards/${id}/traveler-pdf`);
}

function openIssueSlip(id) {
  openJobDocument(`/job-cards/${id}/issue-slip`);
}

function openIssueSlipPdf(id) {
  openJobDocument(`/job-cards/${id}/issue-slip-pdf`);
}

function openBulkManufacturingPdf(ids, doc) {
  const normalizedIds = Array.isArray(ids) ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) : [];
  if (!normalizedIds.length) return;
  const params = new URLSearchParams();
  params.set("ids", normalizedIds.join(","));
  params.set("doc", doc === "issue_slip" ? "issue_slip" : "traveler");
  openJobDocument(`/job-cards/bulk-print-pdf?${params.toString()}`);
}

function openBulkManufacturingHtml(ids, doc) {
  const normalizedIds = Array.isArray(ids) ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) : [];
  if (!normalizedIds.length) return;
  const params = new URLSearchParams();
  params.set("ids", normalizedIds.join(","));
  params.set("doc", doc === "issue_slip" ? "issue_slip" : "traveler");
  openJobDocument(`/job-cards/bulk-print-html?${params.toString()}`);
}

function openStoresPickList({ groupBy = "fg", ids = [], q = "", pdf = false } = {}) {
  const params = new URLSearchParams();
  params.set("group_by", groupBy === "so" ? "so" : "fg");
  const normalizedIds = Array.isArray(ids) ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) : [];
  if (normalizedIds.length) params.set("ids", normalizedIds.join(","));
  else if (String(q || "").trim()) params.set("q", String(q).trim());
  openJobDocument(`/job-cards/stores-pick-list${pdf ? "-pdf" : ""}?${params.toString()}`);
}

const AUDIT_EXCEPTION_OPTIONS = [
  ["all", "All jobs"],
  ["attention", "Needs attention"],
  ["ready", "Ready to close/post"],
  ["final_risk", "Final status risk"],
  ["missing_output", "Missing output"],
  ["missing_receipt", "Missing receipt date"],
  ["missing_bom", "Missing BOM"],
  ["no_movements", "No movements"],
  ["pending_issue", "Pending RM"],
  ["low_stock", "Low stock"],
];

const STORES_SHORTAGE_BUCKETS = [
  ["all", "All actions"],
  ["not_raised", "Not raised"],
  ["raised", "PR raised"],
  ["fully_ordered", "Fully ordered"],
  ["fully_received", "Fully received"],
  ["ready_for_reissue", "Ready re-issue"],
  ["blocked", "Blocked"],
  ["follow_up", "Follow up"],
];

const MATERIAL_READINESS_BUCKETS = [
  ["all", "All signals"],
  ["fg_setup_gaps", "FG setup gaps"],
  ["missing_prefix", "Missing prefix"],
  ["bom_gaps", "BOM gaps"],
  ["shortage_not_raised", "Shortage not raised"],
  ["procurement_in_flight", "Procurement in flight"],
  ["blocked_supply", "Blocked supply"],
  ["ready_reissue", "Ready re-issue"],
];

const PRODUCTION_EXECUTION_BUCKETS = [
  ["all", "All signals"],
  ["ready_to_close", "Ready to close"],
  ["output_pending_close", "Output pending close"],
  ["receipt_missing", "Receipt missing"],
  ["stalled_wip", "Stalled WIP"],
  ["pending_rm", "Pending RM"],
  ["final_status_risk", "Final status risk"],
];

const FG_RECEIPT_RECONCILIATION_BUCKETS = [
  ["all", "All signals"],
  ["receipt_not_reflected", "Not reflected"],
  ["receipt_qty_mismatch", "Qty mismatch"],
  ["receipt_date_mismatch", "Date mismatch"],
  ["premature_receipt", "Premature receipt"],
  ["final_without_output", "Final no output"],
  ["awaiting_final_post", "Awaiting final post"],
];

const CONSUMPTION_VARIANCE_BUCKETS = [
  ["all", "All signals"],
  ["low_stock_blocked", "Low stock blocked"],
  ["pending_issue", "Pending issue"],
  ["issued_not_consumed", "Issued not consumed"],
  ["consumed_without_issue", "Consumed > issued"],
  ["no_issue_logged", "No issue logged"],
  ["return_logged", "Return logged"],
];

const COMPLETION_DISPATCH_READINESS_BUCKETS = [
  ["all", "All signals"],
  ["awaiting_completion", "Awaiting completion"],
  ["fg_not_received", "FG not received"],
  ["receipt_mismatch", "Receipt mismatch"],
  ["stock_short", "FG stock short"],
  ["ready_for_dispatch", "Ready for dispatch"],
];

const PLANNING_RELEASE_BUCKETS = [
  ["all", "All signals"],
  ["release_blocked_setup", "Blocked by setup"],
  ["ready_for_release", "Ready for release"],
  ["released_material_blocked", "Released blocked"],
  ["released_in_execution", "Released in execution"],
];

const PLANNING_CAPACITY_BUCKETS = [
  ["all", "All signals"],
  ["capacity_overdue", "Overdue backlog"],
  ["capacity_due_7d", "Due 7 days"],
  ["capacity_future", "Future backlog"],
  ["capacity_unassigned_department", "Unassigned dept"],
  ["capacity_ready_for_release", "Ready to release"],
  ["capacity_setup_blocked", "Setup blocked"],
];

const PRODUCTION_COST_BUCKETS = [
  ["all", "All signals"],
  ["issued_no_output", "Issued no output"],
  ["over_issue_vs_bom", "Over issue vs BOM"],
  ["under_issue_vs_bom", "Under issue vs BOM"],
  ["stalled_wip_value", "Stalled WIP value"],
  ["margin_at_risk", "Margin at risk"],
  ["ready_cost_review", "Ready cost review"],
];

const JOB_DESK_MODES = [
  ["stores", "Stores"],
  ["production", "Production"],
  ["service_mrn", "Service MRN"],
  ["advanced", "Advanced"],
];

const ROLE_FAMILY_JOB_MODE = {
  stores: "stores",
  operations: "production",
  aftermarket: "service_mrn",
  superadmin: "advanced",
  executive: "advanced",
  finance: "advanced",
};

function resolveJobDeskMode(defaultMode, launch, me) {
  const allowed = new Set(JOB_DESK_MODES.map(([key]) => key));
  if (defaultMode && allowed.has(defaultMode)) return defaultMode;
  if (launch?.panel === "stores") return "stores";
  if (launch?.panel === "audit") return "advanced";
  if (me) {
    const family = resolveHomeRoleFamily(me);
    if (ROLE_FAMILY_JOB_MODE[family]) return ROLE_FAMILY_JOB_MODE[family];
  }
  return "stores";
}

function getAuditExceptionAppearance(label) {
  const text = String(label || "").toLowerCase();
  if (text.includes("ready")) return { tone: "#eefbf3", color: "#147a3d" };
  if (text.includes("final status risk")) return { tone: "#fff3f3", color: "#b00020" };
  if (text.includes("missing")) return { tone: "#fff7ea", color: "#8b5a00" };
  if (text.includes("no movements")) return { tone: "#f6f7fb", color: "#58627a" };
  if (text.includes("pending rm")) return { tone: "#eef4ff", color: "#234a8f" };
  if (text.includes("low stock")) return { tone: "#fff7ea", color: "#8b5a00" };
  return { tone: "#f6f7fb", color: "#58627a" };
}

export default function JobCards({
  launch = null,
  onConsumeLaunch = null,
  onOpenSalesOrder = null,
  onOpenPurchaseRequisition = null,
  onOpenPurchaseOrder = null,
  onOpenGoodsReceipt = null,
  onOpenManufacturingBoms = null,
  onOpenStockLedger = null,
  onOpenDispatchesDesk = null,
  onOpenServiceTicket = null,
  canApprove = false,
  defaultMode = null,
  me = null,
} = {}) {
  const [view, setView] = useState({ type: "list" });
  const [deskMode, setDeskMode] = useState(() => resolveJobDeskMode(defaultMode, launch, me));
  const [panelMode, setPanelMode] = useState("queue");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRows, setAuditRows] = useState([]);
  const [auditSummary, setAuditSummary] = useState(null);
  const [auditFilters, setAuditFilters] = useState({ status: "all", mode: "all", exception: "all", q: "" });
  const [productionExecutionLoading, setProductionExecutionLoading] = useState(false);
  const [productionExecutionRows, setProductionExecutionRows] = useState([]);
  const [productionExecutionSummary, setProductionExecutionSummary] = useState(null);
  const [productionExecutionFilter, setProductionExecutionFilter] = useState("all");
  const [fgReceiptReconciliationLoading, setFgReceiptReconciliationLoading] = useState(false);
  const [fgReceiptReconciliationRows, setFgReceiptReconciliationRows] = useState([]);
  const [fgReceiptReconciliationSummary, setFgReceiptReconciliationSummary] = useState(null);
  const [fgReceiptReconciliationFilter, setFgReceiptReconciliationFilter] = useState("all");
  const [completionDispatchReadinessLoading, setCompletionDispatchReadinessLoading] = useState(false);
  const [completionDispatchReadinessRows, setCompletionDispatchReadinessRows] = useState([]);
  const [completionDispatchReadinessSummary, setCompletionDispatchReadinessSummary] = useState(null);
  const [completionDispatchReadinessFilter, setCompletionDispatchReadinessFilter] = useState("all");
  const [planningReleaseLoading, setPlanningReleaseLoading] = useState(false);
  const [planningReleaseRows, setPlanningReleaseRows] = useState([]);
  const [planningReleaseSummary, setPlanningReleaseSummary] = useState(null);
  const [planningReleaseFilter, setPlanningReleaseFilter] = useState("all");
  const [planningCapacityLoading, setPlanningCapacityLoading] = useState(false);
  const [planningCapacityRows, setPlanningCapacityRows] = useState([]);
  const [planningCapacitySummary, setPlanningCapacitySummary] = useState(null);
  const [planningCapacityFilter, setPlanningCapacityFilter] = useState("all");
  const [productionCostLoading, setProductionCostLoading] = useState(false);
  const [productionCostRows, setProductionCostRows] = useState([]);
  const [productionCostSummary, setProductionCostSummary] = useState(null);
  const [productionCostFilter, setProductionCostFilter] = useState("all");
  const [costProfileLoading, setCostProfileLoading] = useState(false);
  const [costProfile, setCostProfile] = useState(null);
  const [costProfileDraft, setCostProfileDraft] = useState({
    material_rate_basis: "latest_purchase_invoice",
    default_labor_hours_per_output: 0,
    default_labor_hour_rate: 0,
    default_overhead_rate_per_output: 0,
    remarks: "",
  });
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesRows, setStoresRows] = useState([]);
  const [storesSummary, setStoresSummary] = useState(null);
  const [storesQuery, setStoresQuery] = useState("");
  const [storesShortageDashboardLoading, setStoresShortageDashboardLoading] = useState(false);
  const [storesShortageRows, setStoresShortageRows] = useState([]);
  const [storesShortageSummary, setStoresShortageSummary] = useState(null);
  const [storesShortageFilter, setStoresShortageFilter] = useState("all");
  const [materialReadinessLoading, setMaterialReadinessLoading] = useState(false);
  const [materialReadinessRows, setMaterialReadinessRows] = useState([]);
  const [materialReadinessSummary, setMaterialReadinessSummary] = useState(null);
  const [materialReadinessFilter, setMaterialReadinessFilter] = useState("all");
  const [consumptionVarianceLoading, setConsumptionVarianceLoading] = useState(false);
  const [consumptionVarianceRows, setConsumptionVarianceRows] = useState([]);
  const [consumptionVarianceSummary, setConsumptionVarianceSummary] = useState(null);
  const [consumptionVarianceFilter, setConsumptionVarianceFilter] = useState("all");
  const [storesBatchPlanLoading, setStoresBatchPlanLoading] = useState(false);
  const [storesBatchPlan, setStoresBatchPlan] = useState(null);
  const [quickIssueJobId, setQuickIssueJobId] = useState(null);
  const [quickIssueLoading, setQuickIssueLoading] = useState(false);
  const [quickIssueSubmitting, setQuickIssueSubmitting] = useState(false);
  const [quickIssueLines, setQuickIssueLines] = useState([]);
  const [quickIssueForm, setQuickIssueForm] = useState(() => buildStoresQuickIssueForm([]));
  const [shortageDeskJobId, setShortageDeskJobId] = useState(null);
  const [shortageDeskLoading, setShortageDeskLoading] = useState(false);
  const [shortageDeskSubmitting, setShortageDeskSubmitting] = useState(false);
  const [raisingRequisitionActionId, setRaisingRequisitionActionId] = useState(null);
  const [shortageDeskLines, setShortageDeskLines] = useState([]);
  const [shortageDeskActions, setShortageDeskActions] = useState([]);
  const [shortageActionForm, setShortageActionForm] = useState(() => buildShortageActionForm([]));
  const [selectedJobIds, setSelectedJobIds] = useState([]);
  const [selectAllLoading, setSelectAllLoading] = useState(false);
  const [bootstrap, setBootstrap] = useState({
    service_cases: [],
    finished_goods: [],
    boms: [],
    sales_order_lines: [],
  });
  const [createForm, setCreateForm] = useState(createFormDefaults());
  const [queueTypeFilter, setQueueTypeFilter] = useState("all");

  const salesOrderLineMap = useMemo(
    () => new Map((bootstrap.sales_order_lines || []).map((row) => [String(row.id), row])),
    [bootstrap.sales_order_lines]
  );

  async function loadBootstrap() {
    const data = await apiFetch("/job-cards/bootstrap");
    setBootstrap({
      service_cases: Array.isArray(data?.service_cases) ? data.service_cases : [],
      finished_goods: Array.isArray(data?.finished_goods) ? data.finished_goods : [],
      boms: Array.isArray(data?.boms) ? data.boms : [],
      sales_order_lines: Array.isArray(data?.sales_order_lines) ? data.sales_order_lines : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/job-cards");
      setItems(Array.isArray(data?.job_cards) ? data.job_cards : []);
    } catch (_e) {
      setError("Failed to load job cards.");
    } finally {
      setLoading(false);
    }
  }

  async function loadManufacturingAudit(filters = auditFilters) {
    setAuditLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filters.status && filters.status !== "all") params.set("status", filters.status);
      if (filters.mode && filters.mode !== "all") params.set("mode", filters.mode);
      if (filters.exception && filters.exception !== "all") params.set("exception", filters.exception);
      if (filters.q && String(filters.q).trim()) params.set("q", String(filters.q).trim());
      const url = `/job-cards/manufacturing-audit${params.toString() ? `?${params.toString()}` : ""}`;
      const data = await apiFetch(url);
      setAuditRows(Array.isArray(data?.rows) ? data.rows : []);
      setAuditSummary(data?.summary || null);
    } catch (_e) {
      setError("Failed to load manufacturing audit.");
    } finally {
      setAuditLoading(false);
    }
  }

  async function loadProductionExecution(nextQuery = auditFilters.q, bucket = productionExecutionFilter) {
    setProductionExecutionLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/production-execution-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/production-execution-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setProductionExecutionSummary(summaryData?.summary || null);
      setProductionExecutionRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load production execution desk.");
    } finally {
      setProductionExecutionLoading(false);
    }
  }

  async function loadFgReceiptReconciliation(nextQuery = auditFilters.q, bucket = fgReceiptReconciliationFilter) {
    setFgReceiptReconciliationLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/fg-receipt-reconciliation-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/fg-receipt-reconciliation-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setFgReceiptReconciliationSummary(summaryData?.summary || null);
      setFgReceiptReconciliationRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load FG receipt reconciliation desk.");
    } finally {
      setFgReceiptReconciliationLoading(false);
    }
  }

  async function loadCompletionDispatchReadiness(nextQuery = auditFilters.q, bucket = completionDispatchReadinessFilter) {
    setCompletionDispatchReadinessLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/completion-dispatch-readiness-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/completion-dispatch-readiness-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setCompletionDispatchReadinessSummary(summaryData?.summary || null);
      setCompletionDispatchReadinessRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load completion / dispatch readiness desk.");
    } finally {
      setCompletionDispatchReadinessLoading(false);
    }
  }

  async function loadPlanningRelease(nextQuery = auditFilters.q, bucket = planningReleaseFilter) {
    setPlanningReleaseLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/planning-release-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/planning-release-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setPlanningReleaseSummary(summaryData?.summary || null);
      setPlanningReleaseRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load planning / release desk.");
    } finally {
      setPlanningReleaseLoading(false);
    }
  }

  async function loadPlanningCapacity(nextQuery = auditFilters.q, bucket = planningCapacityFilter) {
    setPlanningCapacityLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/planning-capacity-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/planning-capacity-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setPlanningCapacitySummary(summaryData?.summary || null);
      setPlanningCapacityRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load planning capacity desk.");
    } finally {
      setPlanningCapacityLoading(false);
    }
  }

  async function loadProductionCost(nextQuery = auditFilters.q, bucket = productionCostFilter) {
    setProductionCostLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/cost-control-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/cost-control-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setProductionCostSummary(summaryData?.summary || null);
      setProductionCostRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load production cost control desk.");
    } finally {
      setProductionCostLoading(false);
    }
  }

  async function loadCostProfile() {
    setCostProfileLoading(true);
    setError("");
    try {
      const data = await apiFetch("/job-cards/cost-profile");
      const profile = data?.profile || null;
      setCostProfile(profile);
      setCostProfileDraft({
        material_rate_basis: profile?.material_rate_basis || "latest_purchase_invoice",
        default_labor_hours_per_output: num(profile?.default_labor_hours_per_output || 0),
        default_labor_hour_rate: num(profile?.default_labor_hour_rate || 0),
        default_overhead_rate_per_output: num(profile?.default_overhead_rate_per_output || 0),
        remarks: profile?.remarks || "",
      });
    } catch (_e) {
      setCostProfile(null);
    } finally {
      setCostProfileLoading(false);
    }
  }

  async function saveCostProfile() {
    setCostProfileLoading(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        material_rate_basis: String(costProfileDraft.material_rate_basis || "latest_purchase_invoice"),
        default_labor_hours_per_output: num(costProfileDraft.default_labor_hours_per_output || 0),
        default_labor_hour_rate: num(costProfileDraft.default_labor_hour_rate || 0),
        default_overhead_rate_per_output: num(costProfileDraft.default_overhead_rate_per_output || 0),
        remarks: String(costProfileDraft.remarks || ""),
      };
      const data = await apiFetch("/job-cards/cost-profile", { method: "PUT", body: JSON.stringify(payload) });
      const profile = data?.profile || null;
      setCostProfile(profile);
      setCostProfileDraft({
        material_rate_basis: profile?.material_rate_basis || payload.material_rate_basis,
        default_labor_hours_per_output: num(profile?.default_labor_hours_per_output || payload.default_labor_hours_per_output),
        default_labor_hour_rate: num(profile?.default_labor_hour_rate || payload.default_labor_hour_rate),
        default_overhead_rate_per_output: num(profile?.default_overhead_rate_per_output || payload.default_overhead_rate_per_output),
        remarks: profile?.remarks || payload.remarks || "",
      });
      setNotice("Production cost profile updated.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to save production cost profile."));
    } finally {
      setCostProfileLoading(false);
    }
  }

  async function loadStoresPending(nextQuery = storesQuery) {
    setStoresLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) params.set("q", String(nextQuery).trim());
      const url = `/job-cards/stores-pending${params.toString() ? `?${params.toString()}` : ""}`;
      const data = await apiFetch(url);
      setStoresRows(Array.isArray(data?.rows) ? data.rows : []);
      setStoresSummary(data?.summary || null);
    } catch (_e) {
      setError("Failed to load stores pending issues.");
    } finally {
      setStoresLoading(false);
    }
  }

  async function loadStoresShortageDashboard(nextQuery = storesQuery, bucket = storesShortageFilter) {
    setStoresShortageDashboardLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) params.set("q", String(nextQuery).trim());
      if (bucket && bucket !== "all") params.set("bucket", bucket);
      const url = `/job-cards/stores-shortage-dashboard${params.toString() ? `?${params.toString()}` : ""}`;
      const data = await apiFetch(url);
      setStoresShortageRows(Array.isArray(data?.rows) ? data.rows : []);
      setStoresShortageSummary(data?.summary || null);
    } catch (_e) {
      setError("Failed to load stores shortage dashboard.");
    } finally {
      setStoresShortageDashboardLoading(false);
    }
  }

  async function loadMaterialReadiness(nextQuery = storesQuery, bucket = materialReadinessFilter) {
    setMaterialReadinessLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "60");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/material-readiness-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/material-readiness-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setMaterialReadinessSummary(summaryData?.summary || null);
      setMaterialReadinessRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load material readiness desk.");
    } finally {
      setMaterialReadinessLoading(false);
    }
  }

  async function loadConsumptionVariance(nextQuery = storesQuery, bucket = consumptionVarianceFilter) {
    setConsumptionVarianceLoading(true);
    setError("");
    try {
      const summaryParams = new URLSearchParams();
      if (nextQuery && String(nextQuery).trim()) summaryParams.set("q", String(nextQuery).trim());
      const queueParams = new URLSearchParams(summaryParams);
      if (bucket && bucket !== "all") queueParams.set("bucket", bucket);
      queueParams.set("limit", "80");
      const [summaryData, queueData] = await Promise.all([
        apiFetch(`/job-cards/consumption-variance-summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`),
        apiFetch(`/job-cards/consumption-variance-queue${queueParams.toString() ? `?${queueParams.toString()}` : ""}`),
      ]);
      setConsumptionVarianceSummary(summaryData?.summary || null);
      setConsumptionVarianceRows(Array.isArray(queueData?.rows) ? queueData.rows : []);
    } catch (_e) {
      setError("Failed to load consumption variance desk.");
    } finally {
      setConsumptionVarianceLoading(false);
    }
  }

  useEffect(() => {
    if (view.type !== "list") return;
    if (!launch || typeof launch !== "object") return;
    const id = Number(launch.job_card_id);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [view.type, launch, onConsumeLaunch]);

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadManufacturingAudit().catch(() => {});
      loadPlanningRelease().catch(() => {});
      loadPlanningCapacity().catch(() => {});
      loadProductionCost().catch(() => {});
      loadCostProfile().catch(() => {});
      loadCompletionDispatchReadiness().catch(() => {});
      loadProductionExecution().catch(() => {});
      loadFgReceiptReconciliation().catch(() => {});
      loadStoresPending().catch(() => {});
      loadStoresShortageDashboard().catch(() => {});
      loadMaterialReadiness().catch(() => {});
      loadConsumptionVariance().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    if (deskMode === "stores") setPanelMode("stores");
    else if (deskMode === "production") {
      setQueueTypeFilter("manufacturing");
      setPanelMode((prev) => (prev === "audit" ? "audit" : "queue"));
    } else if (deskMode === "service_mrn") {
      setPanelMode("queue");
      setQueueTypeFilter("service_mrn");
    }
  }, [deskMode, view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    const nextPanel = launch && typeof launch === "object" ? String(launch.panel || "").trim().toLowerCase() : "";
    if (!["queue", "audit", "stores"].includes(nextPanel)) return;
    setPanelMode(nextPanel);
    if (nextPanel === "stores") setDeskMode("stores");
    else if (nextPanel === "audit") setDeskMode("advanced");
    if (nextPanel === "audit" && launch && typeof launch === "object") {
      const nextAuditQuery = typeof launch.audit_q === "string" ? launch.audit_q : "";
      const nextReleaseBucket = typeof launch.release_bucket === "string" ? launch.release_bucket.trim().toLowerCase() : "all";
      const nextCapacityBucket = typeof launch.capacity_bucket === "string" ? launch.capacity_bucket.trim().toLowerCase() : "all";
      const nextCostBucket = typeof launch.cost_bucket === "string" ? launch.cost_bucket.trim().toLowerCase() : "all";
      const nextCompletionDispatchBucket = typeof launch.dispatch_ready_bucket === "string" ? launch.dispatch_ready_bucket.trim().toLowerCase() : "all";
      const nextExecutionBucket = typeof launch.execution_bucket === "string" ? launch.execution_bucket.trim().toLowerCase() : "all";
      const nextFgReceiptBucket = typeof launch.fg_receipt_bucket === "string" ? launch.fg_receipt_bucket.trim().toLowerCase() : "all";
      setAuditFilters((prev) => ({ ...prev, q: nextAuditQuery }));
      setPlanningReleaseFilter(PLANNING_RELEASE_BUCKETS.some(([value]) => value === nextReleaseBucket) ? nextReleaseBucket : "all");
      setPlanningCapacityFilter(PLANNING_CAPACITY_BUCKETS.some(([value]) => value === nextCapacityBucket) ? nextCapacityBucket : "all");
      setProductionCostFilter(PRODUCTION_COST_BUCKETS.some(([value]) => value === nextCostBucket) ? nextCostBucket : "all");
      setCompletionDispatchReadinessFilter(
        COMPLETION_DISPATCH_READINESS_BUCKETS.some(([value]) => value === nextCompletionDispatchBucket) ? nextCompletionDispatchBucket : "all"
      );
      setProductionExecutionFilter(PRODUCTION_EXECUTION_BUCKETS.some(([value]) => value === nextExecutionBucket) ? nextExecutionBucket : "all");
      setFgReceiptReconciliationFilter(FG_RECEIPT_RECONCILIATION_BUCKETS.some(([value]) => value === nextFgReceiptBucket) ? nextFgReceiptBucket : "all");
      loadManufacturingAudit({ ...auditFilters, q: nextAuditQuery }).catch(() => {});
      loadPlanningRelease(nextAuditQuery, PLANNING_RELEASE_BUCKETS.some(([value]) => value === nextReleaseBucket) ? nextReleaseBucket : "all").catch(() => {});
      loadPlanningCapacity(nextAuditQuery, PLANNING_CAPACITY_BUCKETS.some(([value]) => value === nextCapacityBucket) ? nextCapacityBucket : "all").catch(() => {});
      loadProductionCost(nextAuditQuery, PRODUCTION_COST_BUCKETS.some(([value]) => value === nextCostBucket) ? nextCostBucket : "all").catch(() => {});
      loadCompletionDispatchReadiness(
        nextAuditQuery,
        COMPLETION_DISPATCH_READINESS_BUCKETS.some(([value]) => value === nextCompletionDispatchBucket) ? nextCompletionDispatchBucket : "all"
      ).catch(() => {});
      loadProductionExecution(nextAuditQuery, PRODUCTION_EXECUTION_BUCKETS.some(([value]) => value === nextExecutionBucket) ? nextExecutionBucket : "all").catch(() => {});
      loadFgReceiptReconciliation(
        nextAuditQuery,
        FG_RECEIPT_RECONCILIATION_BUCKETS.some(([value]) => value === nextFgReceiptBucket) ? nextFgReceiptBucket : "all"
      ).catch(() => {});
    }
    if (nextPanel === "stores" && launch && typeof launch === "object") {
      const nextStoresQuery = typeof launch.storesQuery === "string" ? launch.storesQuery : "";
      const nextShortageBucket = typeof launch.storesShortageBucket === "string" ? launch.storesShortageBucket.trim().toLowerCase() : "all";
      const nextMaterialBucket = typeof launch.material_bucket === "string" ? launch.material_bucket.trim().toLowerCase() : "all";
      const nextConsumptionBucket = typeof launch.consumption_bucket === "string" ? launch.consumption_bucket.trim().toLowerCase() : "all";
      setStoresQuery(nextStoresQuery);
      setStoresShortageFilter(STORES_SHORTAGE_BUCKETS.some(([value]) => value === nextShortageBucket) ? nextShortageBucket : "all");
      setMaterialReadinessFilter(MATERIAL_READINESS_BUCKETS.some(([value]) => value === nextMaterialBucket) ? nextMaterialBucket : "all");
      setConsumptionVarianceFilter(CONSUMPTION_VARIANCE_BUCKETS.some(([value]) => value === nextConsumptionBucket) ? nextConsumptionBucket : "all");
      loadStoresPending(nextStoresQuery).catch(() => {});
      loadStoresShortageDashboard(nextStoresQuery, STORES_SHORTAGE_BUCKETS.some(([value]) => value === nextShortageBucket) ? nextShortageBucket : "all").catch(() => {});
      loadMaterialReadiness(nextStoresQuery, MATERIAL_READINESS_BUCKETS.some(([value]) => value === nextMaterialBucket) ? nextMaterialBucket : "all").catch(() => {});
      loadConsumptionVariance(
        nextStoresQuery,
        CONSUMPTION_VARIANCE_BUCKETS.some(([value]) => value === nextConsumptionBucket) ? nextConsumptionBucket : "all"
      ).catch(() => {});
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [view.type, launch, onConsumeLaunch]);

  const filteredBoms = useMemo(
    () =>
      (bootstrap.boms || []).filter((row) =>
        createForm.finished_good_product_id ? String(row.finished_good_product_id) === String(createForm.finished_good_product_id) : true
      ),
    [bootstrap.boms, createForm.finished_good_product_id]
  );
  const selectedLaunchFg = useMemo(
    () => (bootstrap.finished_goods || []).find((row) => String(row.id) === String(createForm.finished_good_product_id)) || null,
    [bootstrap.finished_goods, createForm.finished_good_product_id]
  );
  const selectedLaunchSoLine = useMemo(
    () => salesOrderLineMap.get(String(createForm.sales_order_line_id || "")) || null,
    [salesOrderLineMap, createForm.sales_order_line_id]
  );
  const launchReadiness = useMemo(() => {
    if (createForm.job_type !== "manufacturing") return null;
    const warnings = [];
    if (createForm.manufacturing_mode === "so_linked" && !createForm.sales_order_line_id) warnings.push("Pick a sales-order line first.");
    if (createForm.manufacturing_mode === "standalone" && !createForm.finished_good_product_id) warnings.push("Pick a finished good first.");
    if (selectedLaunchFg && selectedLaunchFg.sourcing_mode === "buy_intercompany") {
      warnings.push(`This finished good is supplied from ${selectedLaunchFg.intercompany_source_company_name || "the source company"}. Create the BOM and manufacturing job there.`);
    }
    if (selectedLaunchFg && !selectedLaunchFg.mfg_job_prefix) warnings.push("Selected finished good is missing JobID prefix.");
    if (selectedLaunchFg && filteredBoms.length <= 0) warnings.push("No active BOM is visible for this finished good, so material preload may fail.");
    if (num(createForm.planned_output_qty) <= 0) warnings.push("Planned output must be greater than zero.");
    return {
      mode: createForm.manufacturing_mode === "so_linked" ? "SO-linked manufacturing" : "Standalone manufacturing",
      fgLabel: selectedLaunchFg ? `${selectedLaunchFg.item_code} • ${selectedLaunchFg.item_name}` : "No FG selected yet",
      prefix: selectedLaunchFg?.mfg_job_prefix || "—",
      bomCount: filteredBoms.length,
      warnings,
    };
  }, [createForm.job_type, createForm.manufacturing_mode, createForm.sales_order_line_id, createForm.finished_good_product_id, createForm.planned_output_qty, selectedLaunchFg, filteredBoms]);
  const canCreateManufacturing =
    createForm.job_type !== "manufacturing" ||
    (((createForm.manufacturing_mode === "so_linked" ? createForm.sales_order_line_id : createForm.finished_good_product_id)) && num(createForm.planned_output_qty) > 0);

  const queueStats = useMemo(() => {
    const total = items.length;
    const open = items.filter((row) => ["draft", "open", "submitted", "approved"].includes(String(row.job_status || "").toLowerCase())).length;
    const manufacturing = items.filter((row) => String(row.job_type || "").toLowerCase() === "manufacturing").length;
    const serviceMrn = items.filter((row) => ["service", "installation"].includes(String(row.job_type || "").toLowerCase())).length;
    const withOutput = items.filter((row) => num(row.actual_output_qty) > 0).length;
    const storesPending = storesSummary?.total || 0;
    return { total, open, manufacturing, serviceMrn, withOutput, storesPending };
  }, [items, storesSummary]);

  const queueItems = useMemo(() => {
    if (queueTypeFilter === "service_mrn") {
      return items.filter((row) => ["service", "installation"].includes(String(row.job_type || "").toLowerCase()));
    }
    if (queueTypeFilter === "manufacturing") {
      return items.filter((row) => String(row.job_type || "").toLowerCase() === "manufacturing");
    }
    return items;
  }, [items, queueTypeFilter]);

  const visibleManufacturingIds = useMemo(() => {
    if (panelMode === "queue") {
      return queueItems.filter((row) => String(row.job_type || "").toLowerCase() === "manufacturing").map((row) => Number(row.id));
    }
    if (panelMode === "audit") return auditRows.map((row) => Number(row.id));
    return storesRows.map((row) => Number(row.id));
  }, [panelMode, queueItems, auditRows, storesRows]);

  const selectedJobIdSet = useMemo(() => new Set(selectedJobIds.map((id) => Number(id))), [selectedJobIds]);
  const selectedVisibleIds = useMemo(
    () => visibleManufacturingIds.filter((id) => selectedJobIdSet.has(Number(id))),
    [visibleManufacturingIds, selectedJobIdSet]
  );
  const selectedJobIdsKey = useMemo(
    () => selectedJobIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0).sort((a, b) => a - b).join(","),
    [selectedJobIds]
  );

  function updateCreateForm(patch) {
    setCreateForm((prev) => ({ ...prev, ...patch }));
  }

  function toggleSelectedJob(id) {
    const nextId = Number(id);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    setSelectedJobIds((prev) => (prev.includes(nextId) ? prev.filter((item) => item !== nextId) : [...prev, nextId]));
  }

  function selectVisibleJobs() {
    setSelectedJobIds((prev) => [...new Set([...prev, ...visibleManufacturingIds])]);
  }

  function clearSelectedJobs() {
    setSelectedJobIds([]);
  }

  function clearVisibleSelection() {
    setSelectedJobIds((prev) => prev.filter((id) => !visibleManufacturingIds.includes(Number(id))));
  }

  function refreshAudit(nextPatch = null) {
    const next = nextPatch ? { ...auditFilters, ...nextPatch } : auditFilters;
    if (nextPatch) setAuditFilters(next);
    loadManufacturingAudit(next).catch(() => {});
  }

  function refreshStores(nextQuery = storesQuery) {
    Promise.all([
      loadStoresPending(nextQuery),
      loadStoresShortageDashboard(nextQuery, storesShortageFilter),
      loadMaterialReadiness(nextQuery, materialReadinessFilter),
      loadConsumptionVariance(nextQuery, consumptionVarianceFilter),
    ]).catch(() => {});
  }

  useEffect(() => {
    if (panelMode !== "stores" || !selectedJobIdsKey) {
      setStoresBatchPlan(null);
    }
  }, [panelMode, selectedJobIdsKey]);

  async function loadStoresBatchIssuePlan(ids = selectedJobIds, { silent = false } = {}) {
    const normalizedIds = Array.isArray(ids) ? ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) : [];
    if (!normalizedIds.length) {
      setStoresBatchPlan(null);
      if (!silent) setError("Select at least one stores job first.");
      return null;
    }
    setStoresBatchPlanLoading(true);
    if (!silent) {
      setError("");
      setNotice("");
    }
    try {
      const params = new URLSearchParams();
      params.set("ids", normalizedIds.join(","));
      const data = await apiFetch(`/job-cards/stores-batch-issue-plan?${params.toString()}`);
      const plan = {
        jobs: Array.isArray(data?.jobs) ? data.jobs : [],
        summary: data?.summary || null,
      };
      setStoresBatchPlan(plan);
      if (!silent && !plan.jobs.length) setNotice("No pending stores lines remain for the selected jobs.");
      return plan;
    } catch (_e) {
      if (!silent) setError("Failed to load stores batch plan.");
      return null;
    } finally {
      setStoresBatchPlanLoading(false);
    }
  }

  async function openStoresBatchJob(targetJobId = null) {
    let plan = storesBatchPlan;
    if (!plan) {
      plan = await loadStoresBatchIssuePlan(selectedJobIds, { silent: false });
      if (!plan) return;
    }
    const jobIds = Array.isArray(plan?.jobs) ? plan.jobs.map((job) => Number(job.job_card_id)).filter((id) => Number.isFinite(id) && id > 0) : [];
    if (!jobIds.length) {
      setNotice("No pending stores jobs are left in the selected batch.");
      return;
    }
    const nextId = Number(targetJobId);
    const chosenId = Number.isFinite(nextId) && jobIds.includes(nextId) ? nextId : jobIds[0];
    if (Number(quickIssueJobId) === chosenId) return;
    await openStoresQuickIssue(chosenId, { keepOpenIfSameJob: true });
  }

  async function openNextStoresBatchJob() {
    let plan = storesBatchPlan;
    if (!plan) {
      plan = await loadStoresBatchIssuePlan(selectedJobIds, { silent: false });
      if (!plan) return;
    }
    const jobIds = Array.isArray(plan?.jobs) ? plan.jobs.map((job) => Number(job.job_card_id)).filter((id) => Number.isFinite(id) && id > 0) : [];
    if (!jobIds.length) {
      setNotice("No pending stores jobs are left in the selected batch.");
      return;
    }
    const currentId = Number(quickIssueJobId);
    const currentIndex = jobIds.findIndex((id) => id === currentId);
    const nextId = currentIndex >= 0 && currentIndex < jobIds.length - 1 ? jobIds[currentIndex + 1] : jobIds[0];
    if (currentId === nextId && jobIds.length === 1) return;
    await openStoresQuickIssue(nextId, { keepOpenIfSameJob: true });
  }

  async function openStoresQuickIssue(jobId, options = {}) {
    const nextId = Number(jobId);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    const preferredLineId = Number(options.lineId);
    const keepOpenIfSameJob = options.keepOpenIfSameJob === true || Number.isFinite(preferredLineId);
    if (quickIssueJobId === nextId && !keepOpenIfSameJob) {
      setQuickIssueJobId(null);
      setQuickIssueLines([]);
      setQuickIssueForm(buildStoresQuickIssueForm([]));
      return;
    }
    if (quickIssueJobId === nextId && keepOpenIfSameJob && quickIssueLines.length) {
      setQuickIssueForm(
        buildStoresQuickIssueForm(quickIssueLines, {
          ...quickIssueForm,
          line_id: Number.isFinite(preferredLineId) && preferredLineId > 0 ? String(preferredLineId) : quickIssueForm.line_id,
          qty: options.qty,
          reference_no: options.reference_no !== undefined ? options.reference_no : quickIssueForm.reference_no,
          remarks: options.remarks !== undefined ? options.remarks : quickIssueForm.remarks,
          movement_date: options.movement_date || quickIssueForm.movement_date || todayIsoDate(),
        })
      );
      return;
    }
    setQuickIssueLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/job-cards/${nextId}`);
      const lines = Array.isArray(data?.lines) ? data.lines : [];
      const eligible = lines.filter((line) => pendingToIssueQty(line) > 0);
      setQuickIssueJobId(nextId);
      setQuickIssueLines(eligible);
      setQuickIssueForm(
        buildStoresQuickIssueForm(eligible, {
          line_id: Number.isFinite(preferredLineId) && preferredLineId > 0 ? String(preferredLineId) : "",
          qty: options.qty,
          reference_no: options.reference_no || "",
          remarks: options.remarks || "",
          movement_date: options.movement_date || todayIsoDate(),
        })
      );
      if (!eligible.length) setNotice("No pending material lines remain on this job.");
    } catch (_e) {
      setError("Failed to load quick issue lines.");
    } finally {
      setQuickIssueLoading(false);
    }
  }

  async function openShortageDesk(jobId) {
    const nextId = Number(jobId);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    if (shortageDeskJobId === nextId) {
      setShortageDeskJobId(null);
      setShortageDeskLines([]);
      setShortageDeskActions([]);
      setShortageActionForm(buildShortageActionForm([]));
      return;
    }
    setShortageDeskLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/job-cards/${nextId}`);
      const lines = Array.isArray(data?.lines) ? data.lines : [];
      const eligible = lines.filter((line) => pendingToIssueQty(line) > 0);
      const actions = Array.isArray(data?.shortage_actions) ? data.shortage_actions : [];
      setShortageDeskJobId(nextId);
      setShortageDeskLines(eligible);
      setShortageDeskActions(actions);
      setShortageActionForm(buildShortageActionForm(eligible));
      if (!eligible.length) setNotice("No pending stores lines remain on this job.");
    } catch (_e) {
      setError("Failed to load shortage desk.");
    } finally {
      setShortageDeskLoading(false);
    }
  }

  async function submitShortageAction(jobId) {
    const nextId = Number(jobId);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    if (!shortageActionForm.line_id) {
      setError("Select a line first.");
      return;
    }
    setShortageDeskSubmitting(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        line_id: Number(shortageActionForm.line_id),
        action_type: shortageActionForm.action_type,
        action_date: shortageActionForm.action_date || null,
        shortage_qty: shortageActionForm.shortage_qty === "" ? null : num(shortageActionForm.shortage_qty),
        reference_no: shortageActionForm.reference_no || null,
        expected_date: shortageActionForm.expected_date || null,
        remarks: shortageActionForm.remarks || null,
      };
      const data = await apiFetch(`/job-cards/${nextId}/shortage-actions`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const nextLines = Array.isArray(data?.lines) ? data.lines.filter((line) => pendingToIssueQty(line) > 0) : [];
      setShortageDeskLines(nextLines);
      setShortageDeskActions(Array.isArray(data?.shortage_actions) ? data.shortage_actions : shortageDeskActions);
      setShortageActionForm(buildShortageActionForm(nextLines, { action_type: shortageActionForm.action_type, action_date: todayIsoDate() }));
      await Promise.all([
        loadStoresPending(storesQuery),
        loadStoresShortageDashboard(storesQuery),
        loadConsumptionVariance(storesQuery),
        loadManufacturingAudit(auditFilters),
        loadList(),
        storesBatchPlan ? loadStoresBatchIssuePlan(selectedJobIds, { silent: true }) : Promise.resolve(null),
      ]);
      setNotice("Stores shortage action recorded.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to record shortage action."));
    } finally {
      setShortageDeskSubmitting(false);
    }
  }

  async function raisePurchaseRequisitionFromShortageAction(actionId) {
    const nextId = Number(actionId);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    setRaisingRequisitionActionId(nextId);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/purchase-requisitions/from-shortage-action", {
        method: "POST",
        body: JSON.stringify({ shortage_action_id: nextId }),
      });
      const requisitionId = Number(data?.purchase_requisition?.id || 0);
      if (typeof onOpenPurchaseRequisition === "function" && requisitionId > 0) {
        onOpenPurchaseRequisition(requisitionId);
        return;
      }
      setNotice(`Purchase requisition ${data?.purchase_requisition?.requisition_number || ""} created.`.trim());
    } catch (e) {
      const existingId = Number(e?.data?.purchase_requisition_id || 0);
      if (typeof onOpenPurchaseRequisition === "function" && existingId > 0) {
        onOpenPurchaseRequisition(existingId);
        return;
      }
      setError(friendlyError(e?.data?.error, "Failed to raise purchase requisition."));
    } finally {
      setRaisingRequisitionActionId(null);
    }
  }

  async function reopenShortageForIssue(action) {
    const jobId = Number(action?.job_card_id);
    const lineId = Number(action?.job_card_line_id);
    const qty = Math.max(Math.min(num(action?.current_pending_issue_qty), num(action?.current_stock_qty)), 0);
    if (!Number.isFinite(jobId) || jobId <= 0 || !Number.isFinite(lineId) || lineId <= 0 || qty <= 0) {
      setError("This shortage action is not ready for re-issue.");
      return;
    }
    await openStoresQuickIssue(jobId, {
      lineId,
      qty,
      remarks: `Re-issue after shortage coverage (${SHORTAGE_ACTION_OPTIONS.find(([value]) => value === action.action_type)?.[1] || "Shortage Action"})`,
      keepOpenIfSameJob: true,
    });
    setNotice("Quick issue opened from shortage lifecycle.");
  }

  async function submitStoresQuickIssue(jobId) {
    const nextId = Number(jobId);
    if (!Number.isFinite(nextId) || nextId <= 0) return;
    if (!quickIssueForm.line_id) {
      setError("Select a line first.");
      return;
    }
    if (num(quickIssueForm.qty) <= 0) {
      setError("Enter a valid quantity.");
      return;
    }
    const serials = String(quickIssueForm.serial_text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    setQuickIssueSubmitting(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/job-cards/${nextId}/movements`, {
        method: "POST",
        body: JSON.stringify({
          line_id: Number(quickIssueForm.line_id),
          movement_type: "issue",
          qty: num(quickIssueForm.qty),
          movement_date: quickIssueForm.movement_date || null,
          reference_no: quickIssueForm.reference_no || null,
          remarks: quickIssueForm.remarks || null,
          serials,
        }),
      });
      const nextLines = Array.isArray(data?.lines) ? data.lines.filter((line) => pendingToIssueQty(line) > 0) : [];
      setQuickIssueLines(nextLines);
      setQuickIssueForm(buildStoresQuickIssueForm(nextLines, { movement_date: todayIsoDate() }));
      if (!nextLines.length) {
        setQuickIssueJobId(null);
        setQuickIssueLines([]);
        setQuickIssueForm(buildStoresQuickIssueForm([]));
      }
      await Promise.all([
        loadStoresPending(storesQuery),
        loadStoresShortageDashboard(storesQuery),
        loadConsumptionVariance(storesQuery),
        loadManufacturingAudit(auditFilters),
        loadList(),
      ]);
      const refreshedPlan = storesBatchPlan ? await loadStoresBatchIssuePlan(selectedJobIds, { silent: true }) : null;
      if (!nextLines.length && refreshedPlan?.jobs?.length) {
        const nextBatchId = Number(refreshedPlan.jobs[0]?.job_card_id);
        if (Number.isFinite(nextBatchId) && nextBatchId > 0) {
          await openStoresQuickIssue(nextBatchId);
        }
      }
      setNotice("Material issue recorded from Stores desk.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to record material issue."));
    } finally {
      setQuickIssueSubmitting(false);
    }
  }

  async function selectAllAcrossFilter() {
    if (panelMode !== "audit" && panelMode !== "stores") return;
    setSelectAllLoading(true);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams();
      let url = "";
      if (panelMode === "audit") {
        if (auditFilters.status && auditFilters.status !== "all") params.set("status", auditFilters.status);
        if (auditFilters.mode && auditFilters.mode !== "all") params.set("mode", auditFilters.mode);
        if (auditFilters.exception && auditFilters.exception !== "all") params.set("exception", auditFilters.exception);
        if (auditFilters.q && String(auditFilters.q).trim()) params.set("q", String(auditFilters.q).trim());
        url = `/job-cards/manufacturing-audit-ids${params.toString() ? `?${params.toString()}` : ""}`;
      } else {
        if (storesQuery && String(storesQuery).trim()) params.set("q", String(storesQuery).trim());
        url = `/job-cards/stores-pending-ids${params.toString() ? `?${params.toString()}` : ""}`;
      }
      const data = await apiFetch(url);
      const ids = Array.isArray(data?.ids) ? data.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0) : [];
      if (ids.length) {
        setSelectedJobIds((prev) => [...new Set([...prev, ...ids])]);
      }
      if (data?.limited) setNotice(`Selected ${ids.length} jobs across filter (limited).`);
      else setNotice(`Selected ${ids.length} jobs across filter.`);
    } catch (_e) {
      setError("Failed to select jobs across filter.");
    } finally {
      setSelectAllLoading(false);
    }
  }

  async function createJobCard() {
    setCreating(true);
    setError("");
    setNotice("");
    try {
      let path = "/job-cards";
      const payload = {
        job_type: createForm.job_type,
      };

      if (createForm.job_type === "manufacturing") {
        payload.sales_order_line_id = createForm.sales_order_line_id ? Number(createForm.sales_order_line_id) : null;
        payload.finished_good_product_id = createForm.finished_good_product_id ? Number(createForm.finished_good_product_id) : null;
        payload.bom_id = createForm.bom_id ? Number(createForm.bom_id) : null;
        payload.planned_output_qty = num(createForm.planned_output_qty) || 1;
      } else if (createForm.service_case_id) {
        path = `/job-cards/from-service-case/${createForm.service_case_id}`;
      }

      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const id = data?.job_card?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Job card created.");
      setCreateForm(createFormDefaults());
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to create job card."));
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return (
      <JobCardDetail
        id={view.id}
        onBack={() => setView({ type: "list" })}
        canApprove={canApprove}
        onOpenServiceTicket={onOpenServiceTicket}
        advancedDefault={deskMode === "advanced"}
      />
    );
  }

  const showFullAuditDesks = deskMode === "advanced";
  const showProductionProgressDesks = deskMode === "production" || deskMode === "advanced";
  const showStoresPanel = deskMode === "stores" || deskMode === "advanced";
  const showAuditPanel = deskMode === "production" || deskMode === "advanced";

  return (
    <div style={{ maxWidth: 1460, display: "grid", gap: 16 }}>
      <PageHero
        eyebrow="Job operations desk"
        title="Job Cards / Manufacturing"
        description={
          deskMode === "stores"
            ? "Stores mode — material issue, pick lists, and shortage queues first."
            : deskMode === "production"
              ? "Production mode — job progress, output, and completion readiness."
              : deskMode === "service_mrn"
                ? "Service MRN mode — service jobs, returns, and material notes on open tickets."
                : "Advanced mode — full queue, stores, audit, planning, and cost control."
        }
        actions={<button type="button" onClick={() => loadList().catch(() => {})} disabled={loading}>{loading ? "Refreshing..." : "Refresh Queue"}</button>}
        stats={[
          { label: "Jobs In Queue", value: queueStats.total, tone: "#143d7a" },
          { label: "Open / Actionable", value: queueStats.open, tone: "#0a7a35" },
          { label: "Manufacturing", value: queueStats.manufacturing, tone: "#8b5a00" },
          { label: "Service MRNs", value: queueStats.serviceMrn, tone: "#234a8f" },
          { label: "Stores Pending", value: queueStats.storesPending, tone: "#7a4f13" },
        ]}
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, opacity: 0.72 }}>Role mode</span>
        {JOB_DESK_MODES.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setDeskMode(key)}
            style={deskMode === key ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      <DeskPilotBanner
        title="Pilot scope"
        body="Queue = live jobs. Stores = material issue. Audit = planning / cost / release. Open FG Setup when recipe is missing — do not invent BOM lines on the job."
        tone="info"
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                if (!showStoresPanel) setDeskMode("stores");
                setPanelMode("stores");
                saveLastDeskFix({ page: "job_cards", label: "Stores pending", jobCardsLaunch: { panel: "stores" } });
              }}
            >
              Stores
            </button>
            <button
              type="button"
              onClick={() => {
                setDeskMode("advanced");
                setPanelMode("audit");
                saveLastDeskFix({ page: "job_cards", label: "Manufacturing audit", jobCardsLaunch: { panel: "audit" } });
              }}
            >
              Audit
            </button>
            {typeof onOpenManufacturingBoms === "function" ? (
              <button type="button" onClick={() => onOpenManufacturingBoms({ focus: "setup_gaps" })}>
                FG Setup
              </button>
            ) : null}
          </div>
        }
      />

      {error ? <div style={{ color: "#b00020", padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.88fr) minmax(420px, 0.72fr)", gap: 18, alignItems: "start" }}>
        <DeskCard
          title={panelMode === "queue" ? "Active Queue" : panelMode === "audit" ? "Manufacturing Audit" : "Stores Pending Issues"}
          subtitle={
            panelMode === "queue"
              ? "Scan jobs quickly, quick-print manufacturing documents, and open the active work desk"
              : panelMode === "audit"
                ? "Review manufacturing jobs, movements, output, and receipt progress from one register"
                : "Track open manufacturing jobs where stores still need to issue remaining material"
          }
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => setPanelMode("queue")}
                style={panelMode === "queue" ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
              >
                Queue
              </button>
              {showAuditPanel ? (
                <button
                  onClick={() => setPanelMode("audit")}
                  style={panelMode === "audit" ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                >
                  {deskMode === "production" ? "Production progress" : "Audit View"}
                </button>
              ) : null}
              {showStoresPanel ? (
                <button
                  onClick={() => setPanelMode("stores")}
                  style={panelMode === "stores" ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                >
                  Stores
                </button>
              ) : null}
            </div>
          }
        >
          <div
            style={{
              display: "grid",
              gap: 10,
              padding: 12,
              borderRadius: 16,
              background: "#f9fbff",
              border: "1px solid #e8eef7",
              marginBottom: 14,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ fontWeight: 800 }}>
                Selected Manufacturing Jobs: {selectedJobIds.length}
                <span style={{ fontWeight: 500, opacity: 0.68, marginLeft: 8 }}>
                  Visible in this panel: {selectedVisibleIds.length} / {visibleManufacturingIds.length}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={selectVisibleJobs} disabled={!visibleManufacturingIds.length}>Select Visible</button>
                {(panelMode === "audit" || panelMode === "stores") ? (
                  <button onClick={selectAllAcrossFilter} disabled={selectAllLoading}>
                    {selectAllLoading ? "Selecting..." : "Select All Across Filter"}
                  </button>
                ) : null}
                <button onClick={clearVisibleSelection} disabled={!selectedVisibleIds.length}>Clear Visible</button>
                <button onClick={clearSelectedJobs} disabled={!selectedJobIds.length}>Clear All</button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => openBulkManufacturingHtml(selectedJobIds, "issue_slip")} disabled={!selectedJobIds.length}>Bulk Slip</button>
              <button onClick={() => openBulkManufacturingHtml(selectedJobIds, "traveler")} disabled={!selectedJobIds.length}>Bulk Traveler</button>
              <button onClick={() => openBulkManufacturingPdf(selectedJobIds, "issue_slip")} disabled={!selectedJobIds.length}>Bulk Slip PDF</button>
              <button onClick={() => openBulkManufacturingPdf(selectedJobIds, "traveler")} disabled={!selectedJobIds.length}>Bulk Traveler PDF</button>
              {panelMode === "stores" ? (
                <>
                  <button onClick={() => openStoresPickList({ groupBy: "fg", ids: selectedVisibleIds, q: storesQuery })} disabled={!storesRows.length}>Pick List FG</button>
                  <button onClick={() => openStoresPickList({ groupBy: "fg", ids: selectedVisibleIds, q: storesQuery, pdf: true })} disabled={!storesRows.length}>Pick FG PDF</button>
                  <button onClick={() => openStoresPickList({ groupBy: "so", ids: selectedVisibleIds, q: storesQuery })} disabled={!storesRows.length}>Pick List SO</button>
                  <button onClick={() => openStoresPickList({ groupBy: "so", ids: selectedVisibleIds, q: storesQuery, pdf: true })} disabled={!storesRows.length}>Pick SO PDF</button>
                </>
              ) : null}
            </div>
          </div>
          {panelMode === "queue" ? (
          <div style={{ display: "grid", gap: 10, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>Queue filter</span>
              <button type="button" onClick={() => setQueueTypeFilter("all")} style={{ opacity: queueTypeFilter === "all" ? 1 : 0.65 }}>All</button>
              <button type="button" onClick={() => setQueueTypeFilter("service_mrn")} style={{ opacity: queueTypeFilter === "service_mrn" ? 1 : 0.65 }}>Service MRNs</button>
              <button type="button" onClick={() => setQueueTypeFilter("manufacturing")} style={{ opacity: queueTypeFilter === "manufacturing" ? 1 : 0.65 }}>Manufacturing</button>
            </div>
            {loading ? (
              <div>Loading job cards…</div>
            ) : queueItems.length ? (
              queueItems.map((row) => (
                <div
                  key={row.id}
                  onClick={() => setView({ type: "detail", id: row.id })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setView({ type: "detail", id: row.id });
                    }
                  }}
                  style={{
                    cursor: "pointer",
                    border: "1px solid #e7ebf3",
                    borderRadius: 18,
                    padding: 14,
                    background: "#ffffff",
                    boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      {String(row.job_type || "").toLowerCase() === "manufacturing" ? (
                        <input
                          type="checkbox"
                          checked={selectedJobIdSet.has(Number(row.id))}
                          onChange={() => toggleSelectedJob(row.id)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ marginTop: 2 }}
                        />
                      ) : null}
                      <div>
                      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                        {row.job_type}
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>
                        {row.job_card_number}
                        {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 10 }}>• JobID {row.job_id}</span> : null}
                      </div>
                    </div>
                    </div>
                    <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <DeskChip
                      label={
                        row.finished_good_item_code
                          ? `${row.finished_good_item_code} • ${row.finished_good_item_name}`
                          : row.service_ticket_number
                            ? `Ticket ${row.service_ticket_number}${row.service_ticket_customer_name ? ` • ${row.service_ticket_customer_name}` : ""}`
                            : row.service_case_number || "No service case"
                      }
                      tone="#f6f7fb"
                      color="#58627a"
                    />
                    {row.so_number ? <DeskChip label={`SO ${row.so_number}`} tone="#eef4ff" color="#234a8f" /> : null}
                    {row.service_ticket_number ? <DeskChip label={`ST ${row.service_ticket_number}`} tone="#eef4ff" color="#234a8f" /> : null}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                    <MiniMetric label="Requested" value={num(row.total_requested_qty).toFixed(4)} />
                    <MiniMetric label="Issued" value={num(row.total_issued_qty).toFixed(4)} />
                    <MiniMetric label="Returned" value={num(row.total_returned_qty).toFixed(4)} />
                    <MiniMetric label="Output" value={num(row.actual_output_qty).toFixed(4)} />
                  </div>
                  {String(row.job_type || "").toLowerCase() === "manufacturing" ? (
                    <ManufacturingQuickActions id={row.id} />
                  ) : null}
                </div>
              ))
            ) : (
              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                No job cards yet. Create the first one from the launch panel.
              </div>
            )}
          </div>
          ) : panelMode === "audit" ? (
            <div style={{ display: "grid", gap: 12 }}>
              {showFullAuditDesks ? (
              <div style={{ display: "grid", gridTemplateColumns: "1.1fr 160px 180px 200px auto", gap: 10, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Search
                  <input
                    value={auditFilters.q}
                    onChange={(e) => setAuditFilters((prev) => ({ ...prev, q: e.target.value }))}
                    placeholder="Job card, JobID, SO, FG, customer"
                    style={{ height: 34, padding: "0 8px" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Status
                  <select value={auditFilters.status} onChange={(e) => setAuditFilters((prev) => ({ ...prev, status: e.target.value }))} style={{ height: 36 }}>
                    <option value="all">All statuses</option>
                    <option value="draft">Draft</option>
                    <option value="submitted">Submitted</option>
                    <option value="approved">Approved</option>
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                    <option value="posted">Posted</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Mode
                  <select value={auditFilters.mode} onChange={(e) => setAuditFilters((prev) => ({ ...prev, mode: e.target.value }))} style={{ height: 36 }}>
                    <option value="all">All modes</option>
                    <option value="standalone">Standalone</option>
                    <option value="so_linked">SO-linked</option>
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Exception
                  <select value={auditFilters.exception} onChange={(e) => setAuditFilters((prev) => ({ ...prev, exception: e.target.value }))} style={{ height: 36 }}>
                    {AUDIT_EXCEPTION_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <button onClick={() => refreshAudit()} disabled={auditLoading}>
                  {auditLoading ? "Loading..." : "Run Audit"}
                </button>
              </div>
              ) : (
                <div style={{ fontSize: 13, opacity: 0.78, padding: "10px 12px", borderRadius: 12, background: "#f9fbff", border: "1px solid #e6eef8" }}>
                  Production progress view — planning, cost, and full manufacturing audit are available in <strong>Advanced</strong> mode.
                </div>
              )}

              {showFullAuditDesks && (planningReleaseSummary || planningReleaseLoading || planningReleaseRows.length) ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Planning / Job Release Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Prioritize confirmed manufactured demand into release-blocked, ready-to-release, and already-released execution buckets using FG setup, stock cover, and linked job state.</div>
                    </div>
                    <button onClick={() => loadPlanningRelease(auditFilters.q, planningReleaseFilter)} disabled={planningReleaseLoading}>
                      {planningReleaseLoading ? "Refreshing..." : "Refresh Release Desk"}
                    </button>
                  </div>
                  {planningReleaseSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Setup Blocked" value={planningReleaseSummary.releaseBlockedSetup || 0} />
                      <MiniMetric label="Ready Release" value={planningReleaseSummary.readyForRelease || 0} />
                      <MiniMetric label="Released Blocked" value={planningReleaseSummary.releasedMaterialBlocked || 0} />
                      <MiniMetric label="In Execution" value={planningReleaseSummary.releasedInExecution || 0} />
                      <MiniMetric label="Gap Qty" value={num(planningReleaseSummary.productionGapQty).toFixed(4)} />
                      <MiniMetric label="Ready Qty" value={num(planningReleaseSummary.readyReleaseQty).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {PLANNING_RELEASE_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setPlanningReleaseFilter(value);
                          loadPlanningRelease(auditFilters.q, value).catch(() => {});
                        }}
                        style={planningReleaseFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {planningReleaseLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading planning / release queue…</div>
                    ) : planningReleaseRows.length ? (
                      planningReleaseRows.map((row) => {
                        const releaseAppearance = planningReleaseAppearance(
                          row.release_flags?.release_blocked_setup
                            ? "release_blocked_setup"
                            : row.release_flags?.ready_for_release
                              ? "ready_for_release"
                              : row.release_flags?.released_material_blocked
                                ? "released_material_blocked"
                                : row.release_flags?.released_in_execution
                                  ? "released_in_execution"
                                  : "all"
                        );
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open SO";
                        const openPlanningReleaseTarget = () => {
                          if (row.recommended_action === "complete_fg_setup" && typeof onOpenManufacturingBoms === "function") {
                            onOpenManufacturingBoms({
                              finished_good_product_id: row.finished_good_product_id || undefined,
                              finished_good_item_code: row.finished_good_item_code || undefined,
                              focus: "setup_gaps",
                            });
                            return;
                          }
                          if (typeof onOpenSalesOrder === "function") onOpenSalesOrder(Number(row.sales_order_id));
                        };
                        return (
                          <div
                            key={`planning-release-${row.sales_order_line_id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d7e3fb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.so_number}
                                  {row.sales_order_line_no ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• SO Line {row.sales_order_line_no}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"} • {row.customer_name}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={releaseAppearance.label} tone={releaseAppearance.tone} color={releaseAppearance.color} />
                                {row.release_ready_for_job ? <DeskChip label="FG Ready" tone="#eefbf3" color="#147a3d" /> : <DeskChip label="FG Setup Gap" tone="#fff2f2" color="#a52323" />}
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Ordered" value={num(row.qty_ordered).toFixed(4)} />
                              <MiniMetric label="Dispatch Rem" value={num(row.qty_dispatch_remaining).toFixed(4)} />
                              <MiniMetric label="FG Stock" value={num(row.fg_stock_qty).toFixed(4)} />
                              <MiniMetric label="Prod Gap" value={num(row.production_gap_qty).toFixed(4)} />
                              <MiniMetric label="Open Jobs" value={row.open_job_count || 0} />
                              <MiniMetric label="Pending RM" value={num(row.pending_issue_qty).toFixed(4)} />
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Demand age", value: formatDayAge(row.age_days) },
                                { label: "SO date", value: fmtDate(row.order_date) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {(typeof onOpenSalesOrder === "function" || typeof onOpenManufacturingBoms === "function") ? (
                                <button onClick={openPlanningReleaseTarget}>{primaryActionLabel}</button>
                              ) : null}
                              {typeof onOpenManufacturingBoms === "function" ? <button onClick={() => onOpenManufacturingBoms({ finished_good_product_id: row.finished_good_product_id || undefined, finished_good_item_code: row.finished_good_item_code || undefined, focus: "setup_gaps" })}>Open FG Setup</button> : null}
                              <button onClick={() => loadList()}>Refresh Jobs</button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No planning / release items match the current bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {showFullAuditDesks && (planningCapacitySummary || planningCapacityLoading || planningCapacityRows.length) ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f9fff7",
                    border: "1px solid #d9f0d0",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Planning / Capacity Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>
                        Convert unreleased production gap and released job backlog into estimated labor hours using your configured hours-per-output default.
                      </div>
                    </div>
                    <button onClick={() => loadPlanningCapacity(auditFilters.q, planningCapacityFilter)} disabled={planningCapacityLoading}>
                      {planningCapacityLoading ? "Refreshing..." : "Refresh Capacity Desk"}
                    </button>
                  </div>
                  {planningCapacitySummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Setup Blocked Hrs" value={num(planningCapacitySummary.setupBlockedHours).toFixed(4)} />
                      <MiniMetric label="Ready Release Hrs" value={num(planningCapacitySummary.readyForReleaseHours).toFixed(4)} />
                      <MiniMetric label="Backlog Hrs" value={num(planningCapacitySummary.backlogHours).toFixed(4)} />
                      <MiniMetric label="Overdue Hrs" value={num(planningCapacitySummary.overdueHours).toFixed(4)} />
                      <MiniMetric label="Due 7d Hrs" value={num(planningCapacitySummary.due7dHours).toFixed(4)} />
                      <MiniMetric label="Total Hrs" value={num(planningCapacitySummary.totalHours).toFixed(4)} />
                    </div>
                  ) : null}
                  {planningCapacitySummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Demand lines" value={planningCapacitySummary.demandLines || 0} />
                      <MiniMetric label="Backlog jobs" value={planningCapacitySummary.backlogJobs || 0} />
                      <MiniMetric label="Overdue jobs" value={planningCapacitySummary.overdueJobs || 0} />
                      <MiniMetric label="Due 7d jobs" value={planningCapacitySummary.due7dJobs || 0} />
                      <MiniMetric label="Unassigned dept" value={planningCapacitySummary.unassignedDeptJobs || 0} />
                      <MiniMetric label="Dept gap hrs" value={num(planningCapacitySummary.unassignedDeptHours).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {PLANNING_CAPACITY_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setPlanningCapacityFilter(value);
                          loadPlanningCapacity(auditFilters.q, value).catch(() => {});
                        }}
                        style={planningCapacityFilter === value ? { borderColor: "#94c77e", background: "#eefbf3" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {planningCapacityLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading planning / capacity queue…</div>
                    ) : planningCapacityRows.length ? (
                      planningCapacityRows.map((row) => {
                        const rowBucket =
                          row.capacity_flags?.setup_blocked
                            ? "capacity_setup_blocked"
                            : row.capacity_flags?.ready_for_release
                              ? "capacity_ready_for_release"
                              : row.capacity_flags?.overdue
                                ? "capacity_overdue"
                                : row.capacity_flags?.due_7d
                                  ? "capacity_due_7d"
                                  : row.capacity_flags?.unassigned_department
                                    ? "capacity_unassigned_department"
                                    : row.capacity_flags?.future
                                      ? "capacity_future"
                                      : "all";
                        const capAppearance = planningCapacityAppearance(rowBucket);
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || (row.row_type === "job" ? "Open job" : "Open SO");
                        if (row.row_type === "job") {
                          return (
                            <div
                              key={`planning-capacity-job-${row.id}`}
                              style={{
                                display: "grid",
                                gap: 8,
                                padding: 10,
                                borderRadius: 14,
                                background: "#ffffff",
                                border: "1px solid #d8ead3",
                              }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <div style={{ display: "grid", gap: 4 }}>
                                  <div style={{ fontWeight: 800 }}>
                                    {row.job_card_number}
                                    {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                  </div>
                                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                                    {(row.department || "Unassigned dept") + " • " + (row.finished_good_item_code || "—") + " • " + (row.finished_good_item_name || "No FG")}
                                    {row.so_number ? ` • SO ${row.so_number}` : ""}
                                    {row.customer_name ? ` • ${row.customer_name}` : ""}
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                  <DeskChip label={capAppearance.label} tone={capAppearance.tone} color={capAppearance.color} />
                                  <DeskChip label={String(row.job_status || "open").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                                </div>
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                                <MiniMetric label="Planned" value={num(row.planned_output_qty).toFixed(4)} />
                                <MiniMetric label="Actual" value={num(row.actual_output_qty).toFixed(4)} />
                                <MiniMetric label="Remaining" value={num(row.remaining_output_qty).toFixed(4)} />
                                <MiniMetric label="Est hours" value={num(row.estimated_hours).toFixed(4)} />
                                <MiniMetric label="Job date" value={row.job_date ? fmtDate(row.job_date) : "—"} />
                                <MiniMetric label="SO" value={row.so_number || "—"} />
                              </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Movement age", value: formatDayAge(row.age_days) },
                                { label: "Department", value: row.department || "Unassigned" },
                              ]}
                            />
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: row.id })}>{primaryActionLabel}</button>
                                {typeof onOpenSalesOrder === "function" && row.sales_order_id ? (
                                  <button onClick={() => onOpenSalesOrder(Number(row.sales_order_id))}>Open SO</button>
                                ) : null}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={`planning-capacity-demand-${row.sales_order_line_id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d8ead3",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.so_number}
                                  {row.sales_order_line_no ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• SO Line {row.sales_order_line_no}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"} • {row.customer_name}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={capAppearance.label} tone={capAppearance.tone} color={capAppearance.color} />
                                {row.release_ready_for_job ? <DeskChip label="FG Ready" tone="#eefbf3" color="#147a3d" /> : <DeskChip label="FG Setup Gap" tone="#fff2f2" color="#a52323" />}
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Prod gap" value={num(row.production_gap_qty).toFixed(4)} />
                              <MiniMetric label="Est hours" value={num(row.estimated_hours).toFixed(4)} />
                              <MiniMetric label="Dispatch rem" value={num(row.qty_dispatch_remaining).toFixed(4)} />
                              <MiniMetric label="FG stock" value={num(row.fg_stock_qty).toFixed(4)} />
                              <MiniMetric label="Open jobs" value={row.open_job_count || 0} />
                              <MiniMetric label="Pending RM" value={num(row.pending_issue_qty).toFixed(4)} />
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Demand age", value: formatDayAge(row.age_days) },
                                { label: "SO date", value: fmtDate(row.order_date) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {typeof onOpenSalesOrder === "function" ? <button onClick={() => onOpenSalesOrder(Number(row.sales_order_id))}>{primaryActionLabel}</button> : null}
                              {typeof onOpenManufacturingBoms === "function" ? <button onClick={() => onOpenManufacturingBoms({ finished_good_product_id: row.finished_good_product_id || undefined, finished_good_item_code: row.finished_good_item_code || undefined, focus: "setup_gaps" })}>Open FG Setup</button> : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No planning / capacity items match the current bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {showFullAuditDesks && (productionCostSummary || productionCostLoading || productionCostRows.length) ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#fffdfa",
                    border: "1px solid #f2dfbf",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Production Cost / Material Absorption Control</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>
                        Track issued material value, BOM-expected material cost, labor and overhead absorption, and finance-side margin pressure on manufacturing jobs.
                      </div>
                    </div>
                    <button onClick={() => loadProductionCost(auditFilters.q, productionCostFilter)} disabled={productionCostLoading}>
                      {productionCostLoading ? "Refreshing..." : "Refresh Cost Desk"}
                    </button>
                  </div>
                  {productionCostSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Issued No Output" value={productionCostSummary.issuedNoOutput || 0} />
                      <MiniMetric label="Over Issue" value={productionCostSummary.overIssueVsBom || 0} />
                      <MiniMetric label="Under Issue" value={productionCostSummary.underIssueVsBom || 0} />
                      <MiniMetric label="Stalled WIP" value={productionCostSummary.stalledWipValueJobs || 0} />
                      <MiniMetric label="Margin Risk" value={productionCostSummary.marginAtRisk || 0} />
                      <MiniMetric label="Total Absorbed" value={num(productionCostSummary.totalAbsorbedValue).toFixed(4)} />
                    </div>
                  ) : null}
                  {productionCostSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Material Actual" value={num(productionCostSummary.materialActualValue).toFixed(4)} />
                      <MiniMetric label="Expected Material" value={num(productionCostSummary.expectedMaterialValue).toFixed(4)} />
                      <MiniMetric label="Labor Absorbed" value={num(productionCostSummary.laborAbsorbedValue).toFixed(4)} />
                      <MiniMetric label="Overhead Absorbed" value={num(productionCostSummary.overheadAbsorbedValue).toFixed(4)} />
                      <MiniMetric label="Negative Margin" value={num(productionCostSummary.negativeMarginValue).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 14, background: "#ffffff", border: "1px solid #eadfcb" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 800 }}>Defaults (Labor + Overhead)</div>
                      <button onClick={saveCostProfile} disabled={costProfileLoading}>
                        {costProfileLoading ? "Saving..." : "Save Defaults"}
                      </button>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Material Rate Basis
                        <select
                          value={costProfileDraft.material_rate_basis}
                          onChange={(e) => setCostProfileDraft((prev) => ({ ...prev, material_rate_basis: e.target.value }))}
                          style={{ height: 34, padding: "0 8px" }}
                        >
                          <option value="latest_purchase_invoice">Latest posted PI rate</option>
                          <option value="purchase_order_estimate">Latest confirmed PO rate</option>
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Labor Hours / Output
                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          value={costProfileDraft.default_labor_hours_per_output}
                          onChange={(e) => setCostProfileDraft((prev) => ({ ...prev, default_labor_hours_per_output: e.target.value }))}
                          style={{ height: 34, padding: "0 8px" }}
                        />
                      </label>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Labor Hour Rate
                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          value={costProfileDraft.default_labor_hour_rate}
                          onChange={(e) => setCostProfileDraft((prev) => ({ ...prev, default_labor_hour_rate: e.target.value }))}
                          style={{ height: 34, padding: "0 8px" }}
                        />
                      </label>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Overhead Rate / Output
                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          value={costProfileDraft.default_overhead_rate_per_output}
                          onChange={(e) => setCostProfileDraft((prev) => ({ ...prev, default_overhead_rate_per_output: e.target.value }))}
                          style={{ height: 34, padding: "0 8px" }}
                        />
                      </label>
                    </div>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Remarks
                      <input
                        value={costProfileDraft.remarks}
                        onChange={(e) => setCostProfileDraft((prev) => ({ ...prev, remarks: e.target.value }))}
                        style={{ height: 34, padding: "0 8px" }}
                      />
                    </label>
                    {costProfile?.updated_at ? (
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Defaults updated: {new Date(costProfile.updated_at).toLocaleString()}</div>
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Defaults apply when a job has no explicit labor/overhead inputs.</div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {PRODUCTION_COST_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setProductionCostFilter(value);
                          loadProductionCost(auditFilters.q, value).catch(() => {});
                        }}
                        style={productionCostFilter === value ? { borderColor: "#d8b16a", background: "#fff8ea" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {productionCostLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading production cost queue…</div>
                    ) : productionCostRows.length ? (
                      productionCostRows.map((row) => {
                        const costAppearance = productionCostAppearance(
                          row.cost_flags?.issued_no_output
                            ? "issued_no_output"
                            : row.cost_flags?.over_issue_vs_bom
                              ? "over_issue_vs_bom"
                              : row.cost_flags?.under_issue_vs_bom
                                ? "under_issue_vs_bom"
                                : row.cost_flags?.stalled_wip_value
                                  ? "stalled_wip_value"
                                  : row.cost_flags?.margin_at_risk
                                    ? "margin_at_risk"
                                    : row.cost_flags?.ready_cost_review
                                      ? "ready_cost_review"
                                      : "all"
                        );
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open job";
                        return (
                          <div
                            key={`production-cost-${row.id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #eadfcb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.job_card_number}
                                  {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"}
                                  {row.so_number ? ` • SO ${row.so_number}` : ""}
                                  {row.customer_name ? ` • ${row.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={costAppearance.label} tone={costAppearance.tone} color={costAppearance.color} />
                                <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Material Actual" value={num(row.material_actual_value).toFixed(4)} />
                              <MiniMetric label="Expected" value={num(row.expected_material_value_output).toFixed(4)} />
                              <MiniMetric label="Labor" value={num(row.labor_absorbed_value).toFixed(4)} />
                              <MiniMetric label="Overhead" value={num(row.overhead_absorbed_value).toFixed(4)} />
                              <MiniMetric label="Total Cost" value={num(row.total_absorbed_value).toFixed(4)} />
                              <MiniMetric label="SO Margin" value={num(row.margin_vs_sales_order).toFixed(4)} />
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Output Qty" value={num(row.actual_output_qty).toFixed(4)} />
                              <MiniMetric label="Net Issue Qty" value={num(row.net_issue_qty).toFixed(4)} />
                              <MiniMetric label="Absorption" value={num(row.material_absorption_ratio).toFixed(4)} />
                              <MiniMetric label="Invoiced Value" value={num(row.invoiced_line_value_base).toFixed(4)} />
                              <MiniMetric label="Invoice Margin" value={num(row.margin_vs_invoiced).toFixed(4)} />
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Movement age", value: formatDayAge(row.age_days) },
                                { label: "Last movement", value: fmtDate(row.last_movement_date) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: row.id })}>{primaryActionLabel}</button>
                              {typeof onOpenSalesOrder === "function" && row.sales_order_id ? (
                                <button onClick={() => onOpenSalesOrder(Number(row.sales_order_id))}>Open SO</button>
                              ) : null}
                              <button onClick={() => loadProductionCost(auditFilters.q, productionCostFilter)}>Refresh Row Set</button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No production cost items match the current bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {showProductionProgressDesks && (completionDispatchReadinessSummary || completionDispatchReadinessLoading || completionDispatchReadinessRows.length) ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Completion / Dispatch Readiness Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Bridge SO-linked manufacturing completion into dispatchability by checking completion state, FG receipt reflection, and stock coverage against dispatch remaining.</div>
                    </div>
                    <button onClick={() => loadCompletionDispatchReadiness(auditFilters.q, completionDispatchReadinessFilter)} disabled={completionDispatchReadinessLoading}>
                      {completionDispatchReadinessLoading ? "Refreshing..." : "Refresh Dispatch Readiness"}
                    </button>
                  </div>
                  {completionDispatchReadinessSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="SO Jobs" value={completionDispatchReadinessSummary.soLinkedJobs || 0} />
                      <MiniMetric label="Awaiting Completion" value={completionDispatchReadinessSummary.awaitingCompletion || 0} />
                      <MiniMetric label="FG Not Received" value={completionDispatchReadinessSummary.fgNotReceived || 0} />
                      <MiniMetric label="Receipt Mismatch" value={completionDispatchReadinessSummary.receiptMismatch || 0} />
                      <MiniMetric label="FG Stock Short" value={completionDispatchReadinessSummary.stockShort || 0} />
                      <MiniMetric label="Ready Dispatch" value={completionDispatchReadinessSummary.readyForDispatch || 0} />
                      <MiniMetric label="Ready Qty" value={num(completionDispatchReadinessSummary.readyDispatchQty).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {COMPLETION_DISPATCH_READINESS_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setCompletionDispatchReadinessFilter(value);
                          loadCompletionDispatchReadiness(auditFilters.q, value).catch(() => {});
                        }}
                        style={completionDispatchReadinessFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {completionDispatchReadinessLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading completion / dispatch readiness queue…</div>
                    ) : completionDispatchReadinessRows.length ? (
                      completionDispatchReadinessRows.map((row) => {
                        const readinessAppearance = completionDispatchReadinessAppearance(
                          row.dispatch_readiness_flags?.awaiting_completion
                            ? "awaiting_completion"
                            : row.dispatch_readiness_flags?.fg_not_received
                              ? "fg_not_received"
                              : row.dispatch_readiness_flags?.receipt_mismatch
                                ? "receipt_mismatch"
                                : row.dispatch_readiness_flags?.stock_short
                                  ? "stock_short"
                                  : row.dispatch_readiness_flags?.ready_for_dispatch
                                    ? "ready_for_dispatch"
                                    : "all"
                        );
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open job";
                        const openCompletionTarget = () => {
                          if (row.recommended_action === "prepare_dispatch" && typeof onOpenDispatchesDesk === "function" && row.so_number) {
                            onOpenDispatchesDesk({ q: row.so_number, status: "ready" });
                            return;
                          }
                          setView({ type: "detail", id: row.id });
                        };
                        return (
                          <div
                            key={`dispatch-readiness-${row.id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d7e3fb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.job_card_number}
                                  {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"}
                                  {row.so_number ? ` • SO ${row.so_number}` : ""}
                                  {row.customer_name ? ` • ${row.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={readinessAppearance.label} tone={readinessAppearance.tone} color={readinessAppearance.color} />
                                <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                                {row.sales_order_line_no ? <DeskChip label={`SO Line ${row.sales_order_line_no}`} tone="#eef4ff" color="#234a8f" /> : null}
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Ordered" value={num(row.qty_ordered).toFixed(4)} />
                              <MiniMetric label="Dispatched" value={num(row.qty_dispatched).toFixed(4)} />
                              <MiniMetric label="Remaining" value={num(row.qty_dispatch_remaining).toFixed(4)} />
                              <MiniMetric label="FG Stock" value={num(row.fg_stock_qty).toFixed(4)} />
                              <MiniMetric label="Output" value={num(row.actual_output_qty).toFixed(4)} />
                              <MiniMetric label="Posted FG Qty" value={num(row.receipt_posted_qty).toFixed(4)} />
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.78 }}>
                              {(row.dispatch_readiness_labels || []).length ? row.dispatch_readiness_labels.join(" • ") : "No dispatch-readiness signals"}
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Movement age", value: formatDayAge(row.age_days) },
                                { label: "Remaining qty", value: num(row.qty_dispatch_remaining).toFixed(4) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={openCompletionTarget}>{primaryActionLabel}</button>
                              {Number(row.sales_order_id) > 0 && typeof onOpenSalesOrder === "function" ? (
                                <button onClick={() => onOpenSalesOrder(Number(row.sales_order_id))}>Open SO</button>
                              ) : null}
                              {typeof onOpenDispatchesDesk === "function" && row.so_number ? (
                                <button onClick={() => onOpenDispatchesDesk({ q: row.so_number, status: "ready" })}>Open Dispatch Desk</button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No completion / dispatch readiness items match the current bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {showFullAuditDesks && (fgReceiptReconciliationSummary || fgReceiptReconciliationLoading || fgReceiptReconciliationRows.length) ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>FG Receipt Reconciliation Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Match manufacturing output to the actual `MANUFACTURING_RECEIPT` movements that hit stock, then chase quantity, date, and premature-posting exceptions.</div>
                    </div>
                    <button onClick={() => loadFgReceiptReconciliation(auditFilters.q, fgReceiptReconciliationFilter)} disabled={fgReceiptReconciliationLoading}>
                      {fgReceiptReconciliationLoading ? "Refreshing..." : "Refresh FG Reconciliation"}
                    </button>
                  </div>
                  {fgReceiptReconciliationSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Awaiting Final" value={fgReceiptReconciliationSummary.awaitingFinalPost || 0} />
                      <MiniMetric label="Not Reflected" value={fgReceiptReconciliationSummary.receiptNotReflected || 0} />
                      <MiniMetric label="Qty Mismatch" value={fgReceiptReconciliationSummary.receiptQtyMismatch || 0} />
                      <MiniMetric label="Date Mismatch" value={fgReceiptReconciliationSummary.receiptDateMismatch || 0} />
                      <MiniMetric label="Premature" value={fgReceiptReconciliationSummary.prematureReceipt || 0} />
                      <MiniMetric label="Final No Output" value={fgReceiptReconciliationSummary.finalWithoutOutput || 0} />
                      <MiniMetric label="Reconciled" value={fgReceiptReconciliationSummary.reconciled || 0} />
                      <MiniMetric label="Posted FG Qty" value={num(fgReceiptReconciliationSummary.postedReceiptQty).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {FG_RECEIPT_RECONCILIATION_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setFgReceiptReconciliationFilter(value);
                          loadFgReceiptReconciliation(auditFilters.q, value).catch(() => {});
                        }}
                        style={fgReceiptReconciliationFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {fgReceiptReconciliationLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading FG receipt reconciliation queue…</div>
                    ) : fgReceiptReconciliationRows.length ? (
                      fgReceiptReconciliationRows.map((row) => {
                        const receiptAppearance = fgReceiptReconciliationAppearance(
                          row.fg_receipt_flags?.receipt_not_reflected
                            ? "receipt_not_reflected"
                            : row.fg_receipt_flags?.receipt_qty_mismatch
                              ? "receipt_qty_mismatch"
                              : row.fg_receipt_flags?.receipt_date_mismatch
                                ? "receipt_date_mismatch"
                                : row.fg_receipt_flags?.premature_receipt
                                  ? "premature_receipt"
                                  : row.fg_receipt_flags?.final_without_output
                                    ? "final_without_output"
                                    : row.fg_receipt_flags?.awaiting_final_post
                                      ? "awaiting_final_post"
                                      : "all"
                        );
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open job";
                        return (
                          <div
                            key={`fg-receipt-${row.id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d7e3fb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.job_card_number}
                                  {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"}
                                  {row.so_number ? ` • SO ${row.so_number}` : ""}
                                  {row.customer_name ? ` • ${row.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={receiptAppearance.label} tone={receiptAppearance.tone} color={receiptAppearance.color} />
                                <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                                {row.receipt_movement_count ? <DeskChip label={`Receipts ${row.receipt_movement_count}`} tone="#eefbf3" color="#147a3d" /> : null}
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Actual Output" value={num(row.actual_output_qty).toFixed(4)} />
                              <MiniMetric label="Posted Qty" value={num(row.receipt_posted_qty).toFixed(4)} />
                              <MiniMetric label="Qty Gap" value={num(row.receipt_qty_gap).toFixed(4)} />
                              <MiniMetric label="FG Stock" value={num(row.fg_stock_qty).toFixed(4)} />
                              <MiniMetric label="Receipt Date" value={fmtDate(row.finished_good_receipt_date)} />
                              <MiniMetric label="Ledger Date" value={fmtDate(row.receipt_last_movement_date)} />
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.78 }}>
                              {(row.fg_receipt_labels || []).length ? row.fg_receipt_labels.join(" • ") : "No FG receipt exception labels"}
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Movement age", value: formatDayAge(row.age_days) },
                                { label: "Qty gap", value: num(row.receipt_qty_gap).toFixed(4) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: row.id })}>{primaryActionLabel}</button>
                              <button onClick={() => openTraveler(row.id)}>Traveler</button>
                              {Number(row.finished_good_product_id) > 0 && typeof onOpenStockLedger === "function" ? (
                                <button onClick={() => onOpenStockLedger(Number(row.finished_good_product_id), row.finished_good_item_code || row.finished_good_item_name || "")}>
                                  Open FG Ledger
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No FG receipt reconciliation items match the current bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {showProductionProgressDesks && (productionExecutionSummary || productionExecutionLoading || productionExecutionRows.length) ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Production Execution Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Prioritize jobs that are ready to close, carrying output without final posting, stalled on the floor, or sitting in risky final status.</div>
                    </div>
                    <button onClick={() => loadProductionExecution(auditFilters.q, productionExecutionFilter)} disabled={productionExecutionLoading}>
                      {productionExecutionLoading ? "Refreshing..." : "Refresh Execution Desk"}
                    </button>
                  </div>
                  {productionExecutionSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Open Jobs" value={productionExecutionSummary.openJobs || 0} />
                      <MiniMetric label="Ready Close" value={productionExecutionSummary.readyToClose || 0} />
                      <MiniMetric label="Output Pending" value={productionExecutionSummary.outputPendingClose || 0} />
                      <MiniMetric label="Receipt Missing" value={productionExecutionSummary.receiptMissing || 0} />
                      <MiniMetric label="Stalled WIP" value={productionExecutionSummary.stalledWip || 0} />
                      <MiniMetric label="Pending RM" value={productionExecutionSummary.pendingRm || 0} />
                      <MiniMetric label="Final Risk" value={productionExecutionSummary.finalStatusRisk || 0} />
                      <MiniMetric label="Open Output Qty" value={num(productionExecutionSummary.outputQtyInOpenJobs).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {PRODUCTION_EXECUTION_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setProductionExecutionFilter(value);
                          loadProductionExecution(auditFilters.q, value).catch(() => {});
                        }}
                        style={productionExecutionFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {productionExecutionLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading production execution queue…</div>
                    ) : productionExecutionRows.length ? (
                      productionExecutionRows.map((row) => {
                        const executionAppearance = productionExecutionAppearance(row.execution_bucket);
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open job";
                        return (
                          <div
                            key={`execution-${row.id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d7e3fb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.job_card_number}
                                  {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"}
                                  {row.so_number ? ` • SO ${row.so_number}` : ""}
                                  {row.customer_name ? ` • ${row.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={executionAppearance.label} tone={executionAppearance.tone} color={executionAppearance.color} />
                                <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                                {row.manufacturing_mode === "so_linked" ? <DeskChip label="SO-linked" tone="#eef4ff" color="#234a8f" /> : <DeskChip label="Standalone" tone="#f6f7fb" color="#58627a" />}
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Planned" value={num(row.planned_output_qty).toFixed(4)} />
                              <MiniMetric label="Actual" value={num(row.actual_output_qty).toFixed(4)} />
                              <MiniMetric label="Pending RM" value={num(row.pending_issue_qty).toFixed(4)} />
                              <MiniMetric label="Moves" value={row.movement_count || 0} />
                              <MiniMetric label="Low Stock" value={row.low_stock_line_count || 0} />
                              <MiniMetric label="Receipt" value={fmtDate(row.finished_good_receipt_date)} />
                            </div>
                            <div style={{ marginTop: 2, padding: 12, borderRadius: 14, background: "#f8fbff", border: "1px solid #e6eef8" }}>
                              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>Why this needs attention</div>
                              <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                                {row.queue_reason || "Review the manufacturing job and take the next production step."}
                              </div>
                            </div>
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                                gap: 10,
                                padding: 12,
                                borderRadius: 14,
                                background: "#fcfdff",
                                border: "1px solid #edf1f8",
                              }}
                            >
                              <div>
                                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Next action</div>
                                <div style={{ marginTop: 4, fontWeight: 700 }}>{row.recommended_action_label || "Open job"}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Movement age</div>
                                <div style={{ marginTop: 4, fontWeight: 700 }}>{formatDayAge(row.age_days)}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Last movement</div>
                                <div style={{ marginTop: 4, fontWeight: 700 }}>{fmtDate(row.last_movement_date)}</div>
                              </div>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.78 }}>
                              Job Date {fmtDate(row.job_date)} • Last Movement {fmtDate(row.last_movement_date)}
                              {(row.audit_labels || []).length ? ` • ${row.audit_labels.join(" • ")}` : ""}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: row.id })}>{primaryActionLabel}</button>
                              <button onClick={() => openTraveler(row.id)}>Traveler</button>
                              <button onClick={() => openIssueSlip(row.id)}>Issue Slip</button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No jobs match the current production-execution bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {showFullAuditDesks && auditSummary ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                    <MiniMetric label="Rows" value={auditSummary.total || 0} />
                    <MiniMetric label="Scope" value={auditSummary.scopeTotal || auditSummary.total || 0} />
                    <MiniMetric label="Open" value={auditSummary.open || 0} />
                    <MiniMetric label="Closed/Posted" value={auditSummary.postedOrClosed || 0} />
                    <MiniMetric label="Ready" value={auditSummary.exceptionCounts?.ready || 0} />
                    <MiniMetric label="Pending RM" value={auditSummary.exceptionCounts?.pending_issue || 0} />
                    <MiniMetric label="Final Risk" value={auditSummary.exceptionCounts?.final_risk || 0} />
                    <MiniMetric label="With Output" value={auditSummary.withOutput || 0} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {AUDIT_EXCEPTION_OPTIONS.filter(([value]) => value !== "all").map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => refreshAudit({ exception: value })}
                        style={auditFilters.exception === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}: {auditSummary.exceptionCounts?.[value] || 0}
                      </button>
                    ))}
                    <button
                      onClick={() => refreshAudit({ exception: "all" })}
                      style={auditFilters.exception === "all" ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                    >
                      Reset Exception Filter
                    </button>
                  </div>
                </div>
              ) : null}

              {showFullAuditDesks ? (
              <div style={{ display: "grid", gap: 10, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
                {auditLoading ? (
                  <div>Loading manufacturing audit…</div>
                ) : auditRows.length ? (
                  auditRows.map((row) => (
                    <div
                      key={row.id}
                      onClick={() => setView({ type: "detail", id: row.id })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setView({ type: "detail", id: row.id });
                        }
                      }}
                      style={{
                        cursor: "pointer",
                        border: "1px solid #e7ebf3",
                        borderRadius: 18,
                        padding: 14,
                        background: "#ffffff",
                        boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <input
                            type="checkbox"
                            checked={selectedJobIdSet.has(Number(row.id))}
                            onChange={() => toggleSelectedJob(row.id)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ marginTop: 2 }}
                          />
                          <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                            {row.manufacturing_mode === "so_linked" ? "SO-linked manufacturing" : "Standalone manufacturing"}
                          </div>
                          <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>
                            {row.job_card_number}
                            {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 10 }}>• JobID {row.job_id}</span> : null}
                          </div>
                        </div>
                        </div>
                        <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <DeskChip label={`${row.finished_good_item_code || "—"} • ${row.finished_good_item_name || "No FG"}`} tone="#f6f7fb" color="#58627a" />
                        {row.so_number ? <DeskChip label={`SO ${row.so_number}`} tone="#eef4ff" color="#234a8f" /> : null}
                        {row.customer_name ? <DeskChip label={row.customer_name} tone="#eefbf3" color="#147a3d" /> : null}
                        {(row.audit_labels || []).map((label) => {
                          const appearance = getAuditExceptionAppearance(label);
                          return <DeskChip key={`${row.id}-${label}`} label={label} tone={appearance.tone} color={appearance.color} />;
                        })}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Requested" value={num(row.total_requested_qty).toFixed(4)} />
                        <MiniMetric label="Issued" value={num(row.total_issued_qty).toFixed(4)} />
                        <MiniMetric label="Returned" value={num(row.total_returned_qty).toFixed(4)} />
                        <MiniMetric label="Pending RM" value={num(row.pending_issue_qty).toFixed(4)} />
                        <MiniMetric label="Output" value={num(row.actual_output_qty).toFixed(4)} />
                        <MiniMetric label="Moves" value={row.movement_count || 0} />
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                        Job Date: <strong>{fmtDate(row.job_date)}</strong> • Last Movement: <strong>{fmtDate(row.last_movement_date)}</strong> • FG Receipt: <strong>{fmtDate(row.finished_good_receipt_date)}</strong>
                      </div>
                      <ManufacturingQuickActions id={row.id} />
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                    No manufacturing transactions match the current audit filters.
                  </div>
                )}
              </div>
              ) : null}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Search
                  <input
                    value={storesQuery}
                    onChange={(e) => setStoresQuery(e.target.value)}
                    placeholder="Job card, JobID, SO, FG, customer"
                    style={{ height: 34, padding: "0 8px" }}
                  />
                </label>
                <button onClick={() => refreshStores()} disabled={storesLoading}>
                  {storesLoading ? "Loading..." : "Run Stores View"}
                </button>
              </div>

              {storesSummary ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                  <MiniMetric label="Jobs" value={storesSummary.total || 0} />
                  <MiniMetric label="Pending Qty" value={num(storesSummary.pendingIssueQty).toFixed(4)} />
                  <MiniMetric label="Pending Lines" value={storesSummary.pendingLines || 0} />
                  <MiniMetric label="Low Stock Jobs" value={storesSummary.lowStockJobs || 0} />
                  <MiniMetric label="SO-Linked" value={storesSummary.soLinked || 0} />
                </div>
              ) : null}

              {materialReadinessSummary || materialReadinessLoading || materialReadinessRows.length ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Material Readiness Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Combine FG setup gaps with shortage execution so factory work moves from missing master-data to re-issue-ready supply.</div>
                    </div>
                    <button onClick={() => loadMaterialReadiness(storesQuery, materialReadinessFilter)} disabled={materialReadinessLoading}>
                      {materialReadinessLoading ? "Refreshing..." : "Refresh Material Desk"}
                    </button>
                  </div>
                  {materialReadinessSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="FG Gaps" value={materialReadinessSummary.fgSetupGaps || 0} />
                      <MiniMetric label="Missing Prefix" value={materialReadinessSummary.missingPrefix || 0} />
                      <MiniMetric label="BOM Gaps" value={materialReadinessSummary.bomGaps || 0} />
                      <MiniMetric label="Not Raised" value={materialReadinessSummary.shortageNotRaised || 0} />
                      <MiniMetric label="In Procurement" value={materialReadinessSummary.procurementInFlight || 0} />
                      <MiniMetric label="Blocked" value={materialReadinessSummary.blockedSupply || 0} />
                      <MiniMetric label="Ready Re-Issue" value={materialReadinessSummary.readyForReissue || 0} />
                      <MiniMetric label="Pending RM Qty" value={num(materialReadinessSummary.pendingIssueQty).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {MATERIAL_READINESS_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setMaterialReadinessFilter(value);
                          loadMaterialReadiness(storesQuery, value).catch(() => {});
                        }}
                        style={materialReadinessFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {materialReadinessLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading material readiness queue…</div>
                    ) : materialReadinessRows.length ? (
                      materialReadinessRows.map((row) => {
                        if (row.row_type === "fg_readiness") {
                          const readinessAppearance = materialReadinessStatusAppearance(row.readiness_status);
                          const focusQuery = row.item_code || row.item_name || "";
                          const attention = attentionAppearance(row.attention_level);
                          const primaryActionLabel = row.recommended_action_label || "Open Manufacturing Desk";
                          return (
                            <div
                              key={`material-fg-${row.product_id}`}
                              style={{
                                display: "grid",
                                gap: 8,
                                padding: 10,
                                borderRadius: 14,
                                background: "#ffffff",
                                border: "1px solid #d7e3fb",
                              }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <div style={{ display: "grid", gap: 4 }}>
                                  <div style={{ fontWeight: 800 }}>
                                    {row.item_code || "—"}
                                    {row.item_name ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• {row.item_name}</span> : null}
                                  </div>
                                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                                    {row.readiness_note || "Manufacturing setup needs review."}
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                  <DeskChip label={readinessAppearance.label} tone={readinessAppearance.tone} color={readinessAppearance.color} />
                                  <DeskChip label={`Prefix ${row.mfg_job_prefix || "—"}`} tone="#f6f7fb" color="#58627a" />
                                  <DeskChip label={`Active BOM ${row.active_bom_count || 0}`} tone="#eef4ff" color="#234a8f" />
                                  <DeskChip label={`Open Jobs ${row.open_job_count || 0}`} tone="#eefbf3" color="#147a3d" />
                                  {row.recommended_action_label ? (
                                    <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                  ) : null}
                                  {Number(row.jobs_pending_material || 0) > 0 ? (
                                    <DeskChip label={`Jobs Pending ${row.jobs_pending_material || 0}`} tone="#fff7ea" color="#8b5a00" />
                                  ) : null}
                                </div>
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                                <MiniMetric label="Candidates" value={row.total_bom_count || 0} />
                                <MiniMetric label="Active Lines" value={row.latest_active_line_count || 0} />
                                <MiniMetric label="Jobs Pending RM" value={row.jobs_pending_material || 0} />
                                <MiniMetric label="Pending RM Qty" value={num(row.pending_issue_qty).toFixed(4)} />
                              </div>
                              <QueueReasonCard text={row.queue_reason} />
                              <QueueActionSummary
                                actionLabel={row.recommended_action_label}
                                items={[
                                  { label: "Open jobs", value: row.open_job_count || 0 },
                                  { label: "Pending RM qty", value: num(row.pending_issue_qty).toFixed(4) },
                                ]}
                              />
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {typeof onOpenManufacturingBoms === "function" ? (
                                  <button
                                    onClick={() =>
                                      onOpenManufacturingBoms({
                                        finished_good_product_id: row.product_id || undefined,
                                        finished_good_item_code: row.item_code || row.finished_good_item_code || undefined,
                                        focus: "setup_gaps",
                                      })
                                    }
                                  >
                                    {primaryActionLabel}
                                  </button>
                                ) : null}
                                {focusQuery ? (
                                  <button
                                    onClick={() => {
                                      setStoresQuery(focusQuery);
                                      Promise.all([
                                        loadStoresPending(focusQuery),
                                        loadStoresShortageDashboard(focusQuery, storesShortageFilter),
                                        loadMaterialReadiness(focusQuery, materialReadinessFilter),
                                        loadConsumptionVariance(focusQuery, consumptionVarianceFilter),
                                      ]).catch(() => {});
                                    }}
                                  >
                                    Focus Related Shortages
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          );
                        }

                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open Shortage Desk";
                        const openMaterialShortageTarget = () => {
                          if (row.recommended_action === "reissue_material" && row.shortage_flags?.ready_for_reissue && !row.shortage_flags?.auto_closed) {
                            reopenShortageForIssue(row);
                            return;
                          }
                          openShortageDesk(row.job_card_id);
                        };
                        return (
                          <div
                            key={`material-shortage-${row.id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d7e3fb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.job_card_number}
                                  {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"}
                                  {row.so_number ? ` • SO ${row.so_number}` : ""}
                                  {row.customer_name ? ` • ${row.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={`${row.shortage_age_days || 0}d old`} tone="#fff7ea" color="#8b5a00" />
                                <DeskChip label={`L${row.line_no} • ${row.item_code || "No item"}`} tone="#f6f7fb" color="#58627a" />
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                                {(row.shortage_lifecycle_labels || []).map((label) => {
                                  const appearance = shortageLifecycleAppearance(label);
                                  return <DeskChip key={`material-${row.id}-${label}`} label={label} tone={appearance.tone} color={appearance.color} />;
                                })}
                              </div>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.78 }}>
                              {row.item_name || "No item name"} • Pending {num(row.current_pending_issue_qty).toFixed(4)} • Stock {num(row.current_stock_qty).toFixed(4)}
                              {row.requisition_number ? ` • PR ${row.requisition_number}` : ""}
                              {row.po_number ? ` • PO ${row.po_number}` : ""}
                              {row.grn_number ? ` • GRN ${row.grn_number}` : ""}
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Action age", value: formatDayAge(row.age_days) },
                                { label: "Pending qty", value: num(row.current_pending_issue_qty).toFixed(4) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: Number(row.job_card_id) })}>Open Job</button>
                              <button onClick={openMaterialShortageTarget}>{primaryActionLabel}</button>
                              {row.shortage_flags?.ready_for_reissue && !row.shortage_flags?.auto_closed ? (
                                <button onClick={() => reopenShortageForIssue(row)}>Re-Issue Now</button>
                              ) : null}
                              {row.purchase_requisition_id ? <button onClick={() => onOpenPurchaseRequisition?.(Number(row.purchase_requisition_id))}>Open PR</button> : null}
                              {row.purchase_order_id ? <button onClick={() => onOpenPurchaseOrder?.(Number(row.purchase_order_id))}>Open PO</button> : null}
                              {row.goods_receipt_id ? <button onClick={() => onOpenGoodsReceipt?.(Number(row.goods_receipt_id))}>Open GRN</button> : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No material-readiness items match the current search and bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {consumptionVarianceSummary || consumptionVarianceLoading || consumptionVarianceRows.length ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Consumption Variance Desk</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Track line-level issue discipline across pending issue, low-stock block, issued-not-consumed, consumed-above-net-issue, and return-heavy lines.</div>
                    </div>
                    <button onClick={() => loadConsumptionVariance(storesQuery, consumptionVarianceFilter)} disabled={consumptionVarianceLoading}>
                      {consumptionVarianceLoading ? "Refreshing..." : "Refresh Variance Desk"}
                    </button>
                  </div>
                  {consumptionVarianceSummary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Low Stock" value={consumptionVarianceSummary.lowStockBlocked || 0} />
                      <MiniMetric label="Pending Issue" value={consumptionVarianceSummary.pendingIssue || 0} />
                      <MiniMetric label="Issued > Consumed" value={consumptionVarianceSummary.issuedNotConsumed || 0} />
                      <MiniMetric label="Consumed > Issued" value={consumptionVarianceSummary.consumedWithoutIssue || 0} />
                      <MiniMetric label="No Issue" value={consumptionVarianceSummary.noIssueLogged || 0} />
                      <MiniMetric label="Returns" value={consumptionVarianceSummary.returnLogged || 0} />
                      <MiniMetric label="Pending Qty" value={num(consumptionVarianceSummary.pendingIssueQty).toFixed(4)} />
                      <MiniMetric label="Idle Qty" value={num(consumptionVarianceSummary.issuedNotConsumedQty).toFixed(4)} />
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {CONSUMPTION_VARIANCE_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setConsumptionVarianceFilter(value);
                          loadConsumptionVariance(storesQuery, value).catch(() => {});
                        }}
                        style={consumptionVarianceFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {consumptionVarianceLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading consumption variance queue…</div>
                    ) : consumptionVarianceRows.length ? (
                      consumptionVarianceRows.map((row) => {
                        const varianceAppearance = consumptionVarianceAppearance(
                          row.variance_flags?.consumed_without_issue
                            ? "consumed_without_issue"
                            : row.variance_flags?.low_stock_blocked
                              ? "low_stock_blocked"
                              : row.variance_flags?.pending_issue
                                ? "pending_issue"
                                : row.variance_flags?.issued_not_consumed
                                  ? "issued_not_consumed"
                                  : row.variance_flags?.no_issue_logged
                                    ? "no_issue_logged"
                                    : row.variance_flags?.return_logged
                                      ? "return_logged"
                                      : "all"
                        );
                        const attention = attentionAppearance(row.attention_level);
                        const primaryActionLabel = row.recommended_action_label || "Open Job";
                        return (
                          <div
                            key={`consumption-variance-${row.job_card_line_id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #d7e3fb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {row.job_card_number}
                                  {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {row.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {row.finished_good_item_code || "—"} • {row.finished_good_item_name || "No FG"}
                                  {row.so_number ? ` • SO ${row.so_number}` : ""}
                                  {row.customer_name ? ` • ${row.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={varianceAppearance.label} tone={varianceAppearance.tone} color={varianceAppearance.color} />
                                <DeskChip label={`L${row.line_no} • ${row.item_code || "No item"}`} tone="#f6f7fb" color="#58627a" />
                                <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                                {row.recommended_action_label ? (
                                  <DeskChip label={row.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                              </div>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.78 }}>
                              {row.item_name || "No item name"} • Last Line Movement {fmtDate(row.last_line_movement_date)}
                              {(row.variance_labels || []).length ? ` • ${row.variance_labels.join(" • ")}` : ""}
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                              <MiniMetric label="Requested" value={num(row.qty_requested).toFixed(4)} />
                              <MiniMetric label="Net Issued" value={num(row.net_issued_qty).toFixed(4)} />
                              <MiniMetric label="Consumed" value={num(row.qty_consumed).toFixed(4)} />
                              <MiniMetric label="Returned" value={num(row.qty_returned).toFixed(4)} />
                              <MiniMetric label="Pending" value={num(row.pending_issue_qty).toFixed(4)} />
                              <MiniMetric label="Idle Issue" value={num(row.issued_not_consumed_qty).toFixed(4)} />
                              <MiniMetric label="Excess Consume" value={num(row.consumed_without_issue_qty).toFixed(4)} />
                              <MiniMetric label="Stock" value={num(row.current_stock_qty).toFixed(4)} />
                            </div>
                            <QueueReasonCard text={row.queue_reason} />
                            <QueueActionSummary
                              actionLabel={row.recommended_action_label}
                              items={[
                                { label: "Movement age", value: formatDayAge(row.age_days) },
                                { label: "Last line move", value: fmtDate(row.last_line_movement_date) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: Number(row.job_card_id) })}>{primaryActionLabel}</button>
                              <button onClick={() => openIssueSlip(Number(row.job_card_id))}>Issue Slip</button>
                              <button onClick={() => openStoresQuickIssue(Number(row.job_card_id))}>Quick Issue</button>
                              {Number(row.product_id) > 0 && typeof onOpenStockLedger === "function" ? (
                                <button onClick={() => onOpenStockLedger(Number(row.product_id), row.item_code || row.item_name || "")}>Open RM Ledger</button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No consumption variance lines match the current search and bucket.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {storesShortageSummary ? (
                <div
                  style={{
                    display: "grid",
                    padding: 12,
                    borderRadius: 16,
                    background: "#fffdfa",
                    border: "1px solid #f2dfbf",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Stores Action Dashboard</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Oldest shortage actions grouped by lifecycle so stores can work the real queue first.</div>
                    </div>
                    <button onClick={() => loadStoresShortageDashboard(storesQuery, storesShortageFilter)} disabled={storesShortageDashboardLoading}>
                      {storesShortageDashboardLoading ? "Refreshing..." : "Refresh Shortages"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 10 }}>
                    <MiniMetric label="Open Actions" value={storesShortageSummary.total || 0} />
                    <MiniMetric label="Not Raised" value={storesShortageSummary.procurementNotRaised || 0} />
                    <MiniMetric label="PR Raised" value={storesShortageSummary.procurementRaised || 0} />
                    <MiniMetric label="Fully Ordered" value={storesShortageSummary.fullyOrdered || 0} />
                    <MiniMetric label="Fully Received" value={storesShortageSummary.fullyReceived || 0} />
                    <MiniMetric label="Ready Re-Issue" value={storesShortageSummary.readyForReissue || 0} />
                    <MiniMetric label="Blocked" value={storesShortageSummary.blocked || 0} />
                    <MiniMetric label="Oldest Age" value={`${storesShortageSummary.oldestAgeDays || 0}d`} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {STORES_SHORTAGE_BUCKETS.map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setStoresShortageFilter(value);
                          loadStoresShortageDashboard(storesQuery, value).catch(() => {});
                        }}
                        style={storesShortageFilter === value ? { borderColor: "#96b5ff", background: "#eef4ff" } : undefined}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {storesShortageDashboardLoading ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>Loading shortage actions…</div>
                    ) : storesShortageRows.length ? (
                      storesShortageRows.map((action) => {
                        const attention = attentionAppearance(action.attention_level);
                        const primaryActionLabel = action.recommended_action_label || "Open Shortage Desk";
                        const openStoresShortageTarget = () => {
                          if (action.recommended_action === "reissue_material" && action.shortage_flags?.ready_for_reissue && !action.shortage_flags?.auto_closed) {
                            reopenShortageForIssue(action);
                            return;
                          }
                          openShortageDesk(action.job_card_id);
                        };
                        return (
                          <div
                            key={`stores-shortage-${action.id}`}
                            style={{
                              display: "grid",
                              gap: 8,
                              padding: 10,
                              borderRadius: 14,
                              background: "#ffffff",
                              border: "1px solid #eadfcb",
                            }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                              <div style={{ display: "grid", gap: 4 }}>
                                <div style={{ fontWeight: 800 }}>
                                  {action.job_card_number}
                                  {action.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {action.job_id}</span> : null}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.72 }}>
                                  {action.finished_good_item_code || "—"} • {action.finished_good_item_name || "No FG"}
                                  {action.so_number ? ` • SO ${action.so_number}` : ""}
                                  {action.customer_name ? ` • ${action.customer_name}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                <DeskChip label={`${action.shortage_age_days || 0}d old`} tone="#fff7ea" color="#8b5a00" />
                                <DeskChip label={`L${action.line_no} • ${action.item_code || "No item"}`} tone="#f6f7fb" color="#58627a" />
                                {action.recommended_action_label ? (
                                  <DeskChip label={action.recommended_action_label} tone={attention.tone} color={attention.color} />
                                ) : null}
                                {(action.shortage_lifecycle_labels || []).map((label) => {
                                  const appearance = shortageLifecycleAppearance(label);
                                  return <DeskChip key={`dashboard-${action.id}-${label}`} label={label} tone={appearance.tone} color={appearance.color} />;
                                })}
                              </div>
                            </div>
                            <div style={{ fontSize: 12, opacity: 0.78 }}>
                              {action.item_name || "No item name"} • Pending {num(action.current_pending_issue_qty).toFixed(4)} • Stock {num(action.current_stock_qty).toFixed(4)}
                              {action.requisition_number ? ` • PR ${action.requisition_number}` : ""}
                              {action.po_number ? ` • PO ${action.po_number}` : ""}
                              {action.grn_number ? ` • GRN ${action.grn_number}` : ""}
                            </div>
                            <QueueReasonCard text={action.queue_reason} />
                            <QueueActionSummary
                              actionLabel={action.recommended_action_label}
                              items={[
                                { label: "Action age", value: formatDayAge(action.age_days) },
                                { label: "Pending qty", value: num(action.current_pending_issue_qty).toFixed(4) },
                              ]}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button onClick={() => setView({ type: "detail", id: Number(action.job_card_id) })}>Open Job</button>
                              <button onClick={openStoresShortageTarget}>{primaryActionLabel}</button>
                              {action.shortage_flags?.ready_for_reissue && !action.shortage_flags?.auto_closed ? (
                                <button onClick={() => reopenShortageForIssue(action)}>Re-Issue Now</button>
                              ) : null}
                              {action.purchase_requisition_id ? (
                                <button onClick={() => onOpenPurchaseRequisition?.(Number(action.purchase_requisition_id))}>Open PR</button>
                              ) : null}
                              {action.purchase_order_id ? (
                                <button onClick={() => onOpenPurchaseOrder?.(Number(action.purchase_order_id))}>Open PO</button>
                              ) : null}
                              {action.goods_receipt_id ? (
                                <button onClick={() => onOpenGoodsReceipt?.(Number(action.goods_receipt_id))}>Open GRN</button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>No open shortage actions match the current stores search.</div>
                    )}
                  </div>
                </div>
              ) : null}

              {selectedJobIds.length ? (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: 12,
                    borderRadius: 16,
                    background: "#f8fbff",
                    border: "1px solid #dbe7ff",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Stores Batch Issue Workflow</div>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>Use selected jobs as a guided stores queue and move through them without opening the full desk.</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => loadStoresBatchIssuePlan()} disabled={storesBatchPlanLoading}>
                        {storesBatchPlanLoading ? "Loading..." : storesBatchPlan ? "Refresh Batch Plan" : "Load Batch Plan"}
                      </button>
                      <button onClick={() => openStoresBatchJob()} disabled={storesBatchPlanLoading || !selectedJobIds.length}>Start First</button>
                      <button onClick={openNextStoresBatchJob} disabled={storesBatchPlanLoading || !storesBatchPlan?.jobs?.length}>Next Job</button>
                      <button onClick={() => setStoresBatchPlan(null)} disabled={!storesBatchPlan}>Clear Plan</button>
                    </div>
                  </div>
                  {storesBatchPlan?.summary ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Selected Jobs" value={storesBatchPlan.summary.selectedJobs || selectedJobIds.length} />
                      <MiniMetric label="Included Jobs" value={storesBatchPlan.summary.jobs || 0} />
                      <MiniMetric label="Pending Lines" value={storesBatchPlan.summary.lines || 0} />
                      <MiniMetric label="Pending Qty" value={num(storesBatchPlan.summary.pendingQty).toFixed(4)} />
                      <MiniMetric label="Low Stock Jobs" value={storesBatchPlan.summary.lowStockJobs || 0} />
                    </div>
                  ) : null}
                  {storesBatchPlan?.jobs?.length ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      {storesBatchPlan.jobs.map((job) => (
                        <div
                          key={job.job_card_id}
                          style={{
                            display: "grid",
                            gap: 6,
                            padding: 10,
                            borderRadius: 14,
                            background: quickIssueJobId === Number(job.job_card_id) ? "#eef4ff" : "#ffffff",
                            border: quickIssueJobId === Number(job.job_card_id) ? "1px solid #b9ceff" : "1px solid #e4ebf7",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                            <div>
                              <div style={{ fontWeight: 800 }}>
                                {job.job_card_number}
                                {job.job_id ? <span style={{ fontWeight: 500, marginLeft: 8 }}>• JobID {job.job_id}</span> : null}
                              </div>
                              <div style={{ fontSize: 12, opacity: 0.72 }}>
                                {job.finished_good_item_code || "—"} • {job.finished_good_item_name || "No FG"}
                                {job.so_number ? ` • SO ${job.so_number}` : ""}
                                {job.customer_name ? ` • ${job.customer_name}` : ""}
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <DeskChip label={`Lines ${job.pending_line_count || 0}`} tone="#f6f7fb" color="#58627a" />
                              <DeskChip label={`Pending ${num(job.pending_qty).toFixed(4)}`} tone="#eef4ff" color="#234a8f" />
                              {Number(job.low_stock_line_count || 0) > 0 ? <DeskChip label={`Low Stock ${job.low_stock_line_count}`} tone="#fff7ea" color="#8b5a00" /> : null}
                              <button onClick={() => openStoresBatchJob(job.job_card_id)} disabled={quickIssueJobId === Number(job.job_card_id)}>
                                {quickIssueJobId === Number(job.job_card_id) ? "Working" : "Work This Job"}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : storesBatchPlan ? (
                    <div style={{ fontSize: 12, opacity: 0.74 }}>None of the selected jobs currently have pending stores lines.</div>
                  ) : null}
                </div>
              ) : null}

              <div style={{ display: "grid", gap: 10, maxHeight: 980, overflowY: "auto", paddingRight: 4 }}>
                {storesLoading ? (
                  <div>Loading stores pending issues…</div>
                ) : storesRows.length ? (
                  storesRows.map((row) => (
                    <div
                      key={row.id}
                      onClick={() => setView({ type: "detail", id: row.id })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setView({ type: "detail", id: row.id });
                        }
                      }}
                      style={{
                        cursor: "pointer",
                        border: "1px solid #e7ebf3",
                        borderRadius: 18,
                        padding: 14,
                        background: "#ffffff",
                        boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <input
                            type="checkbox"
                            checked={selectedJobIdSet.has(Number(row.id))}
                            onChange={() => toggleSelectedJob(row.id)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ marginTop: 2 }}
                          />
                          <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                            {row.manufacturing_mode === "so_linked" ? "Stores pending / SO-linked" : "Stores pending / Standalone"}
                          </div>
                          <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>
                            {row.job_card_number}
                            {row.job_id ? <span style={{ fontWeight: 500, marginLeft: 10 }}>• JobID {row.job_id}</span> : null}
                          </div>
                        </div>
                        </div>
                        <DeskChip label={String(row.job_status || "draft").toUpperCase()} tone={statusTone(row.job_status)} color={statusColor(row.job_status)} />
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <DeskChip label={`${row.finished_good_item_code || "—"} • ${row.finished_good_item_name || "No FG"}`} tone="#f6f7fb" color="#58627a" />
                        {row.so_number ? <DeskChip label={`SO ${row.so_number}`} tone="#eef4ff" color="#234a8f" /> : null}
                        {row.customer_name ? <DeskChip label={row.customer_name} tone="#eefbf3" color="#147a3d" /> : null}
                        {row.recommended_action_label ? (
                          <DeskChip
                            label={row.recommended_action_label}
                            tone={attentionAppearance(row.attention_level).tone}
                            color={attentionAppearance(row.attention_level).color}
                          />
                        ) : null}
                        {Number(row.low_stock_line_count || 0) > 0 ? <DeskChip label={`Low Stock ${row.low_stock_line_count}`} tone="#fff7ea" color="#8b5a00" /> : null}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Pending Qty" value={num(row.pending_issue_qty).toFixed(4)} />
                        <MiniMetric label="Pending Lines" value={row.pending_line_count || 0} />
                        <MiniMetric label="Net Issued" value={num(row.net_issued_qty).toFixed(4)} />
                        <MiniMetric label="Output" value={num(row.actual_output_qty).toFixed(4)} />
                      </div>
                      <QueueReasonCard text={row.queue_reason} />
                      <QueueActionSummary
                        actionLabel={row.recommended_action_label}
                        items={[
                          { label: "Movement age", value: formatDayAge(row.age_days) },
                          { label: "Last movement", value: fmtDate(row.last_movement_date) },
                        ]}
                      />
                      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                        Job Date: <strong>{fmtDate(row.job_date)}</strong> • Last Movement: <strong>{fmtDate(row.last_movement_date)}</strong>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                        <ManufacturingQuickActions id={row.id} />
                        <button onClick={() => openStoresQuickIssue(row.id)} disabled={quickIssueLoading && quickIssueJobId === Number(row.id)}>
                          {quickIssueJobId === Number(row.id) ? "Close Quick Issue" : quickIssueLoading && quickIssueJobId === Number(row.id) ? "Loading..." : "Quick Issue"}
                        </button>
                        <button onClick={() => openShortageDesk(row.id)} disabled={shortageDeskLoading && shortageDeskJobId === Number(row.id)}>
                          {shortageDeskJobId === Number(row.id) ? "Close Shortage Desk" : shortageDeskLoading && shortageDeskJobId === Number(row.id) ? "Loading..." : "Shortage Desk"}
                        </button>
                      </div>
                      {quickIssueJobId === Number(row.id) ? (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: "grid",
                            gap: 10,
                            padding: 12,
                            borderRadius: 16,
                            background: "#f9fbff",
                            border: "1px solid #dbe7ff",
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>Stores Quick Issue</div>
                          {quickIssueLines.length ? (
                            <>
                              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 120px 120px 140px", gap: 10, alignItems: "end" }}>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Line
                                  <select
                                    value={quickIssueForm.line_id}
                                    onChange={(e) => setQuickIssueForm((prev) => buildStoresQuickIssueForm(quickIssueLines, { ...prev, line_id: e.target.value, qty: undefined }))}
                                    style={{ height: 36 }}
                                  >
                                    {quickIssueLines.map((line) => (
                                      <option key={line.id} value={String(line.id)}>
                                        L{line.line_no} • {line.item_code} • Pending {pendingToIssueQty(line).toFixed(4)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <MiniMetric
                                  label="Pending"
                                  value={pendingToIssueQty(quickIssueLines.find((line) => String(line.id) === String(quickIssueForm.line_id)) || {}).toFixed(4)}
                                />
                                <MiniMetric
                                  label="Stock"
                                  value={num((quickIssueLines.find((line) => String(line.id) === String(quickIssueForm.line_id)) || {}).current_stock_qty).toFixed(4)}
                                />
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Issue Qty
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.0001"
                                    value={quickIssueForm.qty}
                                    onChange={(e) => setQuickIssueForm((prev) => ({ ...prev, qty: e.target.value }))}
                                    style={{ height: 34, padding: "0 8px" }}
                                  />
                                </label>
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 10 }}>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Issue Date
                                  <input
                                    type="date"
                                    value={quickIssueForm.movement_date}
                                    onChange={(e) => setQuickIssueForm((prev) => ({ ...prev, movement_date: e.target.value }))}
                                    style={{ height: 34 }}
                                  />
                                </label>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Reference No
                                  <input
                                    value={quickIssueForm.reference_no}
                                    onChange={(e) => setQuickIssueForm((prev) => ({ ...prev, reference_no: e.target.value }))}
                                    style={{ height: 34, padding: "0 8px" }}
                                  />
                                </label>
                              </div>
                              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                Remarks
                                <textarea
                                  value={quickIssueForm.remarks}
                                  onChange={(e) => setQuickIssueForm((prev) => ({ ...prev, remarks: e.target.value }))}
                                  rows={2}
                                  style={{ padding: 10 }}
                                />
                              </label>
                              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                Serial Numbers
                                <textarea
                                  value={quickIssueForm.serial_text}
                                  onChange={(e) => setQuickIssueForm((prev) => ({ ...prev, serial_text: e.target.value }))}
                                  rows={4}
                                  placeholder="One serial number per line when required"
                                  style={{ padding: 10 }}
                                />
                              </label>
                              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                <button onClick={() => openStoresQuickIssue(row.id)}>Cancel</button>
                                <button onClick={() => submitStoresQuickIssue(row.id)} disabled={quickIssueSubmitting}>
                                  {quickIssueSubmitting ? "Recording..." : "Record Issue"}
                                </button>
                              </div>
                            </>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.74 }}>No pending material lines remain on this job.</div>
                          )}
                        </div>
                      ) : null}
                      {shortageDeskJobId === Number(row.id) ? (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: "grid",
                            gap: 10,
                            padding: 12,
                            borderRadius: 16,
                            background: "#fffdfa",
                            border: "1px solid #f2dfbf",
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>Stores Shortage Desk</div>
                          {shortageDeskLines.length ? (
                            <>
                              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 180px 120px 120px", gap: 10, alignItems: "end" }}>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Line
                                  <select
                                    value={shortageActionForm.line_id}
                                    onChange={(e) => setShortageActionForm((prev) => buildShortageActionForm(shortageDeskLines, { ...prev, line_id: e.target.value, shortage_qty: undefined }))}
                                    style={{ height: 36 }}
                                  >
                                    {shortageDeskLines.map((line) => (
                                      <option key={line.id} value={String(line.id)}>
                                        L{line.line_no} • {line.item_code} • Pending {pendingToIssueQty(line).toFixed(4)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Action
                                  <select
                                    value={shortageActionForm.action_type}
                                    onChange={(e) => setShortageActionForm((prev) => ({ ...prev, action_type: e.target.value }))}
                                    style={{ height: 36 }}
                                  >
                                    {SHORTAGE_ACTION_OPTIONS.map(([value, label]) => (
                                      <option key={value} value={value}>{label}</option>
                                    ))}
                                  </select>
                                </label>
                                <MiniMetric
                                  label="Pending"
                                  value={pendingToIssueQty(shortageDeskLines.find((line) => String(line.id) === String(shortageActionForm.line_id)) || {}).toFixed(4)}
                                />
                                <MiniMetric
                                  label="Stock"
                                  value={num((shortageDeskLines.find((line) => String(line.id) === String(shortageActionForm.line_id)) || {}).current_stock_qty).toFixed(4)}
                                />
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "140px 160px 160px 1fr", gap: 10, alignItems: "end" }}>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Shortage Qty
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.0001"
                                    value={shortageActionForm.shortage_qty}
                                    onChange={(e) => setShortageActionForm((prev) => ({ ...prev, shortage_qty: e.target.value }))}
                                    style={{ height: 34, padding: "0 8px" }}
                                  />
                                </label>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Action Date
                                  <input
                                    type="date"
                                    value={shortageActionForm.action_date}
                                    onChange={(e) => setShortageActionForm((prev) => ({ ...prev, action_date: e.target.value }))}
                                    style={{ height: 34 }}
                                  />
                                </label>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Expected Date
                                  <input
                                    type="date"
                                    value={shortageActionForm.expected_date}
                                    onChange={(e) => setShortageActionForm((prev) => ({ ...prev, expected_date: e.target.value }))}
                                    style={{ height: 34 }}
                                  />
                                </label>
                                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                  Reference No
                                  <input
                                    value={shortageActionForm.reference_no}
                                    onChange={(e) => setShortageActionForm((prev) => ({ ...prev, reference_no: e.target.value }))}
                                    style={{ height: 34, padding: "0 8px" }}
                                  />
                                </label>
                              </div>
                              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                                Remarks
                                <textarea
                                  value={shortageActionForm.remarks}
                                  onChange={(e) => setShortageActionForm((prev) => ({ ...prev, remarks: e.target.value }))}
                                  rows={3}
                                  style={{ padding: 10 }}
                                />
                              </label>
                              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                <button onClick={() => openShortageDesk(row.id)}>Cancel</button>
                                <button onClick={() => submitShortageAction(row.id)} disabled={shortageDeskSubmitting}>
                                  {shortageDeskSubmitting ? "Recording..." : "Record Action"}
                                </button>
                              </div>
                              <div style={{ display: "grid", gap: 8 }}>
                                <div style={{ fontWeight: 700 }}>Action History</div>
                                {shortageDeskActions.length ? (
                                  shortageDeskActions.map((action) => {
                                    const appearance = shortageActionAppearance(action.action_type);
                                    return (
                                      <div
                                        key={action.id}
                                        style={{
                                          display: "grid",
                                          gap: 6,
                                          padding: 10,
                                          borderRadius: 14,
                                          background: "#ffffff",
                                          border: "1px solid #eadfcb",
                                        }}
                                      >
                                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                            <DeskChip label={SHORTAGE_ACTION_OPTIONS.find(([value]) => value === action.action_type)?.[1] || action.action_type} tone={appearance.tone} color={appearance.color} />
                                            <DeskChip label={`L${action.line_no} • ${action.item_code}`} tone="#f6f7fb" color="#58627a" />
                                            {action.shortage_qty !== null && action.shortage_qty !== undefined ? (
                                              <DeskChip label={`Qty ${num(action.shortage_qty).toFixed(4)}`} tone="#fff7ea" color="#8b5a00" />
                                            ) : null}
                                            {(action.shortage_lifecycle_labels || []).map((label) => {
                                              const lifecycleAppearance = shortageLifecycleAppearance(label);
                                              return (
                                                <DeskChip
                                                  key={`${action.id}-${label}`}
                                                  label={label}
                                                  tone={lifecycleAppearance.tone}
                                                  color={lifecycleAppearance.color}
                                                />
                                              );
                                            })}
                                            {action.requisition_number ? (
                                              <DeskChip
                                                label={`PR ${action.requisition_number}${action.requisition_status ? ` • ${String(action.requisition_status).toUpperCase()}` : ""}`}
                                                tone="#eef4ff"
                                                color="#234a8f"
                                              />
                                            ) : null}
                                            {action.requisition_number ? (
                                              <DeskChip
                                                label={`PR Pending ${num(action.requisition_qty_pending).toFixed(4)}`}
                                                tone="#f6f7fb"
                                                color="#58627a"
                                              />
                                            ) : null}
                                            {action.purchase_order_count ? (
                                              <DeskChip
                                                label={`PO Qty ${num(action.requisition_qty_ordered).toFixed(4)}`}
                                                tone="#eefbf3"
                                                color="#147a3d"
                                              />
                                            ) : null}
                                            {action.po_number ? (
                                              <DeskChip
                                                label={`PO ${action.po_number}${action.po_status ? ` • ${String(action.po_status).toUpperCase()}` : ""}`}
                                                tone="#eefbf3"
                                                color="#147a3d"
                                              />
                                            ) : null}
                                            {action.goods_receipt_count ? (
                                              <DeskChip
                                                label={`GR Qty ${num(action.goods_receipt_qty_received).toFixed(4)}`}
                                                tone="#eefbf3"
                                                color="#0a7a35"
                                              />
                                            ) : null}
                                            {action.requisition_number && !action.goods_receipt_count ? (
                                              <DeskChip
                                                label={`GR Pending ${num(action.goods_receipt_qty_pending).toFixed(4)}`}
                                                tone="#f6f7fb"
                                                color="#58627a"
                                              />
                                            ) : null}
                                            {action.grn_number ? (
                                              <DeskChip
                                                label={`GRN ${action.grn_number}${action.receipt_status ? ` • ${String(action.receipt_status).toUpperCase()}` : ""}`}
                                                tone="#eefbf3"
                                                color="#0a7a35"
                                              />
                                            ) : null}
                                          </div>
                                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                            <div style={{ fontSize: 12, opacity: 0.72 }}>
                                              {fmtDate(action.action_date)}{action.created_by_name ? ` • ${action.created_by_name}` : ""}
                                            </div>
                                            {action.shortage_flags?.ready_for_reissue && !action.shortage_flags?.auto_closed ? (
                                              <button onClick={() => reopenShortageForIssue(action)}>
                                                Re-Issue Now
                                              </button>
                                            ) : null}
                                            {action.grn_number ? (
                                              <button onClick={() => onOpenGoodsReceipt(Number(action.goods_receipt_id))} disabled={!action.goods_receipt_id}>
                                                Open GRN
                                              </button>
                                            ) : null}
                                            {action.po_number ? (
                                              <button onClick={() => onOpenPurchaseOrder(Number(action.purchase_order_id))} disabled={!action.purchase_order_id}>
                                                Open PO
                                              </button>
                                            ) : null}
                                            {action.requisition_number ? (
                                              <button onClick={() => onOpenPurchaseRequisition(Number(action.purchase_requisition_id))} disabled={!action.purchase_requisition_id}>
                                                Open Requisition
                                              </button>
                                            ) : action.action_type !== "resolved" ? (
                                              <button
                                                onClick={() => raisePurchaseRequisitionFromShortageAction(action.id)}
                                                disabled={raisingRequisitionActionId === Number(action.id)}
                                              >
                                                {raisingRequisitionActionId === Number(action.id) ? "Raising..." : "Raise Requisition"}
                                              </button>
                                            ) : null}
                                          </div>
                                        </div>
                                        <div style={{ fontSize: 12, opacity: 0.78 }}>
                                          {action.item_name || "No item name"}
                                          {action.reference_no ? ` • Ref ${action.reference_no}` : ""}
                                          {action.expected_date ? ` • Expected ${fmtDate(action.expected_date)}` : ""}
                                          {action.current_pending_issue_qty !== undefined ? ` • Pending to issue ${num(action.current_pending_issue_qty).toFixed(4)}` : ""}
                                          {action.current_stock_qty !== undefined ? ` • Current stock ${num(action.current_stock_qty).toFixed(4)}` : ""}
                                          {action.purchase_order_count ? ` • ${action.purchase_order_count} PO(s)` : ""}
                                          {action.goods_receipt_count ? ` • ${action.goods_receipt_count} GRN(s)` : ""}
                                        </div>
                                        {action.remarks ? <div style={{ fontSize: 12, lineHeight: 1.6 }}>{action.remarks}</div> : null}
                                      </div>
                                    );
                                  })
                                ) : (
                                  <div style={{ fontSize: 12, opacity: 0.74 }}>No shortage actions logged for this job yet.</div>
                                )}
                              </div>
                            </>
                          ) : (
                            <div style={{ fontSize: 12, opacity: 0.74 }}>No pending stores lines remain on this job.</div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                    No open manufacturing jobs currently show pending material to issue.
                  </div>
                )}
              </div>
            </div>
          )}
        </DeskCard>

        <div style={{ position: "sticky", top: 12 }}>
          <DeskCard
            title="Launch Panel"
            subtitle="Quick-create service or manufacturing jobs"
            actions={<button onClick={() => setCreateForm(createFormDefaults())}>Reset</button>}
          >
            <div style={{ display: "grid", gap: 14 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Job Type
                <select
                  value={createForm.job_type}
                  onChange={(e) =>
                    setCreateForm({
                      ...createFormDefaults(),
                      job_type: e.target.value,
                    })
                  }
                  style={{ height: 36 }}
                >
                  <option value="service">Service</option>
                  <option value="installation">Installation</option>
                  <option value="internal_issue">Internal Issue</option>
                  <option value="manufacturing">Manufacturing</option>
                </select>
              </label>

              {createForm.job_type === "manufacturing" ? (
                <>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Manufacturing Mode
                    <select
                      value={createForm.manufacturing_mode}
                      onChange={(e) => {
                        const nextMode = e.target.value;
                        updateCreateForm({
                          manufacturing_mode: nextMode,
                          sales_order_line_id: nextMode === "standalone" ? "" : createForm.sales_order_line_id,
                          bom_id: "",
                        });
                      }}
                      style={{ height: 36 }}
                    >
                      <option value="standalone">Standalone manufacturing</option>
                      <option value="so_linked">SO-linked manufacturing</option>
                    </select>
                  </label>
                  {createForm.manufacturing_mode === "so_linked" ? (
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Sales Order Line
                    <select
                      value={createForm.sales_order_line_id}
                      onChange={(e) => {
                        const value = e.target.value;
                        const line = salesOrderLineMap.get(value);
                        updateCreateForm({
                          manufacturing_mode: value ? "so_linked" : createForm.manufacturing_mode,
                          sales_order_line_id: value,
                          finished_good_product_id: line ? String(line.product_id) : createForm.finished_good_product_id,
                          planned_output_qty: line ? Number(line.qty || 1) : createForm.planned_output_qty,
                          bom_id: "",
                        });
                      }}
                      style={{ height: 36 }}
                    >
                      <option value="">-- Select SO line --</option>
                      {bootstrap.sales_order_lines.map((row) => (
                        <option key={row.id} value={String(row.id)}>
                          {row.so_number} • {row.customer_name} • L{row.line_no} • {row.item_code} • Qty {num(row.qty).toFixed(4)}
                        </option>
                      ))}
                    </select>
                  </label>
                  ) : null}
                  {createForm.manufacturing_mode === "so_linked" && selectedLaunchSoLine ? (
                    <div style={{ display: "grid", gap: 6, padding: 12, borderRadius: 14, background: "#eef4ff", border: "1px solid #dbe7ff" }}>
                      <div style={{ fontWeight: 700 }}>Selected Sales Order Context</div>
                      <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.78 }}>
                        SO: <strong>{selectedLaunchSoLine.so_number}</strong> • Customer: <strong>{selectedLaunchSoLine.customer_name}</strong><br />
                        Line: <strong>L{selectedLaunchSoLine.line_no}</strong> • FG: <strong>{selectedLaunchSoLine.item_code} • {selectedLaunchSoLine.item_name}</strong><br />
                        Order Date: <strong>{fmtDate(selectedLaunchSoLine.order_date)}</strong> • SO Qty: <strong>{num(selectedLaunchSoLine.qty).toFixed(4)}</strong>
                      </div>
                    </div>
                  ) : null}
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Finished Good
                    <select
                      value={createForm.finished_good_product_id}
                      onChange={(e) => updateCreateForm({ finished_good_product_id: e.target.value, bom_id: "" })}
                      disabled={Boolean(selectedLaunchSoLine)}
                      style={{ height: 36 }}
                    >
                      <option value="">-- Select FG --</option>
                      {bootstrap.finished_goods.map((row) => (
                        <option key={row.id} value={String(row.id)}>
                          {row.item_code} • {row.item_name} • {row.mfg_job_prefix}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedLaunchSoLine ? (
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: -6 }}>
                      Finished good is locked from the selected sales-order line.
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8 }}>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      BOM
                      <select value={createForm.bom_id} onChange={(e) => updateCreateForm({ bom_id: e.target.value })} style={{ height: 36 }}>
                        <option value="">Auto / latest active BOM</option>
                        {filteredBoms.map((row) => (
                          <option key={row.id} value={String(row.id)}>
                            {row.bom_code} • Rev {row.revision_no}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Qty
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={createForm.planned_output_qty}
                        onChange={(e) => updateCreateForm({ planned_output_qty: e.target.value })}
                        style={{ height: 34, padding: "0 8px" }}
                      />
                    </label>
                  </div>
                  {launchReadiness ? (
                    <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 14, background: "#f9fbff", border: "1px solid #e8eef7" }}>
                      <div style={{ fontWeight: 700 }}>Manufacturing Readiness</div>
                      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                        Mode: <strong>{launchReadiness.mode}</strong><br />
                        FG: <strong>{launchReadiness.fgLabel}</strong><br />
                        Prefix: <strong>{launchReadiness.prefix}</strong> • Active BOMs in view: <strong>{launchReadiness.bomCount}</strong>
                      </div>
                      {launchReadiness.warnings.length ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          {launchReadiness.warnings.map((warning) => (
                            <div key={warning} style={{ fontSize: 12, color: "#8b5a00", background: "#fff7ea", border: "1px solid #f4dfb2", borderRadius: 10, padding: "8px 10px", lineHeight: 1.5 }}>
                              {warning}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "#0a7a35", background: "#f2fff6", border: "1px solid #d6f4df", borderRadius: 10, padding: "8px 10px", lineHeight: 1.5 }}>
                          This finished good looks ready for job creation from the launch panel.
                        </div>
                      )}
                    </div>
                  ) : null}
                </>
              ) : (
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Service Case
                  <select value={createForm.service_case_id} onChange={(e) => updateCreateForm({ service_case_id: e.target.value })} style={{ height: 36 }}>
                    <option value="">Manual / internal job card</option>
                    {bootstrap.service_cases.map((row) => (
                      <option key={row.id} value={String(row.id)}>
                        {row.case_number} • {row.customer_name} • {row.case_status}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 14, background: "#f9fbff", border: "1px solid #e8eef7" }}>
                <div style={{ fontWeight: 700 }}>Create Flow</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                  Create the job here only when the finished good is owned by the active company for manufacturing. Intercompany-supplied FG should stay on the source-company BOM and job flow.
                </div>
              </div>

              <button onClick={createJobCard} disabled={creating || !canCreateManufacturing}>
                {creating ? "Creating..." : "Create Job"}
              </button>
            </div>
          </DeskCard>
        </div>
      </div>
    </div>
  );
}

function ManufacturingQuickActions({ id }) {
  function stopAnd(run) {
    return (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    };
  }

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button onClick={stopAnd(() => openIssueSlip(id))}>Slip</button>
      <button onClick={stopAnd(() => openIssueSlipPdf(id))}>Slip PDF</button>
      <button onClick={stopAnd(() => openTraveler(id))}>Traveler</button>
      <button onClick={stopAnd(() => openTravelerPdf(id))}>Traveler PDF</button>
    </div>
  );
}

function JobCardDetail({ id, onBack, canApprove = false, onOpenServiceTicket = null, advancedDefault = false }) {
  const [showAdvanced, setShowAdvanced] = useState(Boolean(advancedDefault));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [movementLoading, setMovementLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bootstrap, setBootstrap] = useState({ finished_goods: [], boms: [], sales_order_lines: [] });
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [movements, setMovements] = useState([]);
  const [jobStatus, setJobStatus] = useState("draft");
  const [jobType, setJobType] = useState("service");
  const [jobDate, setJobDate] = useState("");
  const [technicianName, setTechnicianName] = useState("");
  const [department, setDepartment] = useState("");
  const [siteName, setSiteName] = useState("");
  const [remarks, setRemarks] = useState("");
  const [manufacturingMode, setManufacturingMode] = useState("standalone");
  const [salesOrderLineId, setSalesOrderLineId] = useState("");
  const [finishedGoodProductId, setFinishedGoodProductId] = useState("");
  const [bomId, setBomId] = useState("");
  const [plannedOutputQty, setPlannedOutputQty] = useState(1);
  const [actualOutputQty, setActualOutputQty] = useState(0);
  const [finishedGoodReceiptDate, setFinishedGoodReceiptDate] = useState("");
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupItems, setLookupItems] = useState([]);
  const [movementForm, setMovementForm] = useState(() => buildMovementForm([]));
  const [costingLoading, setCostingLoading] = useState(false);
  const [costing, setCosting] = useState(null);
  const [actualLaborHours, setActualLaborHours] = useState(0);
  const [laborHourRate, setLaborHourRate] = useState(0);
  const [overheadAbsorptionAmount, setOverheadAbsorptionAmount] = useState(0);

  async function loadBootstrap() {
    const data = await apiFetch("/job-cards/bootstrap");
    setBootstrap({
      finished_goods: Array.isArray(data?.finished_goods) ? data.finished_goods : [],
      boms: Array.isArray(data?.boms) ? data.boms : [],
      sales_order_lines: Array.isArray(data?.sales_order_lines) ? data.sales_order_lines : [],
    });
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [data, costingData] = await Promise.all([
        apiFetch(`/job-cards/${id}`),
        apiFetch(`/job-cards/${id}/costing`).catch(() => null),
        loadBootstrap(),
      ]);
      const jobCard = data?.job_card || null;
      const nextLines = Array.isArray(data?.lines) ? data.lines : [];
      const costingRow = costingData?.costing || null;
      setHeader(jobCard);
      setLines(nextLines);
      setMovements(Array.isArray(data?.movements) ? data.movements : []);
      setCosting(costingRow);
      setJobStatus(jobCard?.job_status || "draft");
      setJobType(jobCard?.job_type || "service");
      setJobDate(toIsoDate(jobCard?.job_date));
      setTechnicianName(jobCard?.technician_name || "");
      setDepartment(jobCard?.department || "");
      setSiteName(jobCard?.site_name || "");
      setRemarks(jobCard?.remarks || "");
      setManufacturingMode(jobCard?.sales_order_line_id ? "so_linked" : "standalone");
      setSalesOrderLineId(jobCard?.sales_order_line_id ? String(jobCard.sales_order_line_id) : "");
      setFinishedGoodProductId(jobCard?.finished_good_product_id ? String(jobCard.finished_good_product_id) : "");
      setBomId(jobCard?.bom_id ? String(jobCard.bom_id) : "");
      setPlannedOutputQty(num(jobCard?.planned_output_qty || 1));
      setActualOutputQty(num(jobCard?.actual_output_qty || 0));
      setFinishedGoodReceiptDate(toIsoDate(jobCard?.finished_good_receipt_date));
      setActualLaborHours(num(jobCard?.actual_labor_hours || costingRow?.actual_labor_hours || 0));
      setLaborHourRate(num(jobCard?.labor_hour_rate || costingRow?.labor_hour_rate || 0));
      setOverheadAbsorptionAmount(num(jobCard?.overhead_absorption_amount || costingRow?.overhead_absorption_amount || 0));
      setMovementForm((prev) => buildMovementForm(nextLines, prev));
    } catch (_e) {
      setError("Failed to load job card.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  async function runLookup() {
    setLookupLoading(true);
    try {
      const q = String(lookupQuery || "").trim();
      const url = q ? `/job-cards/product-lookup?q=${encodeURIComponent(q)}` : "/job-cards/product-lookup";
      const data = await apiFetch(url);
      setLookupItems(Array.isArray(data?.products) ? data.products : []);
    } catch (_e) {
      setError("Failed to search products.");
    } finally {
      setLookupLoading(false);
    }
  }

  const isEditable = !["closed", "cancelled", "posted"].includes(String(jobStatus || "").toLowerCase());
  const isServiceMrn = ["service", "installation"].includes(String(jobType || "").toLowerCase());
  const canMoveMaterial = isServiceMrn
    ? ["approved", "open"].includes(String(jobStatus || "").toLowerCase())
    : ["draft", "open", "submitted", "approved"].includes(String(jobStatus || "").toLowerCase());
  const canShowApprove =
    canApprove &&
    isServiceMrn &&
    ["draft", "submitted"].includes(String(jobStatus || "").toLowerCase());
  const filteredBoms = useMemo(
    () =>
      (bootstrap.boms || []).filter((row) =>
        finishedGoodProductId ? String(row.finished_good_product_id) === String(finishedGoodProductId) : true
      ),
    [bootstrap.boms, finishedGoodProductId]
  );
  const detailSalesOrderLineMap = useMemo(
    () => new Map((bootstrap.sales_order_lines || []).map((row) => [String(row.id), row])),
    [bootstrap.sales_order_lines]
  );
  const selectedDetailSoLine = useMemo(
    () => detailSalesOrderLineMap.get(String(salesOrderLineId || "")) || null,
    [detailSalesOrderLineMap, salesOrderLineId]
  );
  const receiptPostingNote = useMemo(() => {
    if (jobType !== "manufacturing") return null;
    const status = String(jobStatus || "").toLowerCase();
    const output = num(actualOutputQty);
    if (output > 0 && !["closed", "posted"].includes(status)) {
      return {
        tone: "pending",
        message: "Finished-good stock will post only after this job is moved to Closed or Posted.",
      };
    }
    if (output <= 0 && ["closed", "posted"].includes(status)) {
      return {
        tone: "warning",
        message: "This job is closing/posting without actual output, so no manufacturing receipt will be posted.",
      };
    }
    if (output > 0 && ["closed", "posted"].includes(status)) {
      return {
        tone: "ready",
        message: "This job is ready to post finished-good receipt into stock on save.",
      };
    }
    return {
      tone: "neutral",
      message: "Record actual output and receipt date before final close/post of the manufacturing job.",
    };
  }, [jobType, jobStatus, actualOutputQty]);
  const stockConfidence = useMemo(() => {
    const issueCount = movements.filter((move) => String(move.movement_type || "").toLowerCase() === "issue").length;
    const returnCount = movements.filter((move) => String(move.movement_type || "").toLowerCase() === "return").length;
    const lowStockLines = lines.filter((line) => num(line.current_stock_qty) < num(line.qty_requested));
    const totalOutstanding = lines.reduce((sum, line) => sum + num(line.qty_outstanding), 0);
    return {
      fgStock: num(header.finished_good_stock_qty),
      issueCount,
      returnCount,
      lowStockLines: lowStockLines.length,
      totalOutstanding,
    };
  }, [movements, lines, header.finished_good_stock_qty]);
  const manufacturingCloseChecklist = useMemo(() => {
    if (jobType !== "manufacturing") return null;
    const status = String(jobStatus || "").toLowerCase();
    const isFinalStatus = ["closed", "posted"].includes(status);
    const checks = [
      { label: "Finished good selected", done: Boolean(finishedGoodProductId), critical: true },
      { label: "BOM selected", done: Boolean(bomId), critical: true },
      { label: "Planned output entered", done: num(plannedOutputQty) > 0, critical: true },
      { label: "Actual output entered", done: num(actualOutputQty) > 0, critical: true },
      { label: "FG receipt date entered", done: Boolean(finishedGoodReceiptDate), critical: true },
      { label: "At least one material movement recorded", done: movements.length > 0, critical: false },
      { label: "No outstanding RM quantity", done: num(stockConfidence.totalOutstanding) <= 0, critical: false },
    ];
    const criticalMissing = checks.filter((item) => item.critical && !item.done);
    const warningMissing = checks.filter((item) => !item.critical && !item.done);
    return {
      isFinalStatus,
      checks,
      criticalMissing,
      warningMissing,
      readyToClose: criticalMissing.length === 0,
    };
  }, [
    jobType,
    jobStatus,
    finishedGoodProductId,
    bomId,
    plannedOutputQty,
    actualOutputQty,
    finishedGoodReceiptDate,
    movements.length,
    stockConfidence.totalOutstanding,
  ]);

  function addProduct(product) {
    if (!product?.id) return;
    setLines((prev) => {
      if (prev.some((line) => Number(line.product_id) === Number(product.id))) return prev;
      const next = [
        ...prev,
        {
          ...emptyLine(),
          product_id: product.id,
          item_code: product.item_code || "",
          item_name: product.item_name || "",
          uom: product.uom || "",
          serial_no_required: product.serial_no_required === true,
        },
      ];
      setMovementForm((current) => buildMovementForm(next, current));
      return next;
    });
  }

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function removeLine(index) {
    setLines((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setMovementForm((current) => buildMovementForm(next, current));
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (manufacturingCloseChecklist?.isFinalStatus && !manufacturingCloseChecklist.readyToClose) {
        setError(`Complete before ${jobStatus}: ${manufacturingCloseChecklist.criticalMissing.map((item) => item.label).join(", ")}.`);
        setSaving(false);
        return;
      }
      const payload = {
        job_status: jobStatus,
        job_type: jobType,
        job_date: jobDate || null,
        technician_name: technicianName || null,
        department: department || null,
        site_name: siteName || null,
        remarks: remarks || null,
      };

      if (jobType === "manufacturing") {
        payload.sales_order_line_id = salesOrderLineId ? Number(salesOrderLineId) : null;
        payload.finished_good_product_id = finishedGoodProductId ? Number(finishedGoodProductId) : null;
        payload.bom_id = bomId ? Number(bomId) : null;
        payload.planned_output_qty = num(plannedOutputQty) || 1;
        payload.actual_output_qty = num(actualOutputQty) || 0;
        payload.finished_good_receipt_date = finishedGoodReceiptDate || null;
      }

      if (isEditable) {
        payload.lines = lines.map((line) => ({
          product_id: line.product_id,
          qty_requested: num(line.qty_requested),
          qty_consumed: num(line.qty_consumed),
          remarks: line.remarks || null,
        }));
      }

      const data = await apiFetch(`/job-cards/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const jobCard = data?.job_card || header;
      const nextLines = Array.isArray(data?.lines) ? data.lines : lines;
      setHeader(jobCard);
      setLines(nextLines);
      setMovements(Array.isArray(data?.movements) ? data.movements : movements);
      setJobStatus(jobCard?.job_status || jobStatus);
      setJobType(jobCard?.job_type || jobType);
      setMovementForm((prev) => buildMovementForm(nextLines, prev));
      setNotice("Job card saved.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to save job card."));
    } finally {
      setSaving(false);
    }
  }

  async function approveMrn() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        job_status: "approved",
        job_type: jobType,
        job_date: jobDate || null,
        technician_name: technicianName || null,
        department: department || null,
        site_name: siteName || null,
        remarks: remarks || null,
      };
      const data = await apiFetch(`/job-cards/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const jobCard = data?.job_card || header;
      setHeader(jobCard);
      setJobStatus(jobCard?.job_status || "approved");
      setNotice("Service MRN approved. Stores can issue stock.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to approve MRN."));
    } finally {
      setSaving(false);
    }
  }

  async function recordMovement() {
    if (!movementForm.line_id) {
      setError("Select a line first.");
      return;
    }
    if (num(movementForm.qty) <= 0) {
      setError("Enter a valid quantity.");
      return;
    }
    const serials = String(movementForm.serial_text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    setMovementLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/job-cards/${id}/movements`, {
        method: "POST",
        body: JSON.stringify({
          line_id: Number(movementForm.line_id),
          movement_type: movementForm.movement_type,
          qty: num(movementForm.qty),
          movement_date: movementForm.movement_date || null,
          reference_no: movementForm.reference_no || null,
          remarks: movementForm.remarks || null,
          serials,
        }),
      });
      const nextLines = Array.isArray(data?.lines) ? data.lines : lines;
      setHeader(data?.job_card || header);
      setLines(nextLines);
      setMovements(Array.isArray(data?.movements) ? data.movements : movements);
      setMovementForm((prev) => buildMovementForm(nextLines, { movement_type: prev.movement_type, movement_date: todayIsoDate() }));
      setNotice("Material movement recorded.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to record movement."));
    } finally {
      setMovementLoading(false);
    }
  }

  async function saveCosting() {
    setCostingLoading(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/job-cards/${id}/costing`, {
        method: "PUT",
        body: JSON.stringify({
          actual_labor_hours: num(actualLaborHours),
          labor_hour_rate: num(laborHourRate),
          overhead_absorption_amount: num(overheadAbsorptionAmount),
        }),
      });
      setCosting(data?.costing || null);
      if (data?.costing) {
        setActualLaborHours(num(data.costing.actual_labor_hours || 0));
        setLaborHourRate(num(data.costing.labor_hour_rate || 0));
        setOverheadAbsorptionAmount(num(data.costing.overhead_absorption_amount || 0));
      }
      setNotice("Production costing updated.");
    } catch (e) {
      setError(friendlyError(e?.data?.error, "Failed to save production costing."));
    } finally {
      setCostingLoading(false);
    }
  }

  const totals = useMemo(
    () => ({
      requested: lines.reduce((sum, line) => sum + num(line.qty_requested), 0),
      issued: lines.reduce((sum, line) => sum + num(line.qty_issued), 0),
      returned: lines.reduce((sum, line) => sum + num(line.qty_returned), 0),
      consumed: lines.reduce((sum, line) => sum + num(line.qty_consumed), 0),
    }),
    [lines]
  );
  const costSignal = useMemo(() => {
    if (!costing) return null;
    if (costing.cost_flags?.margin_at_risk) return { label: "Margin at Risk", tone: "#fff2f2", color: "#a52323" };
    if (costing.cost_flags?.issued_no_output) return { label: "Issued No Output", tone: "#fff2f2", color: "#a52323" };
    if (costing.cost_flags?.over_issue_vs_bom) return { label: "Over-Issue Vs BOM", tone: "#fff7ea", color: "#8b5a00" };
    if (costing.cost_flags?.under_issue_vs_bom) return { label: "Under-Issue Vs BOM", tone: "#eef4ff", color: "#234a8f" };
    if (costing.cost_flags?.ready_cost_review) return { label: "Ready Cost Review", tone: "#eefbf3", color: "#147a3d" };
    return { label: "Cost Tracking", tone: "#f6f7fb", color: "#58627a" };
  }, [costing]);

  if (loading) return <div>Loading job card…</div>;
  if (!header) return <div>Job card not found.</div>;

  return (
    <div style={{ maxWidth: 1480 }}>
      <div
        style={{
          border: "1px solid #dde5f1",
          borderRadius: 24,
          padding: 20,
          background: "linear-gradient(135deg, #f7fafc 0%, #ffffff 42%, #eef4ff 100%)",
          boxShadow: "0 20px 45px rgba(28, 45, 74, 0.08)",
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56, marginBottom: 8 }}>
              Active Job Desk
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.08 }}>
              {header.job_card_number}
              {header.job_id ? <span style={{ fontSize: 18, fontWeight: 500, marginLeft: 12 }}>• JobID {header.job_id}</span> : null}
            </h2>
            <div style={{ fontSize: 14, opacity: 0.72, marginTop: 10, maxWidth: 780, lineHeight: 1.7 }}>
              {header.job_type} •{" "}
              {header.finished_good_item_code
                ? `${header.finished_good_item_code} • ${header.finished_good_item_name}`
                : header.service_ticket_number
                  ? `Ticket ${header.service_ticket_number}${header.service_ticket_customer_name ? ` • ${header.service_ticket_customer_name}` : ""}`
                  : header.service_case_number || "Internal"}
              {header.so_number ? ` • SO ${header.so_number}` : ""} • Run setup, issue materials, capture output, and move status from this one desk.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <DeskChip label={String(jobStatus || "draft").toUpperCase()} tone={statusTone(jobStatus)} color={statusColor(jobStatus)} />
            {jobType === "manufacturing" && costSignal ? <DeskChip label={costSignal.label} tone={costSignal.tone} color={costSignal.color} /> : null}
            <button onClick={onBack}>Back To Queue</button>
            {header.service_ticket_id && typeof onOpenServiceTicket === "function" ? (
              <button type="button" onClick={() => onOpenServiceTicket(header.service_ticket_id)}>
                Open Ticket {header.service_ticket_number || ""}
              </button>
            ) : null}
            {canShowApprove ? (
              <button type="button" onClick={approveMrn} disabled={saving}>
                {saving ? "Approving..." : "Approve MRN"}
              </button>
            ) : null}
            {jobType === "manufacturing" ? (
              <>
                <button onClick={() => openIssueSlip(id)}>Print Issue Slip</button>
                <button onClick={() => openIssueSlipPdf(id)}>Issue Slip PDF</button>
                <button onClick={() => openTraveler(id)}>Print Traveler</button>
                <button onClick={() => openTravelerPdf(id)}>Traveler PDF</button>
              </>
            ) : null}
            <button onClick={() => refresh().catch(() => {})}>Refresh</button>
            <button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save Desk"}</button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(120px, 1fr))", gap: 12, marginTop: 18 }}>
          <DeskStat label="Requested" value={totals.requested.toFixed(4)} tone="#143d7a" />
          <DeskStat label="Issued" value={totals.issued.toFixed(4)} tone="#0a7a35" />
          <DeskStat label="Returned" value={totals.returned.toFixed(4)} tone="#7a1637" />
          <DeskStat label="Consumed" value={totals.consumed.toFixed(4)} tone="#8b5a00" />
          <DeskStat label="Planned Output" value={num(plannedOutputQty).toFixed(4)} tone="#234a8f" />
          <DeskStat label="Actual Output" value={num(actualOutputQty).toFixed(4)} tone="#6a1b9a" />
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#fff3f3", border: "1px solid #ffd8d8" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12, padding: "12px 14px", borderRadius: 14, background: "#f2fff6", border: "1px solid #d6f4df" }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(300px, 0.8fr) minmax(0, 1.15fr) minmax(320px, 0.72fr)", gap: 18, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Job Setup" subtitle="Identity, timing, owner, and execution context">
            <div style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Job Date
                <input type="date" value={jobDate} onChange={(e) => setJobDate(e.target.value)} style={{ height: 34 }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Status
                <select value={jobStatus} onChange={(e) => setJobStatus(e.target.value)} style={{ height: 36 }}>
                  {statusOptionsForType(jobType).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Job Type
                <select value={jobType} onChange={(e) => setJobType(e.target.value)} style={{ height: 36 }}>
                  <option value="service">Service</option>
                  <option value="installation">Installation</option>
                  <option value="internal_issue">Internal Issue</option>
                  <option value="manufacturing">Manufacturing</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Technician
                <input value={technicianName} onChange={(e) => setTechnicianName(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Department
                <input value={department} onChange={(e) => setDepartment(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Site
                <input value={siteName} onChange={(e) => setSiteName(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                Remarks
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={4} style={{ padding: 10 }} />
              </label>
            </div>
          </DeskCard>

          {jobType === "manufacturing" ? (
            <DeskCard title="Manufacturing Context" subtitle="FG, BOM, SO link, and output details">
              <div style={{ display: "grid", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Manufacturing Mode
                  <select
                    value={manufacturingMode}
                    onChange={(e) => {
                      const nextMode = e.target.value;
                      setManufacturingMode(nextMode);
                      if (nextMode === "standalone") setSalesOrderLineId("");
                    }}
                    style={{ height: 36 }}
                  >
                    <option value="standalone">Standalone manufacturing</option>
                    <option value="so_linked">SO-linked manufacturing</option>
                  </select>
                </label>
                {manufacturingMode === "so_linked" ? (
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Sales Order Line
                  <select
                    value={salesOrderLineId}
                    onChange={(e) => {
                      const value = e.target.value;
                      const row = detailSalesOrderLineMap.get(value);
                      setSalesOrderLineId(value);
                      if (row) {
                        setFinishedGoodProductId(String(row.product_id));
                        if (!num(plannedOutputQty)) setPlannedOutputQty(num(row.qty || 1));
                        setBomId("");
                      }
                    }}
                    style={{ height: 36 }}
                  >
                    <option value="">-- Select SO line --</option>
                    {bootstrap.sales_order_lines.map((row) => (
                      <option key={row.id} value={String(row.id)}>
                        {row.so_number} • {row.customer_name} • L{row.line_no} • {row.item_code}
                      </option>
                    ))}
                  </select>
                </label>
                ) : null}
                {manufacturingMode === "so_linked" && selectedDetailSoLine ? (
                  <div style={{ display: "grid", gap: 6, padding: 12, borderRadius: 14, background: "#eef4ff", border: "1px solid #dbe7ff" }}>
                    <div style={{ fontWeight: 700 }}>Linked Sales Order Context</div>
                    <div style={{ fontSize: 12, opacity: 0.78, lineHeight: 1.6 }}>
                      SO: <strong>{selectedDetailSoLine.so_number}</strong> • Customer: <strong>{selectedDetailSoLine.customer_name}</strong><br />
                      Line: <strong>L{selectedDetailSoLine.line_no}</strong> • FG: <strong>{selectedDetailSoLine.item_code} • {selectedDetailSoLine.item_name}</strong><br />
                      Order Date: <strong>{fmtDate(selectedDetailSoLine.order_date)}</strong> • SO Qty: <strong>{num(selectedDetailSoLine.qty).toFixed(4)}</strong>
                    </div>
                  </div>
                ) : null}
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Finished Good
                  <select value={finishedGoodProductId} onChange={(e) => setFinishedGoodProductId(e.target.value)} disabled={Boolean(selectedDetailSoLine)} style={{ height: 36 }}>
                    <option value="">-- Select FG --</option>
                    {bootstrap.finished_goods.map((row) => (
                      <option key={row.id} value={String(row.id)}>
                        {row.item_code} • {row.item_name} • {row.mfg_job_prefix}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedDetailSoLine ? (
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: -6 }}>
                    Finished good is locked from the linked sales-order line.
                  </div>
                ) : null}
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  BOM
                  <select value={bomId} onChange={(e) => setBomId(e.target.value)} style={{ height: 36 }}>
                    <option value="">Auto / latest active BOM</option>
                    {filteredBoms.map((row) => (
                      <option key={row.id} value={String(row.id)}>
                        {row.bom_code} • Rev {row.revision_no}
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Planned Output Qty
                    <input type="number" min="0" step="0.0001" value={plannedOutputQty} onChange={(e) => setPlannedOutputQty(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
                  </label>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Actual Output Qty
                    <input type="number" min="0" step="0.0001" value={actualOutputQty} onChange={(e) => setActualOutputQty(e.target.value)} style={{ height: 34, padding: "0 8px" }} />
                  </label>
                </div>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  FG Receipt Date
                  <input type="date" value={finishedGoodReceiptDate} onChange={(e) => setFinishedGoodReceiptDate(e.target.value)} style={{ height: 34 }} />
                </label>
              </div>
            </DeskCard>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Material Workspace" subtitle="Search items, add lines, and maintain the active consumption list">
            <div style={{ display: "flex", gap: 10 }}>
              <input value={lookupQuery} onChange={(e) => setLookupQuery(e.target.value)} placeholder="Search products" style={{ flex: 1, height: 36, padding: "0 10px" }} disabled={!isEditable} />
              <button onClick={runLookup} disabled={lookupLoading || !isEditable}>{lookupLoading ? "Searching..." : "Search"}</button>
            </div>
            {lookupItems.length ? (
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {lookupItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => addProduct(item)}
                    disabled={!isEditable}
                    style={{ all: "unset", cursor: "pointer", border: "1px solid #e7ebf3", borderRadius: 12, padding: 10, display: "flex", justifyContent: "space-between", gap: 12, background: "#fcfdff" }}
                  >
                    <div>
                      <strong>{item.item_code}</strong>
                      <div style={{ fontSize: 12, opacity: 0.72 }}>{item.item_name}</div>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.72 }}>Stock {num(item.stock_qty).toFixed(4)}</div>
                  </button>
                ))}
              </div>
            ) : null}

            <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
              {lines.length ? (
                lines.map((line, index) => (
                  <div key={`${line.product_id}:${index}`} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 14, background: "#ffffff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 800 }}>L{index + 1} • {line.item_code || line.item_name || "Item"}</div>
                        <div style={{ fontSize: 12, opacity: 0.68 }}>{line.item_name || "No description"} • {line.uom || "—"}</div>
                      </div>
                      {isEditable ? <button onClick={() => removeLine(index)}>Remove</button> : null}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                      <MiniMetric label="Requested" value={num(line.qty_requested).toFixed(4)} />
                      <MiniMetric label="Issued" value={num(line.qty_issued).toFixed(4)} />
                      <MiniMetric label="Returned" value={num(line.qty_returned).toFixed(4)} />
                      <MiniMetric label="Outstanding" value={num(line.qty_outstanding).toFixed(4)} />
                    </div>
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>
                      Current Stock: <strong>{num(line.current_stock_qty).toFixed(4)}</strong>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Qty Requested
                        <input type="number" min="0" step="0.0001" value={line.qty_requested} disabled={!isEditable} onChange={(e) => updateLine(index, { qty_requested: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
                      </label>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Qty Consumed
                        <input type="number" min="0" step="0.0001" value={line.qty_consumed} disabled={!isEditable} onChange={(e) => updateLine(index, { qty_consumed: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
                      </label>
                    </div>
                    <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                      Remarks
                      <input value={line.remarks || ""} disabled={!isEditable} onChange={(e) => updateLine(index, { remarks: e.target.value })} style={{ height: 34, padding: "0 8px" }} />
                    </label>
                  </div>
                ))
              ) : (
                <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                  No material lines yet. Search and add products into the active job workspace.
                </div>
              )}
            </div>
          </DeskCard>

          <DeskCard title="Movement History" subtitle="Audit trail of issues, returns, and serial capture">
            {movements.length ? (
              <div style={{ display: "grid", gap: 10 }}>
                {movements.map((move) => (
                  <div key={move.id} style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 12 }}>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                      <DeskChip label={String(move.movement_type || "").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                      <span>Line {move.line_no}</span>
                      <span>Qty {num(move.qty).toFixed(4)}</span>
                      <span>{fmtDate(move.movement_date)}</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                      By {move.created_by_name || "Unknown"} • Logged {fmtDateTime(move.created_at)}
                    </div>
                    {move.serials?.length ? <div style={{ marginTop: 6, fontSize: 12 }}>Serials: {move.serials.join(", ")}</div> : null}
                    {move.remarks ? <div style={{ marginTop: 6, fontSize: 13 }}>{move.remarks}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ opacity: 0.72 }}>No material movements yet.</div>
            )}
          </DeskCard>
        </div>

        <div style={{ position: "sticky", top: 12 }}>
          <DeskCard title="Action Rail" subtitle="Status, posting context, and material movement actions">
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gap: 8 }}>
                <DeskChip label={`Status: ${String(jobStatus || "").toUpperCase()}`} tone={statusTone(jobStatus)} color={statusColor(jobStatus)} />
                {header.so_number ? <DeskChip label={`Sales Order ${header.so_number}`} tone="#eef4ff" color="#234a8f" /> : null}
                {header.bom_code ? <DeskChip label={`BOM ${header.bom_code}`} tone="#fff6e8" color="#8b5a00" /> : null}
              </div>
              {jobType === "manufacturing" ? (
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                  <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
                  Advanced — show cost &amp; absorption inputs
                </label>
              ) : null}
              {jobType === "manufacturing" && showAdvanced ? (
                <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 14, background: "#fffdfa", border: "1px solid #f2dfbf" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 800 }}>Cost / Absorption Inputs</div>
                    <button onClick={saveCosting} disabled={costingLoading}>
                      {costingLoading ? "Saving..." : "Save Costing"}
                    </button>
                  </div>
                  {costing ? (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Material Actual" value={num(costing.material_actual_value).toFixed(4)} />
                      <MiniMetric label="Expected Material" value={num(costing.expected_material_value_output).toFixed(4)} />
                      <MiniMetric label="Material Var" value={num(costing.material_variance_output).toFixed(4)} />
                      <MiniMetric label="Absorption" value={num(costing.material_absorption_ratio).toFixed(4)} />
                      <MiniMetric label="Labor" value={num(costing.labor_absorbed_value).toFixed(4)} />
                      <MiniMetric label="Overhead" value={num(costing.overhead_absorbed_value).toFixed(4)} />
                      <MiniMetric label="Total Cost" value={num(costing.total_absorbed_value).toFixed(4)} />
                      <MiniMetric label="SO Margin" value={num(costing.margin_vs_sales_order).toFixed(4)} />
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.72 }}>Cost snapshot not available yet for this job.</div>
                  )}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Actual Labor Hours
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={actualLaborHours}
                        onChange={(e) => setActualLaborHours(e.target.value)}
                        style={{ height: 34, padding: "0 8px" }}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                      Labor Hour Rate
                      <input
                        type="number"
                        min="0"
                        step="0.0001"
                        value={laborHourRate}
                        onChange={(e) => setLaborHourRate(e.target.value)}
                        style={{ height: 34, padding: "0 8px" }}
                      />
                    </label>
                  </div>
                  <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                    Overhead Absorption Amount
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={overheadAbsorptionAmount}
                      onChange={(e) => setOverheadAbsorptionAmount(e.target.value)}
                      style={{ height: 34, padding: "0 8px" }}
                    />
                  </label>
                  {costing?.profile_material_rate_basis ? (
                    <div style={{ fontSize: 12, opacity: 0.72 }}>
                      Material rate basis: <strong>{String(costing.profile_material_rate_basis)}</strong>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {jobType === "manufacturing" ? (
                <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 14, background: "#ffffff", border: "1px solid #edf1f6" }}>
                  <div style={{ fontWeight: 800 }}>Print / Shop Floor</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button onClick={() => openIssueSlip(id)}>Issue Slip</button>
                    <button onClick={() => openIssueSlipPdf(id)}>Issue Slip PDF</button>
                    <button onClick={() => openTraveler(id)}>Traveler</button>
                    <button onClick={() => openTravelerPdf(id)}>Traveler PDF</button>
                  </div>
                </div>
              ) : null}

              <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 14, background: "#f9fbff", border: "1px solid #e8eef7" }}>
                <div style={{ fontWeight: 700 }}>Stock Confidence</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  <MiniMetric label="FG Stock" value={stockConfidence.fgStock.toFixed(4)} />
                  <MiniMetric label="Outstanding RM" value={stockConfidence.totalOutstanding.toFixed(4)} />
                  <MiniMetric label="Issue Moves" value={String(stockConfidence.issueCount)} />
                  <MiniMetric label="Return Moves" value={String(stockConfidence.returnCount)} />
                </div>
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: stockConfidence.lowStockLines > 0 ? "#8b5a00" : "#58627a",
                    background: stockConfidence.lowStockLines > 0 ? "#fff7ea" : "#ffffff",
                    border: stockConfidence.lowStockLines > 0 ? "1px solid #f4dfb2" : "1px solid #edf1f6",
                    borderRadius: 10,
                    padding: "8px 10px",
                  }}
                >
                  {stockConfidence.lowStockLines > 0
                    ? `${stockConfidence.lowStockLines} material lines currently show stock lower than requested quantity.`
                    : "No obvious low-stock warning against requested quantities in this job."}
                </div>
              </div>

              <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 14, background: "#f9fbff", border: "1px solid #e8eef7" }}>
                <div style={{ fontWeight: 700 }}>Save Guidance</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                  Update the setup and material plan on the left, then save from the header. Use the movement console below for physical stock issue/return.
                </div>
                {jobType === "manufacturing" ? (
                  <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                    Use <strong>Print Issue Slip</strong> for stores, and <strong>Print Traveler</strong> for the full floor traveler with movements and signoff boxes.
                  </div>
                ) : null}
              </div>
              {receiptPostingNote ? (
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    padding: 12,
                    borderRadius: 14,
                    background:
                      receiptPostingNote.tone === "ready"
                        ? "#f2fff6"
                        : receiptPostingNote.tone === "warning"
                          ? "#fff7ea"
                          : "#f9fbff",
                    border:
                      receiptPostingNote.tone === "ready"
                        ? "1px solid #d6f4df"
                        : receiptPostingNote.tone === "warning"
                          ? "1px solid #f4dfb2"
                          : "1px solid #e8eef7",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>Manufacturing Receipt Guidance</div>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.6,
                      color:
                        receiptPostingNote.tone === "ready"
                          ? "#0a7a35"
                          : receiptPostingNote.tone === "warning"
                            ? "#8b5a00"
                            : "#58627a",
                    }}
                  >
                    {receiptPostingNote.message}
                  </div>
                </div>
              ) : null}
              {manufacturingCloseChecklist ? (
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    padding: 12,
                    borderRadius: 14,
                    background:
                      manufacturingCloseChecklist.isFinalStatus && !manufacturingCloseChecklist.readyToClose
                        ? "#fff2f2"
                        : manufacturingCloseChecklist.isFinalStatus
                          ? "#f2fff6"
                          : "#f9fbff",
                    border:
                      manufacturingCloseChecklist.isFinalStatus && !manufacturingCloseChecklist.readyToClose
                        ? "1px solid #f2c8c8"
                        : manufacturingCloseChecklist.isFinalStatus
                          ? "1px solid #d6f4df"
                          : "1px solid #e8eef7",
                  }}
                >
                  <div style={{ fontWeight: 700 }}>Close / Post Checklist</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {manufacturingCloseChecklist.checks.map((item) => (
                      <div
                        key={item.label}
                        style={{
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: item.done ? "#0a7a35" : item.critical ? "#b00020" : "#8b5a00",
                        }}
                      >
                        {item.done ? "OK" : item.critical ? "NEEDED" : "CHECK"} • {item.label}
                      </div>
                    ))}
                  </div>
                  {manufacturingCloseChecklist.isFinalStatus ? (
                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.6,
                        color: manufacturingCloseChecklist.readyToClose ? "#0a7a35" : "#b00020",
                        background: "#ffffff",
                        border: "1px solid #edf1f6",
                        borderRadius: 10,
                        padding: "8px 10px",
                      }}
                    >
                      {manufacturingCloseChecklist.readyToClose
                        ? `This job looks ready to ${jobStatus} from a manufacturing-control point of view.`
                        : `This job should not be ${jobStatus} yet because required manufacturing checks are still incomplete.`}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Issue / Return Material</div>
                {canMoveMaterial && lines.length ? (
                  <>
                    <div style={{ display: "grid", gap: 10 }}>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Line
                        <select value={movementForm.line_id} onChange={(e) => setMovementForm((prev) => ({ ...prev, line_id: e.target.value }))} style={{ height: 36 }}>
                          {lines.map((line) => (
                            <option key={line.id || line.product_id} value={String(line.id)}>
                              L{line.line_no || 0} • {line.item_code || line.item_name || "Item"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Movement Type
                        <select value={movementForm.movement_type} onChange={(e) => setMovementForm((prev) => buildMovementForm(lines, { ...prev, movement_type: e.target.value }))} style={{ height: 36 }}>
                          <option value="issue">Issue</option>
                          <option value="return">Return</option>
                        </select>
                      </label>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                          Qty
                          <input type="number" min="0" step="0.0001" value={movementForm.qty} onChange={(e) => setMovementForm((prev) => ({ ...prev, qty: e.target.value }))} style={{ height: 34, padding: "0 8px" }} />
                        </label>
                        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                          Date
                          <input type="date" value={movementForm.movement_date} onChange={(e) => setMovementForm((prev) => ({ ...prev, movement_date: e.target.value }))} style={{ height: 34 }} />
                        </label>
                      </div>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Reference No
                        <input value={movementForm.reference_no} onChange={(e) => setMovementForm((prev) => ({ ...prev, reference_no: e.target.value }))} style={{ height: 34, padding: "0 8px" }} />
                      </label>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Remarks
                        <textarea value={movementForm.remarks} onChange={(e) => setMovementForm((prev) => ({ ...prev, remarks: e.target.value }))} rows={3} style={{ padding: 10 }} />
                      </label>
                      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                        Serial Numbers
                        <textarea value={movementForm.serial_text} onChange={(e) => setMovementForm((prev) => ({ ...prev, serial_text: e.target.value }))} rows={4} placeholder="One serial number per line when required" style={{ padding: 10 }} />
                      </label>
                    </div>
                    <button onClick={recordMovement} disabled={movementLoading} style={{ marginTop: 12, width: "100%" }}>
                      {movementLoading ? "Recording..." : "Record Movement"}
                    </button>
                  </>
                ) : (
                  <div style={{ opacity: 0.72 }}>
                    {isServiceMrn
                      ? "Service MRNs need Service Head approval before stock issue. Use Shortage Desk / MIF when stock is short."
                      : "Add material lines and keep the job in Draft / Submitted / Approved / Open to record movement."}
                  </div>
                )}
              </div>
            </div>
          </DeskCard>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div style={{ border: "1px solid #f1f1f1", borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.72 }}>{label}</div>
      <div style={{ fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function statusTone(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "posted", "closed"],
    info: ["submitted", "open"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  }).tone;
}

function statusColor(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "posted", "closed"],
    info: ["submitted", "open"],
    danger: ["cancelled"],
    fallbackColor: "#58627a",
  }).color;
}
