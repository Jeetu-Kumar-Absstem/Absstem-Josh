import { cloneElement, isValidElement, useEffect, useMemo, useState } from "react";
import { SortTh, useSortedRows } from "../shared/tableSort";
import TypedConfirmModal from "../components/TypedConfirmModal";

const ROLE_OPTIONS = [
  ["sales_enquiry", "Sales enquiry"],
  ["quote_recipient", "Quote recipient"],
  ["technical_discussion", "Technical discussion"],
  ["dispatch_logistics", "Dispatch logistics"],
  ["invoice_recipient", "Invoice recipient"],
  ["payment_followup", "Payment follow-up"],
  ["service_warranty", "Service / warranty"],
];

const SITE_TYPES = [
  ["plant", "Plant"],
  ["ho", "Head office"],
  ["branch", "Branch"],
  ["warehouse", "Warehouse"],
  ["billing_office", "Billing office"],
];

const GST_STATUS_OPTIONS = [
  ["pending", "GST pending"],
  ["available", "GST available"],
  ["not_required", "Not required"],
];

const WIDE_FORM_GRID = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))",
  gap: 12,
};

const PAGE_SPLIT_GRID = {
  marginTop: 16,
  display: "grid",
  gridTemplateColumns: "280px minmax(0, 1fr)",
  gap: 16,
  alignItems: "start",
};

const CONTROL_STYLE = {
  width: "100%",
  minWidth: 0,
  maxWidth: "100%",
  boxSizing: "border-box",
};

function emptyCustomerForm() {
  return {
    customer_name: "",
    customer_code: "",
    is_active: true,
    country_id: "",
    legal_name: "",
    website: "",
    industry: "",
    email: "",
    phone: "",
    fax: "",
    city: "",
    state: "",
    gstin: "",
    tinno: "",
    pan: "",
    customer_type: "",
    account_manager: "",
    invoice_no: "",
    invoice_date: "",
    in_case_of_hospital: false,
    address_line1: "",
    address_line2: "",
    address_line3: "",
    pincode: "",
    credit_limit: "",
    credit_control_mode: "warning",
    is_credit_hold: false,
    credit_hold_reason: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    contact_designation: "",
    contact_department: "",
    contact_roles: ["sales_enquiry", "quote_recipient"],
  };
}

function emptySiteForm() {
  return {
    id: null,
    site_code: "",
    site_name: "",
    site_type: "plant",
    address_line1: "",
    address_line2: "",
    address_line3: "",
    city: "",
    state: "",
    pincode: "",
    gst_status: "pending",
    can_quote: true,
    can_dispatch: true,
    can_bill: true,
    is_default_quote_site: false,
    is_default_ship_to: false,
    is_default_bill_to: false,
    is_active: true,
    tax_registration_id: "",
  };
}

function emptyContactForm(isPrimary = false) {
  return {
    id: null,
    salutation: "",
    full_name: "",
    designation: "",
    department: "",
    email: "",
    phone: "",
    site_id: "",
    is_primary: Boolean(isPrimary),
    is_active: true,
    roles: ["sales_enquiry"],
  };
}

function emptyTaxForm() {
  return {
    id: null,
    state: "",
    gstin: "",
    registration_name: "",
    is_active: true,
  };
}

function emptyLocationBootstrap() {
  return {
    countries: [],
    states: [],
    cities: [],
  };
}

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

async function fetchLocationBootstrap() {
  const data = await apiFetch("/customers/bootstrap");
  return {
    countries: Array.isArray(data?.countries) ? data.countries : [],
    states: Array.isArray(data?.states) ? data.states : [],
    cities: Array.isArray(data?.cities) ? data.cities : [],
  };
}

async function createCityMaster({ countryId, stateId, cityName }) {
  const data = await apiFetch("/customers/location-masters/cities", {
    method: "POST",
    body: JSON.stringify({
      country_id: countryId,
      state_id: stateId,
      city_name: cityName,
    }),
  });
  return data?.city || null;
}

function getApiErrorMessage(error, fallback) {
  if (error?.data?.error === "POSSIBLE_DUPLICATE_CUSTOMER") return "Possible duplicate customer found.";
  if (error?.data?.error === "SOURCE_CUSTOMER_NOT_FOUND") return "Could not find that duplicate customer code. Check the code and try again.";
  if (error?.data?.error === "SOURCE_CUSTOMER_AMBIGUOUS") return "More than one customer matches that text. Use the exact customer code or a more specific name.";
  if (error?.data?.error === "TARGET_CUSTOMER_NOT_FOUND") return "This customer record is no longer available. Refresh and try again.";
  if (error?.data?.error === "SOURCE_ALREADY_MERGED") return "That source customer is already merged into another record.";
  if (error?.data?.error === "SOURCE_TARGET_SAME") return "Source and target cannot be the same customer.";
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function fmtMoney(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function optionsForCountry(states, countryId) {
  const key = String(countryId || "").trim();
  return (Array.isArray(states) ? states : []).filter((item) => key && String(item.country_id) === key);
}

function optionsForState(cities, stateId) {
  const key = String(stateId || "").trim();
  return (Array.isArray(cities) ? cities : []).filter((item) => key && String(item.state_id) === key);
}

function findStateIdByName(states, countryId, stateName) {
  const name = String(stateName || "").trim().toLowerCase();
  if (!name) return "";
  const match = optionsForCountry(states, countryId).find((item) => String(item.state_name || "").trim().toLowerCase() === name);
  return match ? String(match.id) : "";
}

function findCityIdByName(cities, stateId, cityName) {
  const name = String(cityName || "").trim().toLowerCase();
  if (!name) return "";
  const match = optionsForState(cities, stateId).find((item) => String(item.city_name || "").trim().toLowerCase() === name);
  return match ? String(match.id) : "";
}

function appendCityOption(cities, city) {
  if (!city?.id) return Array.isArray(cities) ? cities : [];
  const list = Array.isArray(cities) ? cities : [];
  if (list.some((item) => String(item.id) === String(city.id))) return list;
  return [...list, city].sort((a, b) => {
    const stateCompare = String(a?.state_name || "").localeCompare(String(b?.state_name || ""));
    if (stateCompare !== 0) return stateCompare;
    return String(a?.city_name || "").localeCompare(String(b?.city_name || ""));
  });
}

function Field({ label, children }) {
  let content = children;
  if (isValidElement(children) && typeof children.type === "string" && ["input", "select", "textarea"].includes(children.type)) {
    content = cloneElement(children, {
      style: {
        ...CONTROL_STYLE,
        ...(children.props.style || {}),
      },
    });
  }
  return (
    <div style={{ marginBottom: 12, minWidth: 0 }}>
      <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 4 }}>{label}</div>
      {content}
    </div>
  );
}

function SectionCard({ title, subtitle, actions = null, children }) {
  return (
    <div style={{ border: "1px solid #e6ebf2", borderRadius: 16, padding: 16, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{title}</div>
          {subtitle ? <div style={{ marginTop: 4, opacity: 0.72 }}>{subtitle}</div> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function duplicateConfidenceTheme(level) {
  if (level === "high") return { border: "#f2c7d1", background: "#fff6f8", accent: "#b4234d", chipBg: "#fde7ec" };
  if (level === "medium") return { border: "#f4e0b8", background: "#fffaf0", accent: "#9a6700", chipBg: "#fff1d6" };
  return { border: "#d8e3f6", background: "#f8fbff", accent: "#2557d6", chipBg: "#eaf1ff" };
}

function DuplicateChip({ label, tone = "#48607f", background = "#eef4ff" }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        background,
        color: tone,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function DuplicateList({ duplicates, renderAction = null }) {
  if (!duplicates?.length) return null;
  const highCount = duplicates.filter((item) => item?.duplicate_confidence?.level === "high").length;
  const mediumCount = duplicates.filter((item) => item?.duplicate_confidence?.level === "medium").length;
  const lowCount = duplicates.filter((item) => item?.duplicate_confidence?.level === "low").length;
  const websiteCount = duplicates.filter((item) => item?.match_website_domain).length;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {highCount ? <DuplicateChip label={`${highCount} high confidence`} tone="#b4234d" background="#fde7ec" /> : null}
        {mediumCount ? <DuplicateChip label={`${mediumCount} medium confidence`} tone="#9a6700" background="#fff1d6" /> : null}
        {lowCount ? <DuplicateChip label={`${lowCount} low confidence`} tone="#2557d6" background="#eaf1ff" /> : null}
        {websiteCount ? <DuplicateChip label={`${websiteCount} website match`} tone="#0f766e" background="#dcfce7" /> : null}
      </div>
      {duplicates.map((item) => (
        <div
          key={item.id}
          style={{
            border: `1px solid ${duplicateConfidenceTheme(item?.duplicate_confidence?.level).border}`,
            borderRadius: 12,
            padding: 12,
            background: duplicateConfidenceTheme(item?.duplicate_confidence?.level).background,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{item.customer_name}</div>
              <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {item?.duplicate_confidence?.label ? (
                  <DuplicateChip
                    label={`${item.duplicate_confidence.label} (${item.duplicate_confidence.score})`}
                    tone={duplicateConfidenceTheme(item?.duplicate_confidence?.level).accent}
                    background={duplicateConfidenceTheme(item?.duplicate_confidence?.level).chipBg}
                  />
                ) : null}
                {typeof item?.identity_quality?.score === "number" ? (
                  <DuplicateChip label={`Identity quality ${item.identity_quality.score}%`} tone="#2557d6" background="#eaf1ff" />
                ) : null}
                {item?.match_website_domain ? <DuplicateChip label="Website match" tone="#0f766e" background="#dcfce7" /> : null}
              </div>
            </div>
            {typeof renderAction === "function" ? renderAction(item) : null}
          </div>
          <div style={{ marginTop: 4, fontSize: 13, opacity: 0.8 }}>
            {[item.customer_code || null, item.city || null, item.state || null, item.email || null, item.phone || null].filter(Boolean).join(" • ")}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: duplicateConfidenceTheme(item?.duplicate_confidence?.level).accent }}>
            {(item.reasons || []).join(", ") || "Possible overlap"}
          </div>
          {Array.isArray(item?.hygiene_flags) && item.hygiene_flags.length ? (
            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {item.hygiene_flags.slice(0, 4).map((flag) => (
                <DuplicateChip key={flag} label={flag} tone="#7c3a02" background="#ffedd5" />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RoleChecks({ value, onChange }) {
  const setValue = Array.isArray(value) ? value : [];
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {ROLE_OPTIONS.map(([key, label]) => {
        const checked = setValue.includes(key);
        return (
          <label key={key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                if (e.target.checked) onChange([...setValue, key]);
                else onChange(setValue.filter((item) => item !== key));
              }}
            />
            {label}
          </label>
        );
      })}
    </div>
  );
}

function readinessTone(level) {
  if (level === "high") return { border: "#f2c8c8", background: "#fff4f4", accent: "#a53a3a", chip: "#fdeaea" };
  if (level === "medium") return { border: "#f3dfb4", background: "#fff9ef", accent: "#8b5a00", chip: "#fff0cf" };
  return { border: "#d8e6f7", background: "#f7fbff", accent: "#2457c6", chip: "#eaf1ff" };
}

function ReadinessChip({ label, level = "low" }) {
  const tone = readinessTone(level);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "4px 10px",
        borderRadius: 999,
        background: tone.chip,
        color: tone.accent,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function MiniMetric({ label, value, tone = "#1f3d6d" }) {
  return (
    <div style={{ border: "1px solid #e7edf5", borderRadius: 14, padding: 12, background: "#fff" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 800, color: tone }}>{value}</div>
    </div>
  );
}

function ActionSummaryCard({ title, body, actionLabel, level = "low", onAction = null, extra = null }) {
  const tone = readinessTone(level);
  return (
    <div style={{ border: `1px solid ${tone.border}`, borderRadius: 16, padding: 14, background: tone.background }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: tone.accent, opacity: 0.9 }}>Next focus</div>
          <div style={{ marginTop: 6, fontSize: 16, fontWeight: 800 }}>{title}</div>
        </div>
        {actionLabel ? (
          onAction ? (
            <button
              type="button"
              onClick={onAction}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "right",
              }}
              title="Click to jump to relevant section"
            >
              <ReadinessChip label={actionLabel} level={level} />
            </button>
          ) : (
            <ReadinessChip label={actionLabel} level={level} />
          )
        ) : null}
      </div>
      <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.7, color: "#415168" }}>{body}</div>
      {extra ? <div style={{ marginTop: 10 }}>{extra}</div> : null}
    </div>
  );
}

function ChecklistCard({ title, items, onSelectTab = null }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <div style={{ border: "1px solid #e6ebf2", borderRadius: 16, padding: 14, background: "#fff" }}>
      <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
        {list.map((item) => (
          <div
            key={item.label}
            onClick={() => {
              if (item.tabKey && onSelectTab) onSelectTab(item.tabKey);
            }}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "center",
              padding: "10px 12px",
              borderRadius: 12,
              background: item.done ? "#f2fbf5" : "#fff8ef",
              border: `1px solid ${item.done ? "#cfe7d7" : "#f1e0ba"}`,
              cursor: item.tabKey && onSelectTab ? "pointer" : "default",
              transition: "transform 0.1s ease",
            }}
            title={item.tabKey && onSelectTab ? "Click to open tab" : undefined}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{item.label}</div>
              {item.note ? <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>{item.note}</div> : null}
            </div>
            <ReadinessChip label={item.done ? "Ready" : "Pending"} level={item.done ? "low" : "medium"} />
          </div>
        ))}
      </div>
    </div>
  );
}

function AccordionSection({ sectionKey, openKey, onToggle, title, subtitle, actions = null, summary = null, children }) {
  const open = openKey === sectionKey;
  return (
    <div style={{ border: "1px solid #e6ebf2", borderRadius: 18, background: "#fff", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => onToggle(open ? null : sectionKey)}
        style={{
          width: "100%",
          border: "none",
          background: "transparent",
          padding: 16,
          textAlign: "left",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "flex-start",
          cursor: "pointer",
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
          {subtitle ? <div style={{ marginTop: 4, opacity: 0.72, lineHeight: 1.6 }}>{subtitle}</div> : null}
          {summary ? <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>{summary}</div> : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {actions}
          <ReadinessChip label={open ? "Open" : "Show"} level="low" />
        </div>
      </button>
      {open ? <div style={{ padding: "0 16px 16px", borderTop: "1px solid #eef2f7" }}>{children}</div> : null}
    </div>
  );
}

function buildCustomerListGuidance(customer) {
  const hasPrimary = Boolean(customer?.primary_contact_name);
  const activeSites = Number(customer?.active_site_count || 0);
  const pendingGstSites = Number(customer?.pending_gst_site_count || 0);
  const gstRegistrations = Number(customer?.tax_registration_count || 0);
  const onHold = customer?.is_credit_hold === true;

  if (onHold) {
    return {
      level: "high",
      reason: customer?.credit_hold_reason || "Customer is manually blocked before the next commercial step.",
      nextAction: "Review credit hold",
    };
  }
  if (!hasPrimary) {
    return {
      level: "high",
      reason: "A primary customer contact is not set yet.",
      nextAction: "Add primary contact",
    };
  }
  if (activeSites > 1) {
    return {
      level: "medium",
      reason: `${activeSites} additional sites are enabled. Keep them only where the same commercial customer truly spans multiple plants or branches.`,
      nextAction: "Review additional sites",
    };
  }
  if (pendingGstSites > 0 && gstRegistrations === 0) {
    return {
      level: "medium",
      reason: `${pendingGstSites} site${pendingGstSites === 1 ? "" : "s"} still need GST clarification.`,
      nextAction: "Review GST setup",
    };
  }
  return {
    level: "low",
    reason: "Customer account basics are in place and ready for day-to-day sales use.",
    nextAction: "Review customer",
  };
}

function buildCreateChecklist(form) {
  return [
    {
      label: "Company basics",
      done: Boolean(String(form.customer_name || "").trim() && String(form.country_id || "").trim()),
      note: "Customer name and country are the minimum starting point.",
    },
    {
      label: "Commercial reach",
      done: Boolean(String(form.email || "").trim() || String(form.phone || "").trim()),
      note: "Add at least one company phone or email.",
    },
    {
      label: "Location",
      done: Boolean(String(form.state || "").trim() && String(form.city || "").trim()),
      note: "State and city keep quoting and tax setup aligned.",
    },
    {
      label: "Primary contact",
      done: Boolean(String(form.contact_name || "").trim() || String(form.contact_email || "").trim() || String(form.contact_phone || "").trim()),
      note: "Optional at create time, but strongly recommended.",
    },
  ];
}

function buildCreateFocus(form, duplicates) {
  if (Array.isArray(duplicates) && duplicates.length) {
    return {
      level: "high",
      title: "Review duplicate watch before saving",
      body: "A similar customer already exists. Confirm whether this should become a new customer or be added under the existing master.",
      actionLabel: "Review duplicates",
    };
  }
  if (!String(form.customer_name || "").trim()) {
    return {
      level: "high",
      title: "Start with the customer name",
      body: "Create the company account first. Plants, contacts, and GST registrations can be layered in after the first save.",
      actionLabel: "Fill basics",
    };
  }
  if (!String(form.contact_name || "").trim() && !String(form.contact_email || "").trim() && !String(form.contact_phone || "").trim()) {
    return {
      level: "medium",
      title: "Add the first contact now if known",
      body: "Even one enquiry or quote recipient makes the account easier to use immediately from Sales and Quotes.",
      actionLabel: "Add contact",
    };
  }
  return {
    level: "low",
    title: "Create the company account",
    body: "The essentials are in place. Save now, then add plants, more contacts, and tax registrations only where needed.",
    actionLabel: "Create customer",
  };
}

function buildDetailChecklist(customer, sites, contacts, taxRegistrations) {
  const activeSites = (sites || []).filter((item) => item.is_active !== false);
  const primaryContact = (contacts || []).find((item) => item.is_primary && item.is_active !== false);
  const hasAddress = Boolean(String(customer?.address_line1 || "").trim() && String(customer?.city || "").trim() && String(customer?.state || "").trim());
  return [
    { label: "Company profile", tabKey: "profile", done: Boolean(String(customer?.customer_name || "").trim() && hasAddress), note: "Company name and billing location are ready." },
    { label: "Primary contact", tabKey: "contacts", done: Boolean(primaryContact), note: "One main customer contact is marked for enquiries and quotes." },
    {
      label: "Additional sites",
      tabKey: "sites",
      done: true,
      note:
        activeSites.length > 0
          ? `${activeSites.length} additional site${activeSites.length === 1 ? "" : "s"} enabled for this customer.`
          : "Optional. Most customers can stay on one main company address only.",
    },
    { label: "Tax coverage", tabKey: "tax", done: taxRegistrations.length > 0 || activeSites.every((item) => item.gst_status === "not_required"), note: "GST can stay pending, but visible coverage is clearer." },
  ];
}

function buildDetailFocus(customer, sites, contacts, taxRegistrations, duplicates) {
  if (customer?.is_credit_hold) {
    return {
      level: "high",
      title: "Customer is on manual hold",
      body: customer?.credit_hold_reason || "Commercial progression is blocked until the hold reason is cleared.",
      actionLabel: "Review hold",
      targetTab: "profile",
    };
  }
  if ((duplicates || []).length) {
    return {
      level: "medium",
      title: "Duplicate review is still available",
      body: "Check whether this customer should absorb a duplicate account instead of maintaining two masters for the same company.",
      actionLabel: "Review duplicate watch",
      targetTab: "duplicates",
    };
  }
  const activeSites = (sites || []).filter((item) => item.is_active !== false);
  const primaryContact = (contacts || []).find((item) => item.is_primary && item.is_active !== false);
  if (!primaryContact) {
    return {
      level: "high",
      title: "Primary contact is missing",
      body: "Sales and quoting are easier when one main person is clearly marked for this account.",
      actionLabel: "Set primary contact",
      targetTab: "contacts",
    };
  }
  if (activeSites.length > 1) {
    return {
      level: "medium",
      title: "Additional sites are enabled",
      body: "Keep multiple sites only where the same customer truly runs more than one plant or branch under one billing, credit, and tax identity.",
      actionLabel: "Review additional sites",
      targetTab: "sites",
    };
  }
  if (!taxRegistrations.length && activeSites.some((item) => item.gst_status === "pending")) {
    return {
      level: "medium",
      title: "GST follow-up is still pending",
      body: "Some sites are still marked GST pending. Add the state registration once the customer shares it.",
      actionLabel: "Review tax setup",
      targetTab: "tax",
    };
  }
  return {
    level: "low",
    title: "Customer master is operational",
    body: "The company account is in a usable state. Add extra sites only when this same customer genuinely operates through multiple plants or branches.",
    actionLabel: "Review account",
    targetTab: "profile",
  };
}

const CUSTOMER_SORT_SPEC = {
  customer_code: { type: "string", defaultDir: "asc" },
  customer_name: { type: "string", defaultDir: "asc" },
  tax_id: { type: "string", defaultDir: "asc" },
  location: { type: "string", defaultDir: "asc" },
  primary_contact_name: { type: "string", defaultDir: "asc" },
  active_site_count: { type: "number", defaultDir: "desc" },
  credit_limit: { type: "number", defaultDir: "desc" },
  status: { type: "string", defaultDir: "asc" },
};

function customerStatusLabel(c) {
  if (c.is_active === false) return "Inactive";
  if (c.is_credit_hold) return "Hold";
  return c.credit_control_mode ? String(c.credit_control_mode).replaceAll("_", " ") : "Active";
}

function customerSortValue(row, column) {
  if (column === "location") return [row.city, row.state].filter(Boolean).join(", ");
  if (column === "tax_id") return row.gstin || row.pan || "";
  if (column === "status") return customerStatusLabel(row);
  return row[column];
}

export default function Customers({
  openCustomerId = null,
  onOpenQuotes = null,
  onOpenSalesOrders = null,
  onOpenInvoices = null,
  onOpenArDesk = null,
}) {
  const [view, setView] = useState(
    Number.isFinite(Number(openCustomerId)) && Number(openCustomerId) > 0
      ? { type: "detail", id: Number(openCustomerId) }
      : { type: "list" }
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState([]);
  const [viewMode, setViewMode] = useState("table");
  const { sort, onSort, sorted: sortedCustomers } = useSortedRows(
    customers,
    CUSTOMER_SORT_SPEC,
    { column: "customer_name", dir: "asc" },
    { storageKey: "josh.customers.sort.v1", getValue: customerSortValue, tieBreak: (row) => row.customer_code }
  );

  async function loadList(query) {
    setLoading(true);
    setError("");
    try {
      const qp = query && query.trim().length ? `?q=${encodeURIComponent(query.trim())}` : "";
      const data = await apiFetch(`/customers${qp}`);
      setCustomers(Array.isArray(data?.customers) ? data.customers : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load customers."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList(q);
  }, [view.type]);

  useEffect(() => {
    const id = Number(openCustomerId);
    if (Number.isFinite(id) && id > 0) {
      setView({ type: "detail", id });
    }
  }, [openCustomerId]);

  if (view.type === "new") {
    return <CustomerCreate onCancel={() => setView({ type: "list" })} onCreated={(id) => setView({ type: "detail", id })} />;
  }

  if (view.type === "detail") {
    return (
      <CustomerDetail
        id={view.id}
        onBack={() => setView({ type: "list" })}
        onOpenQuotes={onOpenQuotes}
        onOpenSalesOrders={onOpenSalesOrders}
        onOpenInvoices={onOpenInvoices}
        onOpenArDesk={onOpenArDesk}
      />
    );
  }

  const totalCustomers = customers.length;
  const withPrimary = customers.filter((item) => item.primary_contact_name).length;
  const withSites = customers.filter((item) => Number(item.active_site_count || 0) > 0).length;
  const gstPending = customers.reduce((sum, item) => sum + Number(item.pending_gst_site_count || 0), 0);

  return (
    <div style={{ maxWidth: 1280 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>Customer Master</h2>
          <div style={{ opacity: 0.72, marginTop: 4 }}>
            Keep one customer per commercial entity. Use sites for plants and branches, and create a separate customer only when that branch runs its own billing, credit, or tax identity.
          </div>
        </div>
        <button onClick={() => setView({ type: "new" })}>New Customer</button>
        <button onClick={() => loadList(q)} disabled={loading}>
          Refresh
        </button>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 14, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, flex: 1, minWidth: 280 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company, site, contact, GST, email" style={{ flex: 1, minWidth: 240, padding: 8, borderRadius: 6, border: "1px solid #d8d8d8" }} />
          <button onClick={() => loadList(q)} disabled={loading}>
            Search
          </button>
        </div>
        <div style={{ display: "inline-flex", background: "#f1f5f9", padding: 3, borderRadius: 8, border: "1px solid #e2e8f0" }}>
          <button
            type="button"
            onClick={() => setViewMode("table")}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: viewMode === "table" ? 700 : 500,
              background: viewMode === "table" ? "#fff" : "transparent",
              color: viewMode === "table" ? "#1e40af" : "#64748b",
              border: "none",
              borderRadius: 6,
              boxShadow: viewMode === "table" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
              cursor: "pointer",
            }}
          >
            Compact Table
          </button>
          <button
            type="button"
            onClick={() => setViewMode("cards")}
            style={{
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: viewMode === "cards" ? 700 : 500,
              background: viewMode === "cards" ? "#fff" : "transparent",
              color: viewMode === "cards" ? "#1e40af" : "#64748b",
              border: "none",
              borderRadius: 6,
              boxShadow: viewMode === "cards" ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
              cursor: "pointer",
            }}
          >
            Card Grid
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
        <MiniMetric label="Customers Shown" value={totalCustomers} />
        <MiniMetric label="With Primary Contact" value={withPrimary} tone="#0f6b42" />
        <MiniMetric label="With Active Site" value={withSites} tone="#2457c6" />
        <MiniMetric label="GST Pending Sites" value={gstPending} tone={gstPending > 0 ? "#8b5a00" : "#0f6b42"} />
      </div>

      {viewMode === "table" ? (
        <div className="cd-table-responsive" style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <table className="cd-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <SortTh column="customer_code" label="Code" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-left" style={{ width: "110px" }} />
                <SortTh column="customer_name" label="Customer Name" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-left" />
                <SortTh column="tax_id" label="GSTIN / PAN" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-center" style={{ width: "150px" }} align="center" />
                <SortTh column="location" label="Location" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-center" style={{ width: "140px" }} align="center" />
                <SortTh column="primary_contact_name" label="Primary Contact" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-left" style={{ width: "160px" }} />
                <SortTh column="active_site_count" label="Sites" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-right" style={{ width: "80px" }} align="right" />
                <SortTh column="credit_limit" label="Credit Limit" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-right" style={{ width: "120px" }} align="right" />
                <SortTh column="status" label="Status" sort={sort} spec={CUSTOMER_SORT_SPEC} onSort={onSort} className="col-center" style={{ width: "120px" }} align="center" />
                <th style={{ width: "70px" }} className="col-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: "24px 12px", color: "#64748b" }}>
                    Loading customers…
                  </td>
                </tr>
              ) : sortedCustomers.length ? (
                sortedCustomers.map((c) => {
                  const isInactive = c.is_active === false;
                  const isHold = c.is_credit_hold;
                  return (
                    <tr
                      key={c.id}
                      onClick={() => setView({ type: "detail", id: c.id })}
                      style={{ cursor: "pointer" }}
                    >
                      <td className="col-left" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontWeight: 700, color: "#1e40af" }}>
                        {c.customer_code || "—"}
                      </td>
                      <td className="col-left">
                        <div style={{ fontWeight: 600, color: "#1e293b" }}>{c.customer_name}</div>
                        {c.legal_name && c.legal_name !== c.customer_name ? (
                          <div style={{ fontSize: 11, color: "#64748b" }}>{c.legal_name}</div>
                        ) : null}
                      </td>
                      <td className="col-center" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                        {c.gstin ? (
                          <span style={{ fontWeight: 600, color: "#0f766e" }}>{c.gstin}</span>
                        ) : c.pan ? (
                          <span style={{ color: "#475569" }}>PAN: {c.pan}</span>
                        ) : (
                          <span style={{ color: "#94a3b8" }}>—</span>
                        )}
                      </td>
                      <td className="col-center" style={{ fontSize: 12, color: "#334155" }}>
                        {[c.city, c.state].filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="col-left">
                        <div style={{ color: c.primary_contact_name ? "#1e293b" : "#94a3b8", fontWeight: c.primary_contact_name ? 600 : 400 }}>
                          {c.primary_contact_name || "Missing"}
                        </div>
                        {c.email ? <div style={{ fontSize: 11, color: "#64748b" }}>{c.email}</div> : null}
                      </td>
                      <td className="col-right" style={{ fontFamily: "ui-monospace, monospace" }}>
                        <span style={{ fontWeight: 600, color: Number(c.active_site_count || 0) > 0 ? "#2563eb" : "#64748b" }}>
                          {c.active_site_count || 0}
                        </span>
                        {Number(c.pending_gst_site_count || 0) > 0 ? (
                          <span style={{ fontSize: 10, color: "#d97706", marginLeft: 4 }} title="GST Pending Sites">
                            ({c.pending_gst_site_count}p)
                          </span>
                        ) : null}
                      </td>
                      <td className="col-right" style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>
                        {fmtMoney(c.credit_limit)}
                      </td>
                      <td className="col-center">
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: "capitalize",
                            background: isInactive ? "#f1f5f9" : isHold ? "#fef2f2" : "#ecfdf5",
                            color: isInactive ? "#64748b" : isHold ? "#991b1b" : "#047857",
                            border: `1px solid ${isInactive ? "#cbd5e1" : isHold ? "#fecaca" : "#a7f3d0"}`,
                          }}
                        >
                          {isInactive ? "Inactive" : isHold ? "Hold" : c.credit_control_mode ? String(c.credit_control_mode).replaceAll("_", " ") : "Active"}
                        </span>
                      </td>
                      <td className="col-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setView({ type: "detail", id: c.id });
                          }}
                          style={{
                            padding: "3px 8px",
                            fontSize: 11,
                            fontWeight: 600,
                            borderRadius: 4,
                            border: "1px solid #cbd5e1",
                            background: "#f8fafc",
                            color: "#334155",
                            cursor: "pointer",
                          }}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: "24px 12px", color: "#94a3b8" }}>
                    No customers found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          {loading ? (
            <div>Loading…</div>
          ) : sortedCustomers.length ? (
            sortedCustomers.map((c) => {
              const guidance = buildCustomerListGuidance(c);
              return (
                <button
                  key={c.id}
                  onClick={() => setView({ type: "detail", id: c.id })}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e6ebf2",
                    borderRadius: 18,
                    padding: 16,
                    background: "#fff",
                    display: "grid",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 18 }}>{c.customer_name}</div>
                      <div style={{ marginTop: 4, opacity: 0.72, fontSize: 13 }}>
                        {[c.customer_code || null, c.legal_name || null, c.industry || null].filter(Boolean).join(" • ") || "Commercial account"}
                      </div>
                    </div>
                    <ReadinessChip
                      label={c.is_active === false ? "Inactive" : c.is_credit_hold ? "Credit hold" : c.credit_control_mode ? String(c.credit_control_mode).replaceAll("_", " ") : "warning"}
                      level={c.is_credit_hold ? "high" : "low"}
                    />
                  </div>

                  <ActionSummaryCard title={guidance.nextAction} body={guidance.reason} actionLabel="Open customer" level={guidance.level} />

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                    <MiniMetric label="Primary Contact" value={c.primary_contact_name || "Missing"} tone={c.primary_contact_name ? "#0f6b42" : "#8b5a00"} />
                    <MiniMetric label="Sites" value={`${c.active_site_count || 0} active`} tone={Number(c.active_site_count || 0) > 0 ? "#2457c6" : "#8b5a00"} />
                    <MiniMetric label="Contacts" value={c.contact_count || 0} />
                    <MiniMetric label="GST Registrations" value={c.tax_registration_count || 0} />
                    <MiniMetric label="Pending GST Sites" value={c.pending_gst_site_count || 0} tone={Number(c.pending_gst_site_count || 0) > 0 ? "#8b5a00" : "#0f6b42"} />
                    <MiniMetric label="Credit Limit" value={fmtMoney(c.credit_limit)} />
                  </div>
                </button>
              );
            })
          ) : (
            <div style={{ opacity: 0.72 }}>No customers found.</div>
          )}
        </div>
      )}
    </div>
  );
}

function CustomerCreate({ onCancel, onCreated }) {
  const [form, setForm] = useState(emptyCustomerForm());
  const [locationBootstrap, setLocationBootstrap] = useState(emptyLocationBootstrap());
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [addCityOpen, setAddCityOpen] = useState(false);
  const [addCityName, setAddCityName] = useState("");
  const [savingCity, setSavingCity] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [duplicates, setDuplicates] = useState([]);
  const [openSection, setOpenSection] = useState("basics");
  const stateOptions = useMemo(() => optionsForCountry(locationBootstrap.states, form.country_id), [locationBootstrap.states, form.country_id]);
  const selectedStateId = useMemo(() => findStateIdByName(locationBootstrap.states, form.country_id, form.state), [locationBootstrap.states, form.country_id, form.state]);
  const cityOptions = useMemo(() => optionsForState(locationBootstrap.cities, selectedStateId), [locationBootstrap.cities, selectedStateId]);
  const selectedCityId = useMemo(() => findCityIdByName(locationBootstrap.cities, selectedStateId, form.city), [locationBootstrap.cities, selectedStateId, form.city]);
  const createChecklist = useMemo(() => buildCreateChecklist(form), [form]);
  const createFocus = useMemo(() => buildCreateFocus(form, duplicates), [form, duplicates]);

  useEffect(() => {
    fetchLocationBootstrap()
      .then(setLocationBootstrap)
      .catch(() => {});
  }, []);

  async function checkDuplicates() {
    setChecking(true);
    setError("");
    try {
      const data = await apiFetch("/customers/duplicate-check", {
        method: "POST",
        body: JSON.stringify(form),
      });
      const next = Array.isArray(data?.duplicates) ? data.duplicates : [];
      setDuplicates(next);
      setNotice(next.length ? "Possible duplicates found. Review before creating." : "No close duplicate found.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to check duplicates."));
    } finally {
      setChecking(false);
    }
  }

  async function submit(allowDuplicate = false) {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/customers", {
        method: "POST",
        body: JSON.stringify({ ...form, allow_duplicate: allowDuplicate }),
      });
      onCreated(data?.customer?.id);
    } catch (e) {
      if (e?.data?.error === "POSSIBLE_DUPLICATE_CUSTOMER") {
        setDuplicates(Array.isArray(e?.data?.duplicates) ? e.data.duplicates : []);
        setError("Possible duplicate customer found. Review and choose Create Anyway only if this is truly different.");
      } else {
        setError(getApiErrorMessage(e, "Failed to create customer."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleAddCity() {
    if (!form.country_id || !selectedStateId) {
      setError("Select country and state before adding a city.");
      return;
    }
    setSavingCity(true);
    setError("");
    setNotice("");
    try {
      const city = await createCityMaster({
        countryId: form.country_id,
        stateId: selectedStateId,
        cityName: addCityName,
      });
      setLocationBootstrap((prev) => ({ ...prev, cities: appendCityOption(prev.cities, city) }));
      setForm((prev) => ({ ...prev, city: city?.city_name || prev.city }));
      setAddCityName("");
      setAddCityOpen(false);
      setNotice(`City ${city?.city_name || ""} added.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add city."));
    } finally {
      setSavingCity(false);
    }
  }

  return (
    <div style={{ maxWidth: 1140 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>New Customer</h2>
          <div style={{ opacity: 0.72, marginTop: 4 }}>Create the commercial customer first, then add sites only for plants or branches that still belong to this same billing and credit identity.</div>
        </div>
        <button onClick={onCancel}>Back</button>
        <button onClick={() => checkDuplicates()} disabled={checking}>
          {checking ? "Checking..." : "Check Duplicates"}
        </button>
        <button onClick={() => submit(false)} disabled={saving}>
          {saving ? "Creating..." : "Create"}
        </button>
        {duplicates.length ? (
          <button onClick={() => submit(true)} disabled={saving}>
            Create Anyway
          </button>
        ) : null}
      </div>

      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div style={PAGE_SPLIT_GRID}>
        <div style={{ display: "grid", gap: 16, position: "sticky", top: 12 }}>
          <ActionSummaryCard title={createFocus.title} body={createFocus.body} actionLabel={createFocus.actionLabel} level={createFocus.level} />
          <ChecklistCard title="Create Readiness" items={createChecklist} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            <MiniMetric label="Duplicate Matches" value={duplicates.length} tone={duplicates.length ? "#a53a3a" : "#0f6b42"} />
            <MiniMetric label="Contact Roles" value={(form.contact_roles || []).length} tone="#2457c6" />
          </div>
        </div>

        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <AccordionSection
            sectionKey="basics"
            openKey={openSection}
            onToggle={setOpenSection}
            title="Company Basics"
            subtitle="Only the main company account details belong here."
            summary="This section now follows your saved Customer Master sheet first and also stores workbook fields like fax, TIN No, PAN, customer type, account manager, invoice reference, and hospital flag."
          >
            <div style={{ marginTop: 14, ...WIDE_FORM_GRID }}>
              <Field label="Customer Name"><input value={form.customer_name} onChange={(e) => setForm((p) => ({ ...p, customer_name: e.target.value }))} /></Field>
              <Field label="Customer Code"><input value={form.customer_code} onChange={(e) => setForm((p) => ({ ...p, customer_code: e.target.value }))} /></Field>
              <Field label="Legal Name (optional)"><input value={form.legal_name} onChange={(e) => setForm((p) => ({ ...p, legal_name: e.target.value }))} /></Field>
              <Field label="Industry (optional)"><input value={form.industry} onChange={(e) => setForm((p) => ({ ...p, industry: e.target.value }))} /></Field>
              <Field label="Website"><input value={form.website} onChange={(e) => setForm((p) => ({ ...p, website: e.target.value }))} /></Field>
              <Field label="Email ID"><input value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} /></Field>
              <Field label="Phone No"><input value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} /></Field>
              <Field label="Fax"><input value={form.fax} onChange={(e) => setForm((p) => ({ ...p, fax: e.target.value }))} /></Field>
              <Field label="GST IN"><input value={form.gstin} onChange={(e) => setForm((p) => ({ ...p, gstin: e.target.value.toUpperCase() }))} /></Field>
              <Field label="TIN No"><input value={form.tinno} onChange={(e) => setForm((p) => ({ ...p, tinno: e.target.value.toUpperCase() }))} /></Field>
              <Field label="PAN"><input value={form.pan} onChange={(e) => setForm((p) => ({ ...p, pan: e.target.value.toUpperCase() }))} /></Field>
              <Field label="Customer Type"><input value={form.customer_type} onChange={(e) => setForm((p) => ({ ...p, customer_type: e.target.value }))} /></Field>
              <Field label="Account Manager"><input value={form.account_manager} onChange={(e) => setForm((p) => ({ ...p, account_manager: e.target.value }))} /></Field>
              <Field label="Invoice No"><input value={form.invoice_no} onChange={(e) => setForm((p) => ({ ...p, invoice_no: e.target.value }))} /></Field>
              <Field label="Invoice Date"><input type="date" value={form.invoice_date} onChange={(e) => setForm((p) => ({ ...p, invoice_date: e.target.value }))} /></Field>
              <Field label="In Case of Hospital">
                <select
                  value={form.in_case_of_hospital ? "yes" : "no"}
                  onChange={(e) => setForm((p) => ({ ...p, in_case_of_hospital: e.target.value === "yes" }))}
                >
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </Field>
              <Field label="Active">
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))} />
                  Customer active
                </label>
              </Field>
            </div>
          </AccordionSection>

          <AccordionSection
            sectionKey="location"
            openKey={openSection}
            onToggle={setOpenSection}
            title="Location And Billing"
            subtitle="Use one clean billing location first. Plants and branches can come later if they stay under the same commercial customer."
            summary="Country, state, city, address, and pin code are enough to get the customer account ready."
          >
            <div style={{ marginTop: 14, ...WIDE_FORM_GRID }}>
              <Field label="Country">
                <select
                  value={form.country_id}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      country_id: e.target.value,
                      state: "",
                      city: "",
                    }))
                  }
                >
                  <option value="">Select country</option>
                  {locationBootstrap.countries.map((country) => (
                    <option key={country.id} value={String(country.id)}>
                      {country.iso_code} - {country.country_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="State Name">
                <select
                  value={selectedStateId}
                  onChange={(e) => {
                    const next = stateOptions.find((item) => String(item.id) === e.target.value) || null;
                    setForm((p) => ({
                      ...p,
                      state: next?.state_name || "",
                      city: "",
                    }));
                  }}
                  disabled={!form.country_id}
                >
                  <option value="">Select state</option>
                  {stateOptions.map((state) => (
                    <option key={state.id} value={String(state.id)}>
                      {state.state_code} - {state.state_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="City">
                <select
                  value={selectedCityId}
                  onChange={(e) => {
                    const next = cityOptions.find((item) => String(item.id) === e.target.value) || null;
                    setForm((p) => ({ ...p, city: next?.city_name || "" }));
                  }}
                  disabled={!selectedStateId}
                >
                  <option value="">Select city</option>
                  {cityOptions.map((city) => (
                    <option key={city.id} value={String(city.id)}>
                      {city.city_name}
                    </option>
                  ))}
                </select>
                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button type="button" onClick={() => setAddCityOpen((prev) => !prev)} disabled={!selectedStateId || savingCity}>
                    {addCityOpen ? "Cancel Add City" : "Add City"}
                  </button>
                  {!selectedStateId ? <span style={{ fontSize: 12, opacity: 0.7 }}>Select a state first.</span> : null}
                </div>
                {addCityOpen ? (
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input value={addCityName} onChange={(e) => setAddCityName(e.target.value)} placeholder="Enter city name" style={{ minWidth: 220 }} />
                    <button type="button" onClick={() => handleAddCity()} disabled={savingCity || !addCityName.trim()}>
                      {savingCity ? "Adding..." : "Save City"}
                    </button>
                  </div>
                ) : null}
              </Field>
              <Field label="Pin Code"><input value={form.pincode} onChange={(e) => setForm((p) => ({ ...p, pincode: e.target.value }))} /></Field>
              <Field label="Address Line 1"><input value={form.address_line1} onChange={(e) => setForm((p) => ({ ...p, address_line1: e.target.value }))} /></Field>
              <Field label="Address Line 2"><input value={form.address_line2} onChange={(e) => setForm((p) => ({ ...p, address_line2: e.target.value }))} /></Field>
              <Field label="Address Line 3 (optional)"><input value={form.address_line3} onChange={(e) => setForm((p) => ({ ...p, address_line3: e.target.value }))} /></Field>
            </div>
          </AccordionSection>

          <AccordionSection
            sectionKey="commercial"
            openKey={openSection}
            onToggle={setOpenSection}
            title="Commercial Controls"
            subtitle="Only add credit controls now if the account actually needs them."
            summary="Credit limit and hold are optional; most accounts can start with warning mode."
          >
            <div style={{ marginTop: 14, ...WIDE_FORM_GRID }}>
              <Field label="Credit limit"><input value={form.credit_limit} onChange={(e) => setForm((p) => ({ ...p, credit_limit: e.target.value }))} /></Field>
              <Field label="Credit control mode">
                <select value={form.credit_control_mode} onChange={(e) => setForm((p) => ({ ...p, credit_control_mode: e.target.value }))}>
                  <option value="warning">Warning only</option>
                  <option value="soft_block">Soft block</option>
                  <option value="hard_block">Hard block</option>
                </select>
              </Field>
            </div>
            <Field label="Manual credit hold">
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={form.is_credit_hold} onChange={(e) => setForm((p) => ({ ...p, is_credit_hold: e.target.checked }))} />
                Put this customer on hold
              </label>
            </Field>
            <Field label="Credit hold reason">
              <textarea rows={3} style={{ width: "100%" }} value={form.credit_hold_reason} onChange={(e) => setForm((p) => ({ ...p, credit_hold_reason: e.target.value }))} />
            </Field>
          </AccordionSection>

          <AccordionSection
            sectionKey="contact"
            openKey={openSection}
            onToggle={setOpenSection}
            title="Initial Contact"
            subtitle="Add the first enquiry or quote person if known."
            summary="You can always add more contacts after the first save."
          >
            <div style={{ marginTop: 14, ...WIDE_FORM_GRID }}>
              <Field label="Full name"><input value={form.contact_name} onChange={(e) => setForm((p) => ({ ...p, contact_name: e.target.value }))} /></Field>
              <Field label="Email"><input value={form.contact_email} onChange={(e) => setForm((p) => ({ ...p, contact_email: e.target.value }))} /></Field>
              <Field label="Phone"><input value={form.contact_phone} onChange={(e) => setForm((p) => ({ ...p, contact_phone: e.target.value }))} /></Field>
              <Field label="Designation"><input value={form.contact_designation} onChange={(e) => setForm((p) => ({ ...p, contact_designation: e.target.value }))} /></Field>
              <Field label="Department"><input value={form.contact_department} onChange={(e) => setForm((p) => ({ ...p, contact_department: e.target.value }))} /></Field>
            </div>
            <Field label="Roles"><RoleChecks value={form.contact_roles} onChange={(roles) => setForm((p) => ({ ...p, contact_roles: roles }))} /></Field>
          </AccordionSection>

          <AccordionSection
            sectionKey="duplicates"
            openKey={openSection}
            onToggle={setOpenSection}
            title="Duplicate Watch"
            subtitle="Check before saving when the customer may already exist under another code."
            summary="Use duplicate review to keep new plants and contacts under the existing company master, unless the branch should operate as its own customer."
            actions={<button onClick={() => checkDuplicates()} disabled={checking}>{checking ? "Checking..." : "Check now"}</button>}
          >
            <div style={{ marginTop: 14 }}>
              {duplicates.length ? <DuplicateList duplicates={duplicates} /> : <div style={{ opacity: 0.72 }}>No duplicate suggestion yet. Use <strong>Check now</strong> when you want a duplicate review before saving.</div>}
            </div>
          </AccordionSection>
        </div>
      </div>
    </div>
  );
}

function CustomerDetail({ id, onBack, onOpenQuotes = null, onOpenSalesOrders = null, onOpenInvoices = null, onOpenArDesk = null }) {
  const [loading, setLoading] = useState(true);
  const [locationBootstrap, setLocationBootstrap] = useState(emptyLocationBootstrap());
  const [customer, setCustomer] = useState(null);
  const [companyForm, setCompanyForm] = useState(emptyCustomerForm());
  const [sites, setSites] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [taxRegistrations, setTaxRegistrations] = useState([]);
  const [duplicates, setDuplicates] = useState([]);
  const [siteForm, setSiteForm] = useState(emptySiteForm());
  const [contactForm, setContactForm] = useState(emptyContactForm());
  const [taxForm, setTaxForm] = useState(emptyTaxForm());
  const [savingCompany, setSavingCompany] = useState(false);
  const [savingSite, setSavingSite] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [savingTax, setSavingTax] = useState(false);
  const [companyAddCityOpen, setCompanyAddCityOpen] = useState(false);
  const [companyAddCityName, setCompanyAddCityName] = useState("");
  const [companySavingCity, setCompanySavingCity] = useState(false);
  const [siteAddCityOpen, setSiteAddCityOpen] = useState(false);
  const [siteAddCityName, setSiteAddCityName] = useState("");
  const [siteSavingCity, setSiteSavingCity] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [canMerge, setCanMerge] = useState(false);
  const [mergePreview, setMergePreview] = useState(null);
  const [mergeWorking, setMergeWorking] = useState(false);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeSourceCode, setMergeSourceCode] = useState("");
  const [activeTab, setActiveTab] = useState("profile");
  const [showAdditionalSites, setShowAdditionalSites] = useState(false);
  const [showAdvancedProfile, setShowAdvancedProfile] = useState(false);
  const [productCodes, setProductCodes] = useState([]);
  const [productCodeForm, setProductCodeForm] = useState({
    id: null,
    product_id: "",
    product_label: "",
    customer_item_code: "",
    customer_item_description: "",
    customer_uom: "",
  });
  const [savingProductCode, setSavingProductCode] = useState(false);
  const [productSearchQ, setProductSearchQ] = useState("");
  const [productSearchResults, setProductSearchResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);

  async function loadDetail() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/customers/${id}`);
      const nextCustomer = data?.customer || null;
      const nextSites = Array.isArray(data?.sites) ? data.sites : [];
      setCustomer(nextCustomer);
      setSites(nextSites);
      const nextContacts = Array.isArray(data?.contacts) ? data.contacts : [];
      setContacts(nextContacts);
      const hasPrimary = nextContacts.some((item) => item.is_primary && item.is_active !== false);
      setContactForm(emptyContactForm(!hasPrimary));
      setTaxRegistrations(Array.isArray(data?.tax_registrations) ? data.tax_registrations : []);
      setDuplicates(Array.isArray(data?.duplicate_candidates) ? data.duplicate_candidates : []);
      setCanMerge(data?.can_merge === true);
      setShowAdditionalSites(nextSites.length > 0);
      try {
        const codesData = await apiFetch(`/customers/${id}/product-codes`);
        setProductCodes(Array.isArray(codesData?.product_codes) ? codesData.product_codes : []);
      } catch {
        setProductCodes([]);
      }
      if (nextCustomer) {
        setCompanyForm({
          ...emptyCustomerForm(),
          country_id: nextCustomer.country_id ? String(nextCustomer.country_id) : "",
          is_active: nextCustomer.is_active !== false,
          customer_name: nextCustomer.customer_name || "",
          customer_code: nextCustomer.customer_code || "",
          legal_name: nextCustomer.legal_name || "",
          website: nextCustomer.website || "",
          industry: nextCustomer.industry || "",
          email: nextCustomer.email || "",
          phone: nextCustomer.phone || "",
          fax: nextCustomer.fax || "",
          city: nextCustomer.city || "",
          state: nextCustomer.state || "",
          gstin: nextCustomer.gstin || "",
          tinno: nextCustomer.tinno || "",
          pan: nextCustomer.pan || "",
          customer_type: nextCustomer.customer_type || "",
          account_manager: nextCustomer.account_manager || "",
          invoice_no: nextCustomer.invoice_no || "",
          invoice_date: nextCustomer.invoice_date ? String(nextCustomer.invoice_date).slice(0, 10) : "",
          in_case_of_hospital: nextCustomer.in_case_of_hospital === true,
          address_line1: nextCustomer.address_line1 || "",
          address_line2: nextCustomer.address_line2 || "",
          address_line3: nextCustomer.address_line3 || "",
          pincode: nextCustomer.pincode || "",
          credit_limit: nextCustomer.credit_limit ?? "",
          credit_control_mode: nextCustomer.credit_control_mode || "warning",
          is_credit_hold: nextCustomer.is_credit_hold === true,
          credit_hold_reason: nextCustomer.credit_hold_reason || "",
        });
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load customer."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDetail().catch(() => {});
  }, [id]);

  useEffect(() => {
    fetchLocationBootstrap()
      .then(setLocationBootstrap)
      .catch(() => {});
  }, []);

  const siteOptions = useMemo(() => sites.filter((item) => item.is_active !== false), [sites]);
  const companyStateOptions = useMemo(() => optionsForCountry(locationBootstrap.states, companyForm.country_id), [locationBootstrap.states, companyForm.country_id]);
  const companySelectedStateId = useMemo(
    () => findStateIdByName(locationBootstrap.states, companyForm.country_id, companyForm.state),
    [locationBootstrap.states, companyForm.country_id, companyForm.state]
  );
  const companyCityOptions = useMemo(() => optionsForState(locationBootstrap.cities, companySelectedStateId), [locationBootstrap.cities, companySelectedStateId]);
  const companySelectedCityId = useMemo(
    () => findCityIdByName(locationBootstrap.cities, companySelectedStateId, companyForm.city),
    [locationBootstrap.cities, companySelectedStateId, companyForm.city]
  );
  const siteStateOptions = useMemo(() => optionsForCountry(locationBootstrap.states, siteForm.country_id), [locationBootstrap.states, siteForm.country_id]);
  const siteSelectedStateId = useMemo(
    () => findStateIdByName(locationBootstrap.states, siteForm.country_id, siteForm.state),
    [locationBootstrap.states, siteForm.country_id, siteForm.state]
  );
  const siteCityOptions = useMemo(() => optionsForState(locationBootstrap.cities, siteSelectedStateId), [locationBootstrap.cities, siteSelectedStateId]);
  const siteSelectedCityId = useMemo(
    () => findCityIdByName(locationBootstrap.cities, siteSelectedStateId, siteForm.city),
    [locationBootstrap.cities, siteSelectedStateId, siteForm.city]
  );
  const taxStateOptions = useMemo(() => optionsForCountry(locationBootstrap.states, companyForm.country_id), [locationBootstrap.states, companyForm.country_id]);
  const taxSelectedStateId = useMemo(
    () => findStateIdByName(locationBootstrap.states, companyForm.country_id, taxForm.state),
    [locationBootstrap.states, companyForm.country_id, taxForm.state]
  );

  async function saveCompany(allowDuplicate = false) {
    setSavingCompany(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...companyForm, allow_duplicate: allowDuplicate }),
      });
      setCustomer(data?.customer || customer);
      setDuplicates(Array.isArray(data?.duplicates) ? data.duplicates : []);
      setNotice("Customer company profile updated.");
      await loadDetail();
    } catch (e) {
      if (e?.data?.error === "POSSIBLE_DUPLICATE_CUSTOMER") {
        setDuplicates(Array.isArray(e?.data?.duplicates) ? e.data.duplicates : []);
        setError("Possible duplicate customer found. Review Duplicate Watch before saving anyway.");
      } else {
        setError(getApiErrorMessage(e, "Failed to save customer."));
      }
    } finally {
      setSavingCompany(false);
    }
  }

  async function handleAddCompanyCity() {
    if (!companyForm.country_id || !companySelectedStateId) {
      setError("Select country and state before adding a city.");
      return;
    }
    setCompanySavingCity(true);
    setError("");
    setNotice("");
    try {
      const city = await createCityMaster({
        countryId: companyForm.country_id,
        stateId: companySelectedStateId,
        cityName: companyAddCityName,
      });
      setLocationBootstrap((prev) => ({ ...prev, cities: appendCityOption(prev.cities, city) }));
      setCompanyForm((prev) => ({ ...prev, city: city?.city_name || prev.city }));
      setCompanyAddCityName("");
      setCompanyAddCityOpen(false);
      setNotice(`City ${city?.city_name || ""} added.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add city."));
    } finally {
      setCompanySavingCity(false);
    }
  }

  async function handleAddSiteCity() {
    if (!siteForm.country_id || !siteSelectedStateId) {
      setError("Select country and state before adding a city.");
      return;
    }
    setSiteSavingCity(true);
    setError("");
    setNotice("");
    try {
      const city = await createCityMaster({
        countryId: siteForm.country_id,
        stateId: siteSelectedStateId,
        cityName: siteAddCityName,
      });
      setLocationBootstrap((prev) => ({ ...prev, cities: appendCityOption(prev.cities, city) }));
      setSiteForm((prev) => ({ ...prev, city: city?.city_name || prev.city }));
      setSiteAddCityName("");
      setSiteAddCityOpen(false);
      setNotice(`City ${city?.city_name || ""} added.`);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to add city."));
    } finally {
      setSiteSavingCity(false);
    }
  }

  function editSite(site) {
    setSiteForm({
      id: site.id,
      country_id: site.country_id ? String(site.country_id) : companyForm.country_id || "",
      site_code: site.site_code || "",
      site_name: site.site_name || "",
      site_type: site.site_type || "plant",
      address_line1: site.address_line1 || "",
      address_line2: site.address_line2 || "",
      address_line3: site.address_line3 || "",
      city: site.city || "",
      state: site.state || "",
      pincode: site.pincode || "",
      gst_status: site.gst_status || "pending",
      can_quote: site.can_quote !== false,
      can_dispatch: site.can_dispatch !== false,
      can_bill: site.can_bill !== false,
      is_default_quote_site: site.is_default_quote_site === true,
      is_default_ship_to: site.is_default_ship_to === true,
      is_default_bill_to: site.is_default_bill_to === true,
      is_active: site.is_active !== false,
      tax_registration_id: site.tax_registration_id ? String(site.tax_registration_id) : "",
    });
  }

  async function saveSite() {
    setSavingSite(true);
    setError("");
    setNotice("");
    try {
      const path = siteForm.id ? `/customers/${id}/sites/${siteForm.id}` : `/customers/${id}/sites`;
      await apiFetch(path, {
        method: siteForm.id ? "PUT" : "POST",
        body: JSON.stringify(siteForm),
      });
      setNotice(siteForm.id ? "Customer site updated." : "Customer site added.");
      setSiteForm(emptySiteForm());
      await loadDetail();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save customer site."));
    } finally {
      setSavingSite(false);
    }
  }

  function editContact(contact) {
    setContactForm({
      id: contact.id,
      salutation: contact.salutation || "",
      full_name: contact.full_name || "",
      designation: contact.designation || "",
      department: contact.department || "",
      email: contact.email || "",
      phone: contact.phone || "",
      site_id: contact.site_id ? String(contact.site_id) : "",
      is_primary: contact.is_primary === true,
      is_active: contact.is_active !== false,
      roles: Array.isArray(contact.roles) ? contact.roles : [],
    });
  }

  async function previewMerge(sourceCustomerId) {
    setMergeWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/merge/preview`, {
        method: "POST",
        body: JSON.stringify({
          source_customer_id: Number(sourceCustomerId),
          target_customer_id: Number(id),
        }),
      });
      setMergePreview(data || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to preview customer merge."));
      setMergePreview(null);
    } finally {
      setMergeWorking(false);
    }
  }

  async function previewMergeByCode() {
    const code = mergeSourceCode.trim();
    if (!code) return;
    setMergeWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/merge/preview`, {
        method: "POST",
        body: JSON.stringify({
          source_customer_code: code,
          target_customer_id: Number(id),
        }),
      });
      setMergePreview(data || null);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to preview customer merge."));
      setMergePreview(null);
    } finally {
      setMergeWorking(false);
    }
  }

  async function executeMerge(confirmPhrase) {
    if (!mergePreview?.source_customer?.id || !mergePreview?.target_customer?.id) return;
    setMergeWorking(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/customers/merge/execute`, {
        method: "POST",
        body: JSON.stringify({
          source_customer_id: Number(mergePreview.source_customer.id),
          target_customer_id: Number(mergePreview.target_customer.id),
          confirm: true,
          confirm_phrase: String(confirmPhrase || ""),
        }),
      });
      setNotice("Customers merged.");
      setMergePreview(null);
      setMergeConfirmOpen(false);
      await loadDetail();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to merge customers."));
    } finally {
      setMergeWorking(false);
    }
  }

  async function saveContact() {
    setSavingContact(true);
    setError("");
    setNotice("");
    try {
      const path = contactForm.id ? `/customers/${id}/contacts/${contactForm.id}` : `/customers/${id}/contacts`;
      await apiFetch(path, {
        method: contactForm.id ? "PUT" : "POST",
        body: JSON.stringify(contactForm),
      });
      setNotice(contactForm.id ? "Customer contact updated." : "Customer contact added.");
      setContactForm(emptyContactForm());
      await loadDetail();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save customer contact."));
    } finally {
      setSavingContact(false);
    }
  }

  function editTax(item) {
    setTaxForm({
      id: item.id,
      state: item.state || "",
      gstin: item.gstin || "",
      registration_name: item.registration_name || "",
      is_active: item.is_active !== false,
    });
  }

  async function saveTax() {
    setSavingTax(true);
    setError("");
    setNotice("");
    try {
      const path = taxForm.id ? `/customers/${id}/tax-registrations/${taxForm.id}` : `/customers/${id}/tax-registrations`;
      await apiFetch(path, {
        method: taxForm.id ? "PUT" : "POST",
        body: JSON.stringify(taxForm),
      });
      setNotice(taxForm.id ? "Tax registration updated." : "Tax registration added.");
      setTaxForm(emptyTaxForm());
      await loadDetail();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save tax registration."));
    } finally {
      setSavingTax(false);
    }
  }

  function emptyProductCodeForm() {
    return {
      id: null,
      product_id: "",
      product_label: "",
      customer_item_code: "",
      customer_item_description: "",
      customer_uom: "",
    };
  }

  function editProductCode(item) {
    setProductCodeForm({
      id: item.id,
      product_id: item.product_id ? String(item.product_id) : "",
      product_label: [item.item_code, item.item_name].filter(Boolean).join(" — ") || `Product #${item.product_id}`,
      customer_item_code: item.customer_item_code || "",
      customer_item_description: item.customer_item_description || "",
      customer_uom: item.customer_uom || "",
    });
    setProductSearchQ("");
    setProductSearchResults([]);
  }

  async function searchProductsForMap() {
    const q = String(productSearchQ || "").trim();
    if (!q) {
      setProductSearchResults([]);
      return;
    }
    setProductSearchLoading(true);
    try {
      const params = new URLSearchParams({ q, limit: "12" });
      const data = await apiFetch(`/products?${params.toString()}`);
      setProductSearchResults(Array.isArray(data?.products) ? data.products : Array.isArray(data?.items) ? data.items : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to search products."));
      setProductSearchResults([]);
    } finally {
      setProductSearchLoading(false);
    }
  }

  async function saveProductCode() {
    setSavingProductCode(true);
    setError("");
    setNotice("");
    try {
      if (!productCodeForm.product_id) {
        setError("Select an Absstem product before saving the customer part map.");
        return;
      }
      if (!String(productCodeForm.customer_item_code || "").trim()) {
        setError("Customer item code is required.");
        return;
      }
      const path = productCodeForm.id
        ? `/customers/${id}/product-codes/${productCodeForm.id}`
        : `/customers/${id}/product-codes`;
      const data = await apiFetch(path, {
        method: productCodeForm.id ? "PUT" : "POST",
        body: JSON.stringify({
          product_id: Number(productCodeForm.product_id),
          customer_item_code: productCodeForm.customer_item_code,
          customer_item_description: productCodeForm.customer_item_description || null,
          customer_uom: productCodeForm.customer_uom || null,
        }),
      });
      setProductCodes(Array.isArray(data?.product_codes) ? data.product_codes : productCodes);
      setProductCodeForm(emptyProductCodeForm());
      setProductSearchQ("");
      setProductSearchResults([]);
      setNotice(productCodeForm.id ? "Customer product code updated." : "Customer product code mapped.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save customer product code."));
    } finally {
      setSavingProductCode(false);
    }
  }

  async function removeProductCode(mapId) {
    setSavingProductCode(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/customers/${id}/product-codes/${mapId}`, { method: "DELETE" });
      setProductCodes(Array.isArray(data?.product_codes) ? data.product_codes : []);
      if (Number(productCodeForm.id) === Number(mapId)) setProductCodeForm(emptyProductCodeForm());
      setNotice("Customer product code removed.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to remove customer product code."));
    } finally {
      setSavingProductCode(false);
    }
  }

  if (loading) return <div style={{ paddingTop: 12 }}>Loading…</div>;
  if (error && !customer) return <div style={{ paddingTop: 12, color: "#b00020" }}>{error}</div>;
  if (!customer) return <div style={{ paddingTop: 12 }}>Not found.</div>;

  const detailChecklist = buildDetailChecklist(customer, sites, contacts, taxRegistrations);
  const detailFocus = buildDetailFocus(customer, sites, contacts, taxRegistrations, duplicates);
  const activePrimaryContact = contacts.find((item) => item.is_primary && item.is_active !== false);
  const activeSitesCount = sites.filter((item) => item.is_active !== false).length;
  const pendingGstSites = sites.filter((item) => item.gst_status === "pending" && item.is_active !== false).length;
  const additionalSitesEnabled = showAdditionalSites || sites.length > 0;

  const detailTabs = [
    { key: "profile", label: "Overview & Profile" },
    { key: "sites", label: "Sites", count: activeSitesCount },
    { key: "contacts", label: "Contacts", count: contacts.length },
    { key: "tax", label: "Tax Registrations", count: taxRegistrations.length },
    { key: "product_codes", label: "Product Codes", count: productCodes.length },
    { key: "duplicates", label: "Duplicate Review", count: duplicates.length },
  ];

  return (
    <div style={{ maxWidth: 1320 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{customer.customer_name}</h2>
          <div style={{ opacity: 0.72, marginTop: 4 }}>
            {[customer.customer_code || null, customer.legal_name || null, customer.city || null, customer.state || null].filter(Boolean).join(" • ") || "Customer account"}
          </div>
        </div>
        <button onClick={() => loadDetail().catch(() => {})}>Refresh</button>
      </div>

      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      {(onOpenQuotes || onOpenSalesOrders || onOpenInvoices || onOpenArDesk) ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, padding: "8px 12px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0", alignItems: "center" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginRight: 4 }}>
            Quick Actions:
          </span>
          {typeof onOpenQuotes === "function" ? (
            <button
              type="button"
              onClick={() => onOpenQuotes(customer)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: "#1d4ed8",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Open Quotes
            </button>
          ) : null}
          {typeof onOpenSalesOrders === "function" ? (
            <button
              type="button"
              onClick={() => onOpenSalesOrders(customer)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: "#0f766e",
                background: "#f0fdfa",
                border: "1px solid #99f6e4",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Open Sales Orders
            </button>
          ) : null}
          {typeof onOpenInvoices === "function" ? (
            <button
              type="button"
              onClick={() => onOpenInvoices(customer)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: "#7c3aed",
                background: "#f5f3ff",
                border: "1px solid #ddd6fe",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Open Invoices
            </button>
          ) : null}
          {typeof onOpenArDesk === "function" ? (
            <button
              type="button"
              onClick={() => onOpenArDesk(customer)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: "#c2410c",
                background: "#fff7ed",
                border: "1px solid #fed7aa",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Open AR Desk
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={PAGE_SPLIT_GRID}>
        <div style={{ display: "grid", gap: 16, position: "sticky", top: 12 }}>
          <ActionSummaryCard
            title={detailFocus.title}
            body={detailFocus.body}
            actionLabel={detailFocus.actionLabel}
            level={detailFocus.level}
            onAction={detailFocus.targetTab ? () => setActiveTab(detailFocus.targetTab) : null}
          />
          <ChecklistCard
            title="Customer Readiness"
            items={detailChecklist}
            onSelectTab={(tab) => setActiveTab(tab)}
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            <MiniMetric label="Primary Contact" value={activePrimaryContact ? activePrimaryContact.full_name : "Missing"} tone={activePrimaryContact ? "#0f6b42" : "#8b5a00"} />
            <MiniMetric label="Additional Sites" value={activeSitesCount} tone={activeSitesCount ? "#2457c6" : "#5b6b83"} />
            <MiniMetric label="Tax Registrations" value={taxRegistrations.length} tone={taxRegistrations.length ? "#2457c6" : "#8b5a00"} />
            <MiniMetric label="Product Codes" value={productCodes.length} tone={productCodes.length ? "#2457c6" : "#5b6b83"} />
            <MiniMetric label="GST Pending Sites" value={pendingGstSites} tone={pendingGstSites ? "#8b5a00" : "#0f6b42"} />
          </div>
        </div>

        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          {/* Tab Bar Sub-Navigation */}
          <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #e2e8f0", paddingBottom: 6, flexWrap: "wrap" }}>
            {detailTabs.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    padding: "6px 12px",
                    fontSize: 12,
                    fontWeight: active ? 700 : 500,
                    borderRadius: 6,
                    border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
                    background: active ? "#eff6ff" : "#fff",
                    color: active ? "#1d4ed8" : "#475569",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    boxShadow: active ? "0 1px 2px rgba(37,99,235,0.08)" : "none",
                  }}
                >
                  <span>{tab.label}</span>
                  {tab.count !== undefined ? (
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: active ? "#dbeafe" : "#f1f5f9",
                        color: active ? "#1e40af" : "#64748b",
                        fontWeight: 700,
                      }}
                    >
                      {tab.count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* TAB 1: PROFILE */}
          {activeTab === "profile" ? (
            <div style={{ display: "grid", gap: 14 }}>
              {/* Card 1: Core Commercial Identity */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", borderBottom: "1px solid #f1f5f9", paddingBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15, color: "#1e293b" }}>Commercial Identity & Account Basics</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Core customer names, type, account manager, and active status.</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={() => saveCompany(false)}
                      disabled={savingCompany}
                      style={{ background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 6, padding: "5px 14px", fontWeight: 700, cursor: "pointer", fontSize: 12 }}
                    >
                      {savingCompany ? "Saving..." : "Save Changes"}
                    </button>
                    {duplicates.length ? (
                      <button onClick={() => saveCompany(true)} disabled={savingCompany} style={{ borderRadius: 6, padding: "5px 12px", fontSize: 12 }}>
                        Save anyway
                      </button>
                    ) : null}
                  </div>
                </div>

                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="Customer Name"><input value={companyForm.customer_name} onChange={(e) => setCompanyForm((p) => ({ ...p, customer_name: e.target.value }))} /></Field>
                  <Field label="Customer Code">
                    <input value={companyForm.customer_code} readOnly disabled />
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Locked after create</div>
                  </Field>
                  <Field label="Legal Name (optional)"><input value={companyForm.legal_name} onChange={(e) => setCompanyForm((p) => ({ ...p, legal_name: e.target.value }))} /></Field>
                  <Field label="Customer Type"><input value={companyForm.customer_type} onChange={(e) => setCompanyForm((p) => ({ ...p, customer_type: e.target.value }))} placeholder="e.g. End User / Distributor" /></Field>
                  <Field label="Account Manager"><input value={companyForm.account_manager} onChange={(e) => setCompanyForm((p) => ({ ...p, account_manager: e.target.value }))} /></Field>
                  <Field label="Status">
                    <label style={{ display: "flex", gap: 8, alignItems: "center", height: 36, fontSize: 13, fontWeight: 600 }}>
                      <input type="checkbox" checked={companyForm.is_active} onChange={(e) => setCompanyForm((p) => ({ ...p, is_active: e.target.checked }))} />
                      Active Customer
                    </label>
                  </Field>
                </div>
              </div>

              {/* Card 2: Billing Address & Location */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: "#1e293b", borderBottom: "1px solid #f1f5f9", paddingBottom: 10 }}>
                  Billing Address & Primary Location
                </div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="Country">
                    <select
                      value={companyForm.country_id}
                      onChange={(e) =>
                        setCompanyForm((p) => ({
                          ...p,
                          country_id: e.target.value,
                          state: "",
                          city: "",
                        }))
                      }
                    >
                      <option value="">Select country</option>
                      {locationBootstrap.countries.map((country) => (
                        <option key={country.id} value={String(country.id)}>
                          {country.iso_code} - {country.country_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="State Name">
                    <select
                      value={companySelectedStateId}
                      onChange={(e) => {
                        const next = companyStateOptions.find((item) => String(item.id) === e.target.value) || null;
                        setCompanyForm((p) => ({ ...p, state: next?.state_name || "", city: "" }));
                      }}
                      disabled={!companyForm.country_id}
                    >
                      <option value="">Select state</option>
                      {companyStateOptions.map((state) => (
                        <option key={state.id} value={String(state.id)}>
                          {state.state_code} - {state.state_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="City">
                    <select
                      value={companySelectedCityId}
                      onChange={(e) => {
                        const next = companyCityOptions.find((item) => String(item.id) === e.target.value) || null;
                        setCompanyForm((p) => ({ ...p, city: next?.city_name || "" }));
                      }}
                      disabled={!companySelectedStateId}
                    >
                      <option value="">Select city</option>
                      {companyCityOptions.map((city) => (
                        <option key={city.id} value={String(city.id)}>
                          {city.city_name}
                        </option>
                      ))}
                    </select>
                    <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <button type="button" onClick={() => setCompanyAddCityOpen((prev) => !prev)} disabled={!companySelectedStateId || companySavingCity} style={{ fontSize: 11, padding: "2px 8px" }}>
                        {companyAddCityOpen ? "Cancel Add City" : "+ Add City"}
                      </button>
                      {!companySelectedStateId ? <span style={{ fontSize: 11, opacity: 0.7 }}>Select a state first.</span> : null}
                    </div>
                    {companyAddCityOpen ? (
                      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <input value={companyAddCityName} onChange={(e) => setCompanyAddCityName(e.target.value)} placeholder="Enter city name" style={{ minWidth: 180, fontSize: 12, padding: "3px 8px" }} />
                        <button type="button" onClick={() => handleAddCompanyCity()} disabled={companySavingCity || !companyAddCityName.trim()} style={{ fontSize: 11, padding: "3px 8px" }}>
                          {companySavingCity ? "Adding..." : "Save City"}
                        </button>
                      </div>
                    ) : null}
                  </Field>
                  <Field label="Pin Code"><input value={companyForm.pincode} onChange={(e) => setCompanyForm((p) => ({ ...p, pincode: e.target.value }))} /></Field>
                  <Field label="Address Line 1"><input value={companyForm.address_line1} onChange={(e) => setCompanyForm((p) => ({ ...p, address_line1: e.target.value }))} /></Field>
                  <Field label="Address Line 2"><input value={companyForm.address_line2} onChange={(e) => setCompanyForm((p) => ({ ...p, address_line2: e.target.value }))} /></Field>
                </div>
              </div>

              {/* Card 3: Commercial Terms, Credit Controls & Tax */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: "#1e293b", borderBottom: "1px solid #f1f5f9", paddingBottom: 10 }}>
                  Tax Identifiers & Commercial Credit Controls
                </div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="GSTIN">
                    <input value={companyForm.gstin} readOnly disabled placeholder="15-digit GSTIN" />
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Locked after create</div>
                  </Field>
                  <Field label="PAN"><input value={companyForm.pan} onChange={(e) => setCompanyForm((p) => ({ ...p, pan: e.target.value.toUpperCase() }))} placeholder="10-digit PAN" /></Field>
                  <Field label="Credit Limit (₹)"><input value={companyForm.credit_limit ?? ""} onChange={(e) => setCompanyForm((p) => ({ ...p, credit_limit: e.target.value }))} placeholder="e.g. 500000" /></Field>
                  <Field label="Credit Control Mode">
                    <select value={companyForm.credit_control_mode} onChange={(e) => setCompanyForm((p) => ({ ...p, credit_control_mode: e.target.value }))}>
                      <option value="warning">Warning only</option>
                      <option value="soft_block">Soft block</option>
                      <option value="hard_block">Hard block</option>
                    </select>
                  </Field>
                </div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="Credit Hold">
                    <label style={{ display: "flex", gap: 8, alignItems: "center", height: 36, fontSize: 13, color: companyForm.is_credit_hold ? "#b91c1c" : "#334155", fontWeight: 600 }}>
                      <input type="checkbox" checked={companyForm.is_credit_hold} onChange={(e) => setCompanyForm((p) => ({ ...p, is_credit_hold: e.target.checked }))} />
                      Put customer on credit hold
                    </label>
                  </Field>
                  {companyForm.is_credit_hold ? (
                    <Field label="Hold Reason">
                      <input value={companyForm.credit_hold_reason} onChange={(e) => setCompanyForm((p) => ({ ...p, credit_hold_reason: e.target.value }))} placeholder="Reason for blocking sales orders / dispatch" />
                    </Field>
                  ) : null}
                </div>
              </div>

              {/* Card 4: Secondary & Legacy Information (Collapsible) */}
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", padding: "14px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#334155" }}>Secondary & Legacy References (Optional)</div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Website, phone, fax, TIN, address line 3, and legacy invoice notes.</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAdvancedProfile((prev) => !prev)}
                    style={{
                      background: "#f8fafc",
                      border: "1px solid #cbd5e1",
                      borderRadius: 6,
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      color: "#334155",
                      cursor: "pointer",
                    }}
                  >
                    {showAdvancedProfile ? "Hide Secondary Details ▲" : "Show Secondary Details ▼"}
                  </button>
                </div>

                {showAdvancedProfile ? (
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #f1f5f9", ...WIDE_FORM_GRID }}>
                    <Field label="Website"><input value={companyForm.website} onChange={(e) => setCompanyForm((p) => ({ ...p, website: e.target.value }))} /></Field>
                    <Field label="General Email"><input value={companyForm.email} onChange={(e) => setCompanyForm((p) => ({ ...p, email: e.target.value }))} /></Field>
                    <Field label="General Phone"><input value={companyForm.phone} onChange={(e) => setCompanyForm((p) => ({ ...p, phone: e.target.value }))} /></Field>
                    <Field label="Fax"><input value={companyForm.fax} onChange={(e) => setCompanyForm((p) => ({ ...p, fax: e.target.value }))} /></Field>
                    <Field label="TIN No"><input value={companyForm.tinno} onChange={(e) => setCompanyForm((p) => ({ ...p, tinno: e.target.value.toUpperCase() }))} /></Field>
                    <Field label="Industry"><input value={companyForm.industry} onChange={(e) => setCompanyForm((p) => ({ ...p, industry: e.target.value }))} /></Field>
                    <Field label="Address Line 3"><input value={companyForm.address_line3} onChange={(e) => setCompanyForm((p) => ({ ...p, address_line3: e.target.value }))} /></Field>
                    <Field label="Legacy Invoice No"><input value={companyForm.invoice_no} onChange={(e) => setCompanyForm((p) => ({ ...p, invoice_no: e.target.value }))} /></Field>
                    <Field label="Legacy Invoice Date"><input type="date" value={companyForm.invoice_date} onChange={(e) => setCompanyForm((p) => ({ ...p, invoice_date: e.target.value }))} /></Field>
                    <Field label="Hospital Account">
                      <select
                        value={companyForm.in_case_of_hospital ? "yes" : "no"}
                        onChange={(e) => setCompanyForm((p) => ({ ...p, in_case_of_hospital: e.target.value === "yes" }))}
                      >
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </select>
                    </Field>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* TAB 2: SITES */}
          {activeTab === "sites" ? (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 14, background: "#fff", padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", borderBottom: "1px solid #f1f5f9", paddingBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>Additional Sites & Branches</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Plants, warehouses, and branch offices linked to this commercial account.</div>
                </div>
                {siteForm.id ? (
                  <button onClick={() => setSiteForm(emptySiteForm())} style={{ borderRadius: 6, padding: "5px 12px" }}>
                    + New Site
                  </button>
                ) : null}
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10, marginBottom: 14 }}>
                {sites.length ? (
                  sites.map((site) => (
                    <button
                      key={site.id}
                      onClick={() => editSite(site)}
                      style={{ all: "unset", cursor: "pointer", border: "1px solid #e6ebf2", borderRadius: 12, padding: 12, background: "#fbfcff" }}
                    >
                      <div style={{ fontWeight: 700 }}>{site.site_name}</div>
                      <div style={{ marginTop: 4, opacity: 0.75, fontSize: 13 }}>
                        {[site.site_type, site.city, site.state, site.tax_gstin ? `GST ${site.tax_gstin}` : `GST ${site.gst_status}`].filter(Boolean).join(" • ")}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                        {[site.is_default_quote_site ? "Default quote" : null, site.is_default_ship_to ? "Default ship-to" : null, site.is_default_bill_to ? "Default bill-to" : null, site.is_active === false ? "Inactive" : null].filter(Boolean).join(" • ") || "Additional site"}
                      </div>
                    </button>
                  ))
                ) : (
                  <div style={{ opacity: 0.72 }}>No additional sites yet. Most customers can leave this empty.</div>
                )}
              </div>

              <div style={{ borderTop: "1px solid #eef1f6", paddingTop: 14 }}>
                <div style={{ fontWeight: 800 }}>{siteForm.id ? "Edit additional site" : "Add additional site"}</div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="Site name"><input value={siteForm.site_name} onChange={(e) => setSiteForm((p) => ({ ...p, site_name: e.target.value }))} /></Field>
                  <Field label="Site code"><input value={siteForm.site_code} onChange={(e) => setSiteForm((p) => ({ ...p, site_code: e.target.value }))} /></Field>
                  <Field label="Site type">
                    <select value={siteForm.site_type} onChange={(e) => setSiteForm((p) => ({ ...p, site_type: e.target.value }))}>
                      {SITE_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="GST status">
                    <select value={siteForm.gst_status} onChange={(e) => setSiteForm((p) => ({ ...p, gst_status: e.target.value }))}>
                      {GST_STATUS_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="Address line 1"><input value={siteForm.address_line1} onChange={(e) => setSiteForm((p) => ({ ...p, address_line1: e.target.value }))} /></Field>
                  <Field label="Address line 2"><input value={siteForm.address_line2} onChange={(e) => setSiteForm((p) => ({ ...p, address_line2: e.target.value }))} /></Field>
                  <Field label="Address line 3"><input value={siteForm.address_line3} onChange={(e) => setSiteForm((p) => ({ ...p, address_line3: e.target.value }))} /></Field>
                  <Field label="Pincode"><input value={siteForm.pincode} onChange={(e) => setSiteForm((p) => ({ ...p, pincode: e.target.value }))} /></Field>
                  <Field label="Country">
                    <select
                      value={siteForm.country_id}
                      onChange={(e) => setSiteForm((p) => ({ ...p, country_id: e.target.value, state: "", city: "" }))}
                    >
                      <option value="">Select country</option>
                      {locationBootstrap.countries.map((country) => (
                        <option key={country.id} value={String(country.id)}>
                          {country.iso_code} - {country.country_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="State">
                    <select
                      value={siteSelectedStateId}
                      onChange={(e) => {
                        const next = siteStateOptions.find((item) => String(item.id) === e.target.value) || null;
                        setSiteForm((p) => ({ ...p, state: next?.state_name || "", city: "" }));
                      }}
                      disabled={!siteForm.country_id}
                    >
                      <option value="">Select state</option>
                      {siteStateOptions.map((state) => (
                        <option key={state.id} value={String(state.id)}>
                          {state.state_code} - {state.state_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="City">
                    <select
                      value={siteSelectedCityId}
                      onChange={(e) => {
                        const next = siteCityOptions.find((item) => String(item.id) === e.target.value) || null;
                        setSiteForm((p) => ({ ...p, city: next?.city_name || "" }));
                      }}
                      disabled={!siteSelectedStateId}
                    >
                      <option value="">Select city</option>
                      {siteCityOptions.map((city) => (
                        <option key={city.id} value={String(city.id)}>
                          {city.city_name}
                        </option>
                      ))}
                    </select>
                    <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <button type="button" onClick={() => setSiteAddCityOpen((prev) => !prev)} disabled={!siteSelectedStateId || siteSavingCity}>
                        {siteAddCityOpen ? "Cancel Add City" : "Add City"}
                      </button>
                      {!siteSelectedStateId ? <span style={{ fontSize: 12, opacity: 0.7 }}>Select a state first.</span> : null}
                    </div>
                    {siteAddCityOpen ? (
                      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <input value={siteAddCityName} onChange={(e) => setSiteAddCityName(e.target.value)} placeholder="Enter city name" style={{ minWidth: 220 }} />
                        <button type="button" onClick={() => handleAddSiteCity()} disabled={siteSavingCity || !siteAddCityName.trim()}>
                          {siteSavingCity ? "Adding..." : "Save City"}
                        </button>
                      </div>
                    ) : null}
                  </Field>
                  <Field label="Tax registration">
                    <select value={siteForm.tax_registration_id} onChange={(e) => setSiteForm((p) => ({ ...p, tax_registration_id: e.target.value }))}>
                      <option value="">None / not known yet</option>
                      {taxRegistrations.map((item) => (
                        <option key={item.id} value={String(item.id)}>
                          {item.state || "State"} · {item.gstin || item.registration_name || `Reg ${item.id}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
                  {[
                    ["can_quote", "Can quote"],
                    ["can_dispatch", "Can dispatch"],
                    ["can_bill", "Can bill"],
                    ["is_default_quote_site", "Default quote site"],
                    ["is_default_ship_to", "Default ship-to"],
                    ["is_default_bill_to", "Default bill-to"],
                    ["is_active", "Active"],
                  ].map(([key, label]) => (
                    <label key={key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                      <input type="checkbox" checked={siteForm[key]} onChange={(e) => setSiteForm((p) => ({ ...p, [key]: e.target.checked }))} />
                      {label}
                    </label>
                  ))}
                </div>
                <button onClick={saveSite} disabled={savingSite} style={{ background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 6, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
                  {savingSite ? "Saving..." : siteForm.id ? "Update site" : "Add site"}
                </button>
              </div>
            </div>
          ) : null}

          {/* TAB 3: CONTACTS */}
          {activeTab === "contacts" ? (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 14, background: "#fff", padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", borderBottom: "1px solid #f1f5f9", paddingBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>Customer Contacts & Roles</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Enquiry, sales, billing, plant, and logistics communication.</div>
                </div>
                {contactForm.id ? (
                  <button onClick={() => setContactForm(emptyContactForm())} style={{ borderRadius: 6, padding: "5px 12px" }}>
                    + New Contact
                  </button>
                ) : null}
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10, marginBottom: 14 }}>
                {contacts.length ? (
                  contacts.map((contact) => (
                    <button
                      key={contact.id}
                      onClick={() => editContact(contact)}
                      style={{ all: "unset", cursor: "pointer", border: "1px solid #e6ebf2", borderRadius: 12, padding: 12, background: "#fbfcff" }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        {[contact.salutation || null, contact.full_name || null].filter(Boolean).join(" ")} {contact.is_primary ? "• Primary" : ""}
                      </div>
                      <div style={{ marginTop: 4, opacity: 0.76, fontSize: 13 }}>
                        {[contact.designation || null, contact.department || null, contact.site_name || null].filter(Boolean).join(" • ")}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.76 }}>
                        {[contact.email || null, contact.phone || null].filter(Boolean).join(" • ") || "No direct communication data"}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: "#234a8f" }}>
                        {(contact.roles || []).map((role) => ROLE_OPTIONS.find(([key]) => key === role)?.[1] || role).join(", ") || "No roles set"}
                      </div>
                    </button>
                  ))
                ) : (
                  <div style={{ opacity: 0.72 }}>No contacts yet.</div>
                )}
              </div>
              <div style={{ borderTop: "1px solid #eef1f6", paddingTop: 14 }}>
                <div style={{ fontWeight: 800 }}>{contactForm.id ? "Edit contact" : "Add contact"}</div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="Salutation">
                    <select value={contactForm.salutation} onChange={(e) => setContactForm((p) => ({ ...p, salutation: e.target.value }))}>
                      <option value="">—</option>
                      <option value="Mr">Mr</option>
                      <option value="Mrs">Mrs</option>
                      <option value="Ms">Ms</option>
                      <option value="Miss">Miss</option>
                      <option value="Dr">Dr</option>
                      <option value="Prof">Prof</option>
                    </select>
                  </Field>
                  <Field label="Full name"><input value={contactForm.full_name} onChange={(e) => setContactForm((p) => ({ ...p, full_name: e.target.value }))} /></Field>
                  <Field label="Designation"><input value={contactForm.designation} onChange={(e) => setContactForm((p) => ({ ...p, designation: e.target.value }))} /></Field>
                  <Field label="Department"><input value={contactForm.department} onChange={(e) => setContactForm((p) => ({ ...p, department: e.target.value }))} /></Field>
                  <Field label="Email"><input value={contactForm.email} onChange={(e) => setContactForm((p) => ({ ...p, email: e.target.value }))} /></Field>
                  <Field label="Phone"><input value={contactForm.phone} onChange={(e) => setContactForm((p) => ({ ...p, phone: e.target.value }))} /></Field>
                  <Field label="Site / plant">
                    <select value={contactForm.site_id} onChange={(e) => setContactForm((p) => ({ ...p, site_id: e.target.value }))}>
                      <option value="">Company level</option>
                      {siteOptions.map((site) => (
                        <option key={site.id} value={String(site.id)}>{site.site_name}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Roles"><RoleChecks value={contactForm.roles} onChange={(roles) => setContactForm((p) => ({ ...p, roles }))} /></Field>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={contactForm.is_primary} onChange={(e) => setContactForm((p) => ({ ...p, is_primary: e.target.checked }))} />
                    Primary contact
                  </label>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={contactForm.is_active} onChange={(e) => setContactForm((p) => ({ ...p, is_active: e.target.checked }))} />
                    Active
                  </label>
                </div>
                <button onClick={saveContact} disabled={savingContact} style={{ background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 6, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
                  {savingContact ? "Saving..." : contactForm.id ? "Update contact" : "Add contact"}
                </button>
              </div>
            </div>
          ) : null}

          {/* TAB 4: TAX */}
          {activeTab === "tax" ? (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 14, background: "#fff", padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", borderBottom: "1px solid #f1f5f9", paddingBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>Tax Registrations (State GST)</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>State-wise GST registrations for quoting, billing, and tax verification.</div>
                </div>
                {taxForm.id ? (
                  <button onClick={() => setTaxForm(emptyTaxForm())} style={{ borderRadius: 6, padding: "5px 12px" }}>
                    + New Registration
                  </button>
                ) : null}
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10, marginBottom: 14 }}>
                {taxRegistrations.length ? (
                  taxRegistrations.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => editTax(item)}
                      style={{ all: "unset", cursor: "pointer", border: "1px solid #e6ebf2", borderRadius: 12, padding: 12, background: "#fbfcff" }}
                    >
                      <div style={{ fontWeight: 700 }}>{item.registration_name || item.gstin || `Registration ${item.id}`}</div>
                      <div style={{ marginTop: 4, opacity: 0.76, fontSize: 13 }}>
                        {[item.state || null, item.gstin || "GST pending", item.is_active === false ? "Inactive" : null].filter(Boolean).join(" • ")}
                      </div>
                    </button>
                  ))
                ) : (
                  <div style={{ opacity: 0.72 }}>No tax registrations yet.</div>
                )}
              </div>
              <div style={{ borderTop: "1px solid #eef1f6", paddingTop: 14 }}>
                <div style={{ fontWeight: 800 }}>{taxForm.id ? "Edit tax registration" : "Add tax registration"}</div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="State">
                    <select
                      value={taxSelectedStateId}
                      onChange={(e) => {
                        const next = taxStateOptions.find((item) => String(item.id) === e.target.value) || null;
                        setTaxForm((p) => ({ ...p, state: next?.state_name || "" }));
                      }}
                      disabled={!companyForm.country_id}
                    >
                      <option value="">Select state</option>
                      {taxStateOptions.map((state) => (
                        <option key={state.id} value={String(state.id)}>
                          {state.state_code} - {state.state_name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="GSTIN">
                    <input
                      value={taxForm.gstin}
                      onChange={(e) => setTaxForm((p) => ({ ...p, gstin: e.target.value.toUpperCase() }))}
                      readOnly={Boolean(taxForm.id)}
                      disabled={Boolean(taxForm.id)}
                    />
                    {taxForm.id ? <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Locked after create</div> : null}
                  </Field>
                  <Field label="Registration name"><input value={taxForm.registration_name} onChange={(e) => setTaxForm((p) => ({ ...p, registration_name: e.target.value }))} /></Field>
                  <Field label="Active">
                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input type="checkbox" checked={taxForm.is_active} onChange={(e) => setTaxForm((p) => ({ ...p, is_active: e.target.checked }))} />
                      Registration active
                    </label>
                  </Field>
                </div>
                <button onClick={saveTax} disabled={savingTax} style={{ background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 6, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
                  {savingTax ? "Saving..." : taxForm.id ? "Update registration" : "Add registration"}
                </button>
              </div>
            </div>
          ) : null}

          {/* TAB 5: PRODUCT CODES */}
          {activeTab === "product_codes" ? (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 14, background: "#fff", padding: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", borderBottom: "1px solid #f1f5f9", paddingBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>Customer Product Codes</div>
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Map Absstem SKUs to the customer's SAP / part numbers for PO matching.</div>
                </div>
                {productCodeForm.id ? (
                  <button onClick={() => setProductCodeForm(emptyProductCodeForm())} style={{ borderRadius: 6, padding: "5px 12px" }}>
                    + New Mapping
                  </button>
                ) : null}
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10, marginBottom: 14 }}>
                {productCodes.length ? (
                  productCodes.map((item) => (
                    <div
                      key={item.id}
                      style={{ border: "1px solid #e6ebf2", borderRadius: 12, padding: 12, background: "#fbfcff", display: "grid", gap: 8 }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontWeight: 700 }}>{item.customer_item_code}</div>
                          <div style={{ marginTop: 4, opacity: 0.76, fontSize: 13 }}>
                            {[item.item_code, item.item_name].filter(Boolean).join(" — ") || `Product #${item.product_id}`}
                          </div>
                          {item.customer_item_description ? (
                            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>{item.customer_item_description}</div>
                          ) : null}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => editProductCode(item)}>Edit</button>
                          <button type="button" onClick={() => removeProductCode(item.id)} disabled={savingProductCode}>
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ opacity: 0.72 }}>No customer product codes mapped yet.</div>
                )}
              </div>
              <div style={{ borderTop: "1px solid #eef1f6", paddingTop: 14 }}>
                <div style={{ fontWeight: 800 }}>{productCodeForm.id ? "Edit product code map" : "Add product code map"}</div>
                <div style={{ marginTop: 12, ...WIDE_FORM_GRID }}>
                  <Field label="Absstem product">
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {productCodeForm.product_label || "Select a product from search"}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input
                          value={productSearchQ}
                          onChange={(e) => setProductSearchQ(e.target.value)}
                          placeholder="Search item code / name"
                          style={{ flex: 1, minWidth: 180 }}
                        />
                        <button type="button" onClick={searchProductsForMap} disabled={productSearchLoading}>
                          {productSearchLoading ? "Searching..." : "Search"}
                        </button>
                      </div>
                      {productSearchResults.length ? (
                        <div style={{ display: "grid", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                          {productSearchResults.map((product) => (
                            <button
                              key={product.id}
                              type="button"
                              onClick={() => {
                                setProductCodeForm((prev) => ({
                                  ...prev,
                                  product_id: String(product.id),
                                  product_label: [product.item_code, product.item_name].filter(Boolean).join(" — "),
                                }));
                                setProductSearchResults([]);
                                setProductSearchQ("");
                              }}
                              style={{
                                all: "unset",
                                cursor: "pointer",
                                border: "1px solid #e6ebf2",
                                borderRadius: 10,
                                padding: "8px 10px",
                                background: "#fff",
                                fontSize: 13,
                              }}
                            >
                              {[product.item_code, product.item_name].filter(Boolean).join(" — ") || `Product #${product.id}`}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </Field>
                  <Field label="Customer item code / SAP">
                    <input
                      value={productCodeForm.customer_item_code}
                      onChange={(e) => setProductCodeForm((p) => ({ ...p, customer_item_code: e.target.value }))}
                      placeholder="Customer SAP / part number"
                    />
                  </Field>
                  <Field label="Customer item description">
                    <input
                      value={productCodeForm.customer_item_description}
                      onChange={(e) => setProductCodeForm((p) => ({ ...p, customer_item_description: e.target.value }))}
                      placeholder="Optional customer material text"
                    />
                  </Field>
                  <Field label="Customer UOM">
                    <input
                      value={productCodeForm.customer_uom}
                      onChange={(e) => setProductCodeForm((p) => ({ ...p, customer_uom: e.target.value }))}
                      placeholder="Optional"
                    />
                  </Field>
                </div>
                <button onClick={saveProductCode} disabled={savingProductCode} style={{ marginTop: 8, background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 6, padding: "6px 14px", fontWeight: 700, cursor: "pointer" }}>
                  {savingProductCode ? "Saving..." : productCodeForm.id ? "Update mapping" : "Add mapping"}
                </button>
              </div>
            </div>
          ) : null}

          {/* TAB 6: DUPLICATES */}
          {activeTab === "duplicates" ? (
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 14, background: "#fff", padding: 18 }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Duplicate Watch & Account Merge</div>
              <div style={{ fontSize: 12, color: "#64748b", marginBottom: 14 }}>
                Keep this account open, then preview and merge duplicate codes or candidate plants into this customer.
              </div>

              {canMerge ? (
                <div style={{ border: "1px solid #e6ebf2", borderRadius: 12, padding: 12, marginBottom: 12, background: "#fbfcff" }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Manual Merge by Code or Name</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <input value={mergeSourceCode} onChange={(e) => setMergeSourceCode(e.target.value)} placeholder="Enter duplicate customer code or name" style={{ padding: 8, borderRadius: 6, border: "1px solid #d8d8d8" }} />
                    <button type="button" onClick={previewMergeByCode} disabled={mergeWorking || !mergeSourceCode.trim()}>
                      {mergeWorking ? "Working..." : "Preview Merge"}
                    </button>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.74, lineHeight: 1.6 }}>
                    Open the customer you want to keep, then search the duplicate by code or name and merge it into this account.
                  </div>
                </div>
              ) : null}

              {mergePreview ? (
                <div style={{ border: "1px solid #e6ebf2", borderRadius: 12, padding: 12, marginBottom: 12, background: "#fbfcff" }}>
                  <div style={{ fontWeight: 700 }}>Merge Preview</div>
                  <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8, lineHeight: 1.7 }}>
                    <div>Source: {mergePreview.source_customer?.customer_name || "—"} ({mergePreview.source_customer?.customer_code || "—"})</div>
                    <div>Target: {mergePreview.target_customer?.customer_name || "—"} ({mergePreview.target_customer?.customer_code || "—"})</div>
                    <div style={{ marginTop: 6 }}>
                      Items to move: {[
                        `Sites ${mergePreview.counts?.sites ?? 0}`,
                        `Contacts ${mergePreview.counts?.contacts ?? 0}`,
                        `GST ${mergePreview.counts?.tax_registrations ?? 0}`,
                        `Quotes ${mergePreview.counts?.quotes ?? 0}`,
                        `Orders ${mergePreview.counts?.sales_orders ?? 0}`,
                      ].join(" • ")}
                    </div>
                    {(mergePreview.conflicts?.site_code_conflicts || []).length ? (
                      <div style={{ marginTop: 6, color: "#7a4b0a" }}>
                        Site code conflicts: {(mergePreview.conflicts?.site_code_conflicts || []).length}. Conflicting site codes will be cleared.
                      </div>
                    ) : null}
                  </div>
                  <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={() => setMergeConfirmOpen(true)} disabled={mergeWorking}>{mergeWorking ? "Merging..." : "Confirm Merge"}</button>
                    <button onClick={() => setMergePreview(null)} disabled={mergeWorking}>Cancel</button>
                  </div>
                </div>
              ) : null}

              <TypedConfirmModal
                open={mergeConfirmOpen}
                title="Merge customers"
                message={`Source ${mergePreview?.source_customer?.customer_name || ""} will be merged into this account. Type the source customer code to continue.`}
                confirmPhrase={
                  String(mergePreview?.source_customer?.customer_code || "").trim() || `MERGE ${mergePreview?.source_customer?.id || ""}`
                }
                confirmLabel="Merge permanently"
                busy={mergeWorking}
                onCancel={() => setMergeConfirmOpen(false)}
                onConfirm={executeMerge}
              />

              {duplicates.length ? (
                <DuplicateList
                  duplicates={duplicates}
                  renderAction={
                    canMerge
                      ? (item) => (
                          <button onClick={() => previewMerge(item.id)} disabled={mergeWorking}>
                            {mergeWorking ? "Working..." : "Merge Candidate Here"}
                          </button>
                        )
                      : null
                  }
                />
              ) : (
                <div style={{ opacity: 0.72 }}>No duplicate overlap detected right now.</div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
