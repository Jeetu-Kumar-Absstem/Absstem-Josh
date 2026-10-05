import { getDeskStatusAppearance } from "../shared/joshUi";

export const DEFAULT_PRICE_TYPES = [
  { key: "list", label: "List Price", multiplier: 1 },
  { key: "budget10", label: "Budgetary +10%", multiplier: 1.1 },
  { key: "budget20", label: "Budgetary +20%", multiplier: 1.2 },
  { key: "special14", label: "Special 1.4", multiplier: 1.4 },
];

export const VALID_SCOPE_TYPES = new Set(["included", "client_scope", "quoted_separately"]);

export const EMPTY_MAIL_BOOTSTRAP = {
  mail_enabled: false,
  group_names: [],
  sender: null,
  cc_users: [],
  default_to: "",
  default_cc: "",
  default_subject: "",
  default_body: "",
  default_preset_key: "",
  mail_presets: [],
  history: [],
  mail_source: {
    google_oauth_available: false,
    company_default_available: false,
    user_account: { connected: false, provider: "google", mailbox_email: "", display_name: "" },
    distributor_shared_account: { connected: false, provider: "google", mailbox_email: "", display_name: "" },
    effective_sender: { connected: false, source: "none", provider: null, email: "", display_name: "" },
  },
};

export const EMPTY_APPROVAL = {
  revision_status: "draft",
  autonomous_discount_pct: 0,
  max_discount_pct: 0,
  approval_required: false,
  requested_by: null,
  current_cycle_no: null,
  current_approver: null,
  suggested_approvers: [],
  approvals: [],
  triggering_lines: [],
  can_actor_approve: false,
  can_submit: false,
  can_issue: true,
};

export function normalizePriceTypes(priceTypes) {
  const normalized = (Array.isArray(priceTypes) ? priceTypes : [])
    .map((item) => {
      const key = String(item?.price_type_code || item?.key || "").trim();
      if (!key) return null;
      return {
        key,
        label: String(item?.price_type_name || item?.label || key).trim() || key,
        multiplier: Number(item?.multiplier || 1) || 1,
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : DEFAULT_PRICE_TYPES;
}

export function resolvePriceTypeKey(priceTypes, priceTypeKey) {
  const options = normalizePriceTypes(priceTypes);
  const key = String(priceTypeKey || "").trim();
  return options.some((item) => item.key === key) ? key : options[0].key;
}

export function getPriceListMultiplier(priceTypes, priceTypeKey) {
  const options = normalizePriceTypes(priceTypes);
  const key = resolvePriceTypeKey(options, priceTypeKey);
  return Number(options.find((item) => item.key === key)?.multiplier || 1);
}

export function tryParseJson(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_err) {
    return null;
  }
}

export function looksLikeHtml(text) {
  const value = typeof text === "string" ? text.trim().toLowerCase() : "";
  return value.startsWith("<!doctype") || value.startsWith("<html") || value.startsWith("<body");
}

function buildRequestError(res, rawText, data) {
  const err = new Error("Request failed");
  err.status = res.status;
  if (data && typeof data === "object") {
    err.data = data;
  } else if (rawText && !looksLikeHtml(rawText)) {
    err.data = { detail: rawText.slice(0, 500) };
  } else {
    err.data = null;
  }
  return err;
}

export async function apiFetch(path, options = {}) {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = isForm
    ? { ...(options.headers || {}) }
    : { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(path, {
    credentials: "include",
    ...options,
    headers,
  });

  const rawText = await res.text().catch(() => "");
  const data = tryParseJson(rawText);

  if (!res.ok) throw buildRequestError(res, rawText, data);
  return data;
}

export async function apiFetchForm(path, formData, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    ...options,
    body: formData,
  });

  const rawText = await res.text().catch(() => "");
  const data = tryParseJson(rawText);

  if (!res.ok) throw buildRequestError(res, rawText, data);
  return data;
}

export function getApiErrorMessage(error, fallback) {
  if (error?.data?.error === "REVISION_NOT_EDITABLE") return "This revision cannot be edited.";
  if (error?.data?.error === "CUSTOMER_NOT_ALLOWED") return "Customer not allowed for this distributor.";
  if (error?.data?.error === "DISTRIBUTOR_NOT_LINKED") return "Distributor is not linked.";
  if (error?.data?.error === "COMPANY_NOT_SELECTED") return "Select a company before creating a quote.";
  if (error?.data?.error === "LEAD_NOT_FOUND") return "The selected lead was not found.";
  if (error?.data?.error === "LEAD_CUSTOMER_MISMATCH") return "The selected lead does not belong to this customer.";
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

export function formatAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0.00";
  return numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDayAge(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return "Fresh";
  if (days === 0) return "Updated today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

export function runQuietly(task) {
  Promise.resolve()
    .then(task)
    .catch(() => {});
}

export function parseDraftNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && !value.trim().length) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function isBlankDraftLine(line) {
  const hasId = Number.isFinite(Number(line?.id)) && Number(line.id) > 0;
  if (hasId) return false;
  const hasProductId = Number.isFinite(Number(line?.product_id)) && Number(line.product_id) > 0;
  if (hasProductId) return false;
  if (String(line?.item_name || "").trim()) return false;

  return (
    !String(line?.remarks || "").trim().length &&
    parseDraftNumber(line?.qty, 1) === 1 &&
    parseDraftNumber(line?.gross_unit_price_quote, 0) === 0 &&
    parseDraftNumber(line?.discount_pct, 0) === 0 &&
    parseDraftNumber(line?.discount_amt, 0) === 0 &&
    parseDraftNumber(line?.unit_price_quote, 0) === 0 &&
    parseDraftNumber(line?.gst_pct, 0) === 0 &&
    String(line?.scope_type || "included").trim() === "included" &&
    String(line?.price_list || "list").trim() === "list"
  );
}

export function validateDraftLines(lines, { requireAtLeastOne = false } = {}) {
  const actionable = (Array.isArray(lines) ? lines : [])
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !isBlankDraftLine(line));

  if (requireAtLeastOne && !actionable.length) {
    return { ok: false, message: "Add at least one line item before saving.", actionable: [] };
  }

  for (const { line, index } of actionable) {
    const label = `Line ${index + 1}`;
    const itemName = String(line?.item_name || "").trim();
    const productId = Number(line?.product_id);
    const qty = parseDraftNumber(line?.qty, 0);
    const unitPrice = parseDraftNumber(line?.unit_price_quote, 0);
    const gstPct = parseDraftNumber(line?.gst_pct, 0);
    const scopeType = String(line?.scope_type || "included").trim();

    if (!Number.isFinite(productId) || productId <= 0) {
      return { ok: false, message: `${label}: select a Product Master item. Manual line entry is not allowed.`, actionable };
    }
    if (!itemName) return { ok: false, message: `${label}: item name is required.`, actionable };
    if (qty === null || qty <= 0) return { ok: false, message: `${label}: quantity must be greater than 0.`, actionable };
    if (unitPrice === null || unitPrice < 0) return { ok: false, message: `${label}: unit price cannot be negative.`, actionable };
    if (gstPct === null || gstPct < 0 || gstPct > 100) {
      return { ok: false, message: `${label}: GST must be between 0 and 100.`, actionable };
    }
    if (!VALID_SCOPE_TYPES.has(scopeType)) {
      return { ok: false, message: `${label}: scope type is invalid.`, actionable };
    }
  }

  return { ok: true, message: "", actionable };
}

export function getCustomerInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "CU";
}

const STATUS_APPEARANCE_GROUPS = {
  success: ["approved", "issued", "sent", "converted"],
  info: ["submitted", "pending", "pending_approval"],
  danger: ["cancelled", "rejected", "lapsed"],
  warning: ["draft"],
};

export function statusTone(status) {
  return getDeskStatusAppearance(status, { ...STATUS_APPEARANCE_GROUPS, fallbackTone: "#fff6e8" }).tone;
}

export function statusColor(status) {
  return getDeskStatusAppearance(status, { ...STATUS_APPEARANCE_GROUPS, fallbackColor: "#8b5a00" }).color;
}

export function formatScopeLabel(scopeType) {
  const value = String(scopeType || "included").replaceAll("_", " ").trim();
  if (!value) return "Included";
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function toDateInputValue(value) {
  if (!value) return "";
  const stamp = new Date(value);
  if (Number.isNaN(stamp.getTime())) return String(value).slice(0, 10);
  return stamp.toISOString().slice(0, 10);
}

export function dateInputValueFromToday(days) {
  const stamp = new Date();
  stamp.setDate(stamp.getDate() + (Number(days) || 0));
  return stamp.toISOString().slice(0, 10);
}

export function daysUntilDate(value) {
  if (!value) return null;
  const stamp = new Date(`${toDateInputValue(value)}T00:00:00`);
  if (Number.isNaN(stamp.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((stamp.getTime() - today.getTime()) / 86400000);
}
