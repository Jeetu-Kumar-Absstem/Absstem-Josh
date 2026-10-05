import { useEffect, useMemo, useState } from "react";
import EinvoiceGspSettings from "./EinvoiceGspSettings";
import DriveFilesPanel from "../components/DriveFilesPanel";
import { canViewDrive } from "../shared/driveAccess";
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

async function apiFetchForm(path, formData, options) {
  const res = await fetch(path, {
    credentials: "include",
    body: formData,
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

function CompletionBar({ label, percent, note, tone = "#1f5eff", onClick }) {
  const body = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>{label}</strong>
        <span style={{ fontSize: 12, fontWeight: 800, color: tone }}>{percent}%</span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: "#eaf0f8", overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", background: tone, borderRadius: 999 }} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.72 }}>{note}</div>
    </>
  );

  if (!onClick) {
    return <div style={{ border: "1px solid #e3e8f2", borderRadius: 16, padding: 12, background: "#fff", display: "grid", gap: 8 }}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ all: "unset", cursor: "pointer", border: "1px solid #e3e8f2", borderRadius: 16, padding: 12, background: "#fff", display: "grid", gap: 8 }}
    >
      {body}
    </button>
  );
}

function SectionButton({ active, label, note, onClick }) {
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

function FocusActionCard({ title, note, tone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        borderRadius: 18,
        padding: 14,
        border: active ? `1px solid ${tone}` : "1px solid #dfe5ef",
        background: active ? "rgba(31, 94, 255, 0.06)" : "#fff",
        boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
        display: "grid",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 14, color: tone }}>{title}</strong>
      <span style={{ fontSize: 12, opacity: 0.74, lineHeight: 1.5 }}>{note}</span>
    </button>
  );
}

function StatusPill({ label, tone, background }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 24,
        padding: "3px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        color: tone,
        background,
      }}
    >
      {label}
    </span>
  );
}

const WORKSPACE_FAMILY_OPTIONS = [
  { value: "", label: "-- Inherit / Fallback --" },
  { value: "sales", label: "Sales" },
  { value: "finance", label: "Finance" },
  { value: "operations", label: "Operations" },
  { value: "dispatch", label: "Dispatch" },
  { value: "stores", label: "Stores" },
  { value: "aftermarket", label: "Aftermarket" },
  { value: "procurement", label: "Procurement" },
  { value: "marketing", label: "Marketing" },
  { value: "hr", label: "HR" },
  { value: "executive", label: "Executive / Leadership" },
  { value: "office", label: "Office Admin" },
  { value: "employee", label: "Self-service (no department desk)" },
  { value: "distributor", label: "Distributor" },
  { value: "superadmin", label: "SuperAdmin" },
];

const MASTER_OPTIONS = [
  { key: "countries", label: "Countries", idField: "id", codeField: "iso_code", codeLabel: "ISO Code", nameField: "country_name", nameLabel: "Country Name", extras: [] },
  {
    key: "states",
    label: "States",
    idField: "id",
    codeField: "state_code",
    codeLabel: "State Code",
    nameField: "state_name",
    nameLabel: "State Name",
    extras: [{ key: "country_id", label: "Country", type: "select", options: [] }],
  },
  {
    key: "cities",
    label: "Cities",
    idField: "id",
    codeField: "city_code",
    codeLabel: "City Code",
    nameField: "city_name",
    nameLabel: "City Name",
    extras: [
      { key: "country_id", label: "Country", type: "select", options: [] },
      { key: "state_id", label: "State", type: "select", options: [] },
    ],
  },
  {
    key: "currencies",
    label: "Currencies",
    idField: "id",
    codeField: "currency_code",
    codeLabel: "Currency Code",
    nameField: "currency_name",
    nameLabel: "Currency Name",
    extras: [
      { key: "symbol", label: "Symbol", type: "text" },
      { key: "decimal_precision", label: "Decimal Precision", type: "number" },
    ],
  },
  {
    key: "exchange_rates",
    label: "Exchange Rates",
    idField: "id",
    codeField: null,
    codeLabel: "",
    nameField: "rate_value",
    nameLabel: "Exchange Rate",
    nameInputType: "number",
    nameStep: "0.00000001",
    extras: [
      { key: "to_currency_id", label: "Quote Currency", type: "select", options: [] },
      { key: "rate_date", label: "Rate Date", type: "date" },
      {
        key: "source_type",
        label: "Source Type",
        type: "select",
        options: [
          { value: "manual", label: "Manual" },
          { value: "system", label: "System" },
        ],
      },
    ],
  },
  { key: "incoterms", label: "Incoterms", idField: "id", codeField: "incoterm_code", codeLabel: "Incoterm Code", nameField: "incoterm_name", nameLabel: "Incoterm Name", extras: [] },
  {
    key: "payment_terms",
    label: "Payment Terms",
    idField: "id",
    codeField: "term_code",
    codeLabel: "Term Code",
    nameField: "term_name",
    nameLabel: "Term Name",
    extras: [{ key: "credit_days", label: "Credit Days", type: "number" }],
  },
  { key: "freight_terms", label: "Freight Terms", idField: "id", codeField: "term_code", codeLabel: "Term Code", nameField: "term_name", nameLabel: "Term Name", extras: [] },
  { key: "p_and_f_terms", label: "P&F Terms", idField: "id", codeField: "term_code", codeLabel: "Term Code", nameField: "term_name", nameLabel: "Term Name", extras: [] },
  {
    key: "terms_master",
    label: "Terms Library",
    idField: "id",
    codeField: null,
    codeLabel: "",
    nameField: "caption",
    nameLabel: "Caption",
    extras: [
      { key: "default_description", label: "Default Description", type: "textarea" },
      {
        key: "applies_to",
        label: "Applies To",
        type: "select",
        options: [
          { value: "all", label: "All quotes" },
          { value: "completes", label: "Completes (plants) only" },
          { value: "spares", label: "Spares & Aftermarket only" },
        ],
      },
      { key: "spares_description", label: "Spares Wording (optional, replaces the default on spares quotes)", type: "textarea" },
      { key: "sort_order", label: "Sort Order", type: "number" },
    ],
  },
  {
    key: "price_types",
    label: "Price Types",
    idField: "id",
    codeField: "price_type_code",
    codeLabel: "Price Type Code",
    nameField: "price_type_name",
    nameLabel: "Price Type Name",
    extras: [
      { key: "multiplier", label: "Multiplier", type: "number", step: "0.0001" },
      { key: "sort_order", label: "Sort Order", type: "number" },
    ],
  },
  {
    key: "tax_codes",
    label: "Tax Codes",
    idField: "id",
    codeField: "tax_code",
    codeLabel: "Tax Code",
    nameField: "tax_name",
    nameLabel: "Tax Name",
    extras: [{ key: "tax_rate", label: "Tax Rate", type: "number", step: "0.01" }],
  },
  { key: "lead_sources", label: "Lead Sources", idField: "id", codeField: "source_code", codeLabel: "Source Code", nameField: "source_name", nameLabel: "Source Name", extras: [] },
  {
    key: "quote_closure_reasons",
    label: "Quote Closure Reasons",
    idField: "id",
    codeField: "reason_code",
    codeLabel: "Reason Code",
    nameField: "reason_name",
    nameLabel: "Reason Name",
    extras: [{ key: "sort_order", label: "Sort Order", type: "number" }],
  },
  { key: "erp_modules", label: "ERP Modules", idField: "id", codeField: "module_key", codeLabel: "Module Key", nameField: "module_name", nameLabel: "Module Name", extras: [] },
  {
    key: "designations",
    label: "Designations",
    idField: "id",
    codeField: null,
    codeLabel: "",
    nameField: "designation_name",
    nameLabel: "Designation",
    extras: [{ key: "sort_order", label: "Sort Order", type: "number" }],
  },
];

/** Wave 4: roles / departments / user_groups live only in Org & Access. */
const ORG_ACCESS_ONLY_NOTE =
  "Roles, departments, and user groups are maintained in Org & Access — not Admin Masters.";

function emptyDistributor() {
  return { id: null, distributor_code: "", company_name: "", country_id: "", contact_email: "", contact_phone: "", is_active: true };
}

function emptyVendor() {
  return {
    id: null,
    company_id: "",
    vendor_code: "",
    company_name: "",
    country_id: "",
    gstin: "",
    pan_no: "",
    address_line1: "",
    address_line2: "",
    address_line3: "",
    city: "",
    state: "",
    pincode: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    msme_registered: false,
    tds_enabled: false,
    tds_exempt: false,
    tds_section_id: "",
    lower_deduction_rate: "",
    is_active: true,
  };
}

function emptyCompanyProfile() {
  return {
    company_name: "",
    website: "",
    address_line1: "",
    address_line2: "",
    address_line3: "",
    city: "",
    state: "",
    state_code: "",
    pincode: "",
    country: "India",
    gstin: "",
    pan: "",
    contact_name: "",
    contact_email: "",
    contact_phone: "",
    bank_name: "",
    bank_branch: "",
    account_name: "",
    account_no: "",
    ifsc: "",
    invoice_declaration: "",
    logo_file_name: "",
    signature_file_name: "",
  };
}

function emptyMaster(config) {
  const base = { id: null, [config.nameField]: "", is_active: true };
  if (config.codeField) base[config.codeField] = "";
  for (const extra of config.extras) base[extra.key] = "";
  if (config.key === "exchange_rates") base.source_type = "manual";
  if (config.key === "terms_master") base.applies_to = "all";
  return base;
}

export default function AdminMasters({ me, mailConnectStatus, launch, onConsumeLaunch, onNavigate }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeSection, setActiveSection] = useState("company");
  const [pendingVendorId, setPendingVendorId] = useState(null);
  const [masterQuery, setMasterQuery] = useState("");
  const [bootstrap, setBootstrap] = useState({
    company_profiles: [],
    countries: [],
    states: [],
    cities: [],
    distributors: [],
    vendors: [],
    tds_sections: [],
    currencies: [],
    exchange_rates: [],
    incoterms: [],
    payment_terms: [],
    freight_terms: [],
    p_and_f_terms: [],
    price_types: [],
    tax_codes: [],
    lead_sources: [],
    quote_closure_reasons: [],
    roles: [],
    departments: [],
    user_groups: [],
    erp_modules: [],
    designations: [],
    terms_master: [],
  });
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [companyProfileForm, setCompanyProfileForm] = useState(emptyCompanyProfile());
  const [logoFileKey, setLogoFileKey] = useState(0);
  const [signatureFileKey, setSignatureFileKey] = useState(0);
  const [distributorForm, setDistributorForm] = useState(emptyDistributor());
  const [vendorForm, setVendorForm] = useState(emptyVendor());
  const [selectedMasterKey, setSelectedMasterKey] = useState(MASTER_OPTIONS[0].key);
  const [masterForm, setMasterForm] = useState(emptyMaster(MASTER_OPTIONS[0]));
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [expenseLimits, setExpenseLimits] = useState([]);
  const [expenseForm, setExpenseForm] = useState({ category: "", daily_cap: "", claim_cap: "", is_active: true });
  const [expenseBusy, setExpenseBusy] = useState(false);

  const selectedMaster = useMemo(() => MASTER_OPTIONS.find((item) => item.key === selectedMasterKey) || MASTER_OPTIONS[0], [selectedMasterKey]);
  const inrCurrency = useMemo(
    () => (bootstrap.currencies || []).find((currency) => String(currency.currency_code || "").trim().toUpperCase() === "INR") || null,
    [bootstrap.currencies]
  );
  const selectedMasterExtras = useMemo(
    () =>
      (selectedMaster.extras || []).map((extra) =>
        extra.key === "country_id"
          ? {
              ...extra,
              options: [{ value: "", label: "Select country" }, ...(bootstrap.countries || []).map((country) => ({ value: String(country.id), label: `${country.iso_code} - ${country.country_name}` }))],
            }
          : extra.key === "state_id"
            ? {
                ...extra,
                options: [
                  { value: "", label: "Select state" },
                  ...(bootstrap.states || [])
                    .filter((state) => !masterForm.country_id || String(state.country_id) === String(masterForm.country_id))
                    .map((state) => ({ value: String(state.id), label: `${state.state_code} - ${state.state_name}` })),
                ],
              }
          : extra.key === "to_currency_id"
              ? {
                  ...extra,
                  options: [
                    { value: "", label: "Select quote currency" },
                    ...(bootstrap.currencies || [])
                      .filter((currency) => !inrCurrency || String(currency.id) !== String(inrCurrency.id))
                      .map((currency) => ({
                      value: String(currency.id),
                      label: `${currency.currency_code} - ${currency.currency_name}`,
                    })),
                  ],
                }
            : extra
      ),
    [bootstrap.countries, bootstrap.currencies, bootstrap.states, inrCurrency, masterForm.country_id, selectedMaster]
  );
  const currentItems = useMemo(() => {
    const items = bootstrap[selectedMaster.key] || [];
    if (selectedMaster.key !== "exchange_rates" || !inrCurrency?.id) return items;
    return items.filter((item) => String(item.from_currency_id) === String(inrCurrency.id));
  }, [bootstrap, inrCurrency, selectedMaster]);
  const selectedCompanyRecord = useMemo(
    () => bootstrap.company_profiles.find((item) => String(item.company_id) === String(selectedCompanyId)) || bootstrap.company_profiles[0] || null,
    [bootstrap.company_profiles, selectedCompanyId]
  );
  const missingCommercialMasters = [
    !bootstrap.incoterms.length ? { label: "Incoterms", key: "incoterms" } : null,
    !bootstrap.payment_terms.length ? { label: "Payment terms", key: "payment_terms" } : null,
    !bootstrap.freight_terms.length ? { label: "Freight terms", key: "freight_terms" } : null,
    !bootstrap.p_and_f_terms.length ? { label: "P&F terms", key: "p_and_f_terms" } : null,
    !bootstrap.tax_codes.length ? { label: "Tax codes", key: "tax_codes" } : null,
    !bootstrap.lead_sources.length ? { label: "Lead sources", key: "lead_sources" } : null,
  ].filter(Boolean);
  const commercialMasterPins = [
    { label: "Incoterms", key: "incoterms", count: bootstrap.incoterms.length },
    { label: "Payment terms", key: "payment_terms", count: bootstrap.payment_terms.length },
    { label: "Freight terms", key: "freight_terms", count: bootstrap.freight_terms.length },
    { label: "P&F terms", key: "p_and_f_terms", count: bootstrap.p_and_f_terms.length },
    { label: "Tax codes", key: "tax_codes", count: bootstrap.tax_codes.length },
    { label: "Lead sources", key: "lead_sources", count: bootstrap.lead_sources.length },
  ];
  const readyCommercialMasters = commercialMasterPins.filter((item) => item.count > 0);
  const companyCompletionRows = useMemo(
    () =>
      bootstrap.company_profiles.map((item) => {
        const profile = item.profile || {};
        const checks = [
          Boolean(profile.company_name),
          Boolean(profile.gstin),
          Boolean(profile.pan),
          Boolean(profile.contact_email),
          Boolean(profile.bank_name),
          Boolean(profile.ifsc_code),
          Boolean(profile.logo_file_name),
          Boolean(profile.signature_file_name),
        ];
        const readyCount = checks.filter(Boolean).length;
        const percent = Math.round((readyCount / checks.length) * 100);
        const tone = percent === 100 ? "#14804a" : percent >= 63 ? "#1f5eff" : percent > 0 ? "#d97706" : "#e30513";
        const missing = [
          !profile.company_name ? "company name" : null,
          !profile.gstin ? "GSTIN" : null,
          !profile.pan ? "PAN" : null,
          !profile.contact_email ? "contact email" : null,
          !profile.bank_name ? "bank name" : null,
          !profile.ifsc_code ? "IFSC" : null,
          !profile.logo_file_name ? "logo" : null,
          !profile.signature_file_name ? "signature" : null,
        ].filter(Boolean);
        return {
          company_id: item.company_id,
          company_code: item.company_code,
          display_name: item.display_name || item.legal_name || item.company_code,
          percent,
          tone,
          missingDetails: missing,
          note: missing.length ? `Missing ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? " and more" : ""}` : "Core company profile checks are ready",
        };
      }),
    [bootstrap.company_profiles]
  );
  const selectedCompanyProgress = companyCompletionRows.find((item) => String(item.company_id) === String(selectedCompanyId)) || null;
  const nextIncompleteCompany = companyCompletionRows.find((item) => item.percent < 100) || null;
  const distributorsMissingMailbox = useMemo(
    () => bootstrap.distributors.filter((item) => !item.shared_mail_connected),
    [bootstrap.distributors]
  );
  const distributorsMissingContact = useMemo(
    () => bootstrap.distributors.filter((item) => !item.contact_email || !item.contact_phone),
    [bootstrap.distributors]
  );
  const vendorComplianceAlerts = useMemo(
    () =>
      bootstrap.vendors.filter(
        (item) => !item.gstin || !item.contact_email || (item.tds_enabled && !item.tds_exempt && !item.tds_section_id)
      ),
    [bootstrap.vendors]
  );
  const inactiveVendors = useMemo(() => bootstrap.vendors.filter((item) => !item.is_active), [bootstrap.vendors]);
  const nextDistributorMailboxGap = distributorsMissingMailbox[0] || distributorsMissingContact[0] || null;
  const nextVendorComplianceGap = vendorComplianceAlerts[0] || inactiveVendors[0] || null;
  const headerChips = [
    missingCommercialMasters.length
      ? { label: `${missingCommercialMasters.length} master gaps`, tone: "#b45309", background: "rgba(217, 119, 6, 0.12)" }
      : { label: "Commercial masters ready", tone: "#14804a", background: "rgba(20, 128, 74, 0.1)" },
    selectedCompanyProgress
      ? {
          label: `${selectedCompanyProgress.company_code} ${selectedCompanyProgress.percent}% complete`,
          tone: selectedCompanyProgress.tone,
          background: `${selectedCompanyProgress.tone}14`,
        }
      : null,
    selectedCompanyProgress?.missingDetails?.length
      ? {
          label: `Missing ${selectedCompanyProgress.missingDetails.slice(0, 3).join(", ")}`,
          tone: "#1f5eff",
          background: "rgba(31, 94, 255, 0.1)",
        }
      : null,
    distributorsMissingMailbox.length
      ? { label: `${distributorsMissingMailbox.length} distributor mailboxes pending`, tone: "#9f2042", background: "rgba(159, 32, 66, 0.1)" }
      : null,
  ].filter(Boolean);
  const filteredMasterItems = useMemo(() => {
    const q = masterQuery.trim().toLowerCase();
    if (!q) return currentItems;
    return currentItems.filter((item) =>
      [
        selectedMaster.codeField ? item[selectedMaster.codeField] : "",
        item[selectedMaster.nameField],
        ...selectedMasterExtras.map((extra) => item[extra.key]),
        item.country_name,
        item.state_name,
        item.from_currency_code,
        item.from_currency_name,
        item.to_currency_code,
        item.to_currency_name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [currentItems, masterQuery, selectedMaster, selectedMasterExtras]);
  const focusActions = [
    {
      key: "company",
      title: "Complete company identity",
      note: nextIncompleteCompany
        ? `${nextIncompleteCompany.company_code} is ${nextIncompleteCompany.percent}% ready. Finish statutory, banking, logo, and signature setup before more document traffic depends on it.`
        : "Company identity setup is complete for all visible companies.",
      tone: nextIncompleteCompany ? "#d97706" : "#14804a",
      active: activeSection === "company",
      onClick: () => {
        setActiveSection("company");
        if (nextIncompleteCompany) setSelectedCompanyId(String(nextIncompleteCompany.company_id));
      },
    },
    {
      key: "distributors",
      title: "Connect distributor mailboxes",
      note: distributorsMissingMailbox.length
        ? `${distributorsMissingMailbox.length} distributors still need shared mailbox connection or verification.`
        : distributorsMissingContact.length
          ? `${distributorsMissingContact.length} distributor records still need contact completion.`
          : "Distributor communication setup looks clean right now.",
      tone: distributorsMissingMailbox.length || distributorsMissingContact.length ? "#9f2042" : "#14804a",
      active: activeSection === "distributors",
      onClick: () => {
        setActiveSection("distributors");
        if (nextDistributorMailboxGap) editDistributor(nextDistributorMailboxGap);
      },
    },
    {
      key: "vendors",
      title: "Fix vendor compliance",
      note: vendorComplianceAlerts.length
        ? `${vendorComplianceAlerts.length} vendors are missing GST, contact, or TDS routing data.`
        : inactiveVendors.length
          ? `${inactiveVendors.length} vendors are inactive and may need cleanup review.`
          : "Vendor compliance coverage is in a healthy state.",
      tone: vendorComplianceAlerts.length ? "#b00020" : inactiveVendors.length ? "#8b5cf6" : "#14804a",
      active: activeSection === "vendors",
      onClick: () => {
        setActiveSection("vendors");
        if (nextVendorComplianceGap) editVendor(nextVendorComplianceGap);
      },
    },
    {
      key: "commercial",
      title: "Fill commercial master gaps",
      note: missingCommercialMasters.length
        ? `${missingCommercialMasters.length} master families are still empty: ${missingCommercialMasters
            .slice(0, 3)
            .map((item) => item.label)
            .join(", ")}${missingCommercialMasters.length > 3 ? ", and more" : ""}.`
        : "Commercial master coverage is populated, so this lane is ready for cleanup and fine-tuning.",
      tone: missingCommercialMasters.length ? "#234a8f" : "#14804a",
      active: activeSection === "commercial",
      onClick: () => {
        setActiveSection("commercial");
        if (missingCommercialMasters[0]?.key) setSelectedMasterKey(missingCommercialMasters[0].key);
      },
    },
  ];

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/admin-masters/bootstrap");
      const companyProfiles = Array.isArray(data?.company_profiles)
        ? data.company_profiles.map((item) => ({
            ...item,
            profile: { ...emptyCompanyProfile(), ...(item?.profile || {}) },
          }))
        : [];
      setBootstrap({
        company_profiles: companyProfiles,
        countries: Array.isArray(data?.countries) ? data.countries : [],
        states: Array.isArray(data?.states) ? data.states : [],
        cities: Array.isArray(data?.cities) ? data.cities : [],
        distributors: Array.isArray(data?.distributors) ? data.distributors : [],
        vendors: Array.isArray(data?.vendors) ? data.vendors : [],
        tds_sections: Array.isArray(data?.tds_sections) ? data.tds_sections : [],
        currencies: Array.isArray(data?.currencies) ? data.currencies : [],
        exchange_rates: Array.isArray(data?.exchange_rates) ? data.exchange_rates : [],
        incoterms: Array.isArray(data?.incoterms) ? data.incoterms : [],
        payment_terms: Array.isArray(data?.payment_terms) ? data.payment_terms : [],
        freight_terms: Array.isArray(data?.freight_terms) ? data.freight_terms : [],
        p_and_f_terms: Array.isArray(data?.p_and_f_terms) ? data.p_and_f_terms : [],
        price_types: Array.isArray(data?.price_types) ? data.price_types : [],
        tax_codes: Array.isArray(data?.tax_codes) ? data.tax_codes : [],
        lead_sources: Array.isArray(data?.lead_sources) ? data.lead_sources : [],
        quote_closure_reasons: Array.isArray(data?.quote_closure_reasons) ? data.quote_closure_reasons : [],
        roles: Array.isArray(data?.roles) ? data.roles : [],
        departments: Array.isArray(data?.departments) ? data.departments : [],
        user_groups: Array.isArray(data?.user_groups) ? data.user_groups : [],
        erp_modules: Array.isArray(data?.erp_modules) ? data.erp_modules : [],
        designations: Array.isArray(data?.designations) ? data.designations : [],
        terms_master: Array.isArray(data?.terms_master) ? data.terms_master : [],
      });
      setSelectedCompanyId((prev) => {
        if (prev && companyProfiles.some((item) => String(item.company_id) === String(prev))) return prev;
        return companyProfiles[0]?.company_id ? String(companyProfiles[0].company_id) : "";
      });
    } catch (e) {
      setError(e?.data?.error || "Failed to load Admin Masters.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll().catch(() => {});
  }, []);

  useEffect(() => {
    if (!mailConnectStatus) return;
    if (mailConnectStatus === "success") {
      setNotice("Mailbox connected successfully.");
      loadAll().catch(() => {});
    } else if (mailConnectStatus === "refresh_required") {
      setError("Google did not return offline access. Please reconnect and allow consent.");
    } else if (mailConnectStatus === "failed") {
      setError("Mailbox connection failed.");
    }
  }, [mailConnectStatus]);

  useEffect(() => {
    setMasterForm(emptyMaster(selectedMaster));
    setMasterQuery("");
  }, [selectedMaster]);

  useEffect(() => {
    setCompanyProfileForm(selectedCompanyRecord?.profile ? { ...emptyCompanyProfile(), ...selectedCompanyRecord.profile } : emptyCompanyProfile());
  }, [selectedCompanyRecord]);

  useEffect(() => {
    if (activeSection === "expense_policy") loadExpenseLimits().catch(() => {});
  }, [activeSection, selectedCompanyId]);

  useEffect(() => {
    if (!launch) return;
    if (launch.companyId) {
      setSelectedCompanyId(String(launch.companyId));
    }
    if (["company", "distributors", "vendors", "commercial", "expense_policy", "gsp"].includes(launch.activeSection)) {
      setActiveSection(launch.activeSection);
    }
    if (launch.selectedMasterKey && MASTER_OPTIONS.some((item) => item.key === launch.selectedMasterKey)) {
      setActiveSection("commercial");
      setSelectedMasterKey(launch.selectedMasterKey);
      setMasterQuery("");
      setMasterForm(emptyMaster(MASTER_OPTIONS.find((item) => item.key === launch.selectedMasterKey) || MASTER_OPTIONS[0]));
    }
    if (Number(launch.vendor_id) > 0) {
      setActiveSection("vendors");
      setPendingVendorId(Number(launch.vendor_id));
    }
    onConsumeLaunch?.();
  }, [launch, onConsumeLaunch]);

  useEffect(() => {
    if (!pendingVendorId) return;
    const match = (bootstrap.vendors || []).find((v) => Number(v.id) === Number(pendingVendorId));
    if (!match) return;
    editVendor(match);
    setPendingVendorId(null);
  }, [pendingVendorId, bootstrap.vendors]);

  function editDistributor(item) {
    setDistributorForm({
      id: item.id,
      distributor_code: item.distributor_code || "",
      company_name: item.company_name || "",
      country_id: item.country_id ? String(item.country_id) : "",
      contact_email: item.contact_email || "",
      contact_phone: item.contact_phone || "",
      is_active: item.is_active !== false,
    });
    setActiveSection("distributors");
    setError("");
    setNotice("");
  }

  function editVendor(item) {
    if (item?.company_id) setSelectedCompanyId(String(item.company_id));
    setVendorForm({
      id: item.id,
      company_id: item.company_id ? String(item.company_id) : "",
      vendor_code: item.vendor_code || "",
      company_name: item.company_name || "",
      country_id: item.country_id ? String(item.country_id) : "",
      gstin: item.gstin || "",
      gstin_locked: Boolean(String(item.gstin || "").trim()),
      pan_no: item.pan_no || "",
      address_line1: item.address_line1 || "",
      address_line2: item.address_line2 || "",
      address_line3: item.address_line3 || "",
      city: item.city || "",
      state: item.state || "",
      pincode: item.pincode || "",
      contact_name: item.contact_name || "",
      contact_email: item.contact_email || "",
      contact_phone: item.contact_phone || "",
      msme_registered: Boolean(item.msme_registered),
      tds_enabled: Boolean(item.tds_enabled),
      tds_exempt: Boolean(item.tds_exempt),
      tds_section_id: item.tds_section_id ? String(item.tds_section_id) : "",
      lower_deduction_rate: item.lower_deduction_rate === null || item.lower_deduction_rate === undefined ? "" : String(item.lower_deduction_rate),
      is_active: item.is_active !== false,
    });
    setActiveSection("vendors");
    setError("");
    setNotice("");
  }

  function editMaster(item) {
    const idField = selectedMaster.idField || "id";
    const next = { id: item[idField], [selectedMaster.nameField]: item[selectedMaster.nameField] || "", is_active: item.is_active !== false };
    if (selectedMaster.codeField) next[selectedMaster.codeField] = item[selectedMaster.codeField] || "";
    for (const extra of selectedMaster.extras) next[extra.key] = item[extra.key] === null || item[extra.key] === undefined ? "" : String(item[extra.key]);
    if (selectedMaster.key === "terms_master" && !next.applies_to) next.applies_to = "all";
    setMasterForm(next);
    setActiveSection("commercial");
    setError("");
    setNotice("");
  }

  async function saveDistributor() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        distributor_code: distributorForm.distributor_code,
        company_name: distributorForm.company_name,
        country_id: distributorForm.country_id ? Number(distributorForm.country_id) : null,
        contact_email: distributorForm.contact_email,
        contact_phone: distributorForm.contact_phone,
        is_active: distributorForm.is_active,
      };
      if (distributorForm.id) {
        await apiFetch(`/admin-masters/distributors/${distributorForm.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice("Distributor updated.");
      } else {
        await apiFetch("/admin-masters/distributors", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Distributor created.");
      }
      await loadAll();
      setDistributorForm(emptyDistributor());
    } catch (e) {
      setError(e?.data?.error || "Failed to save distributor.");
    } finally {
      setSaving(false);
    }
  }

  async function saveVendor() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (!selectedCompanyId) throw new Error("NO_COMPANY_SELECTED");
      const payload = {
        company_id: Number(selectedCompanyId),
        vendor_code: vendorForm.vendor_code,
        company_name: vendorForm.company_name,
        country_id: vendorForm.country_id ? Number(vendorForm.country_id) : null,
        gstin: vendorForm.gstin,
        pan_no: vendorForm.pan_no,
        address_line1: vendorForm.address_line1,
        address_line2: vendorForm.address_line2,
        address_line3: vendorForm.address_line3,
        city: vendorForm.city,
        state: vendorForm.state,
        pincode: vendorForm.pincode,
        contact_name: vendorForm.contact_name,
        contact_email: vendorForm.contact_email,
        contact_phone: vendorForm.contact_phone,
        msme_registered: vendorForm.msme_registered,
        tds_enabled: vendorForm.tds_enabled,
        tds_exempt: vendorForm.tds_exempt,
        tds_section_id: vendorForm.tds_section_id ? Number(vendorForm.tds_section_id) : null,
        lower_deduction_rate: vendorForm.lower_deduction_rate,
        is_active: vendorForm.is_active,
      };
      if (vendorForm.id) {
        await apiFetch(`/admin-masters/vendors/${vendorForm.id}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice("Vendor updated.");
      } else {
        await apiFetch("/admin-masters/vendors", { method: "POST", body: JSON.stringify(payload) });
        setNotice("Vendor created.");
      }
      await loadAll();
      setVendorForm(emptyVendor());
    } catch (e) {
      setError(e?.data?.error || (e?.message === "NO_COMPANY_SELECTED" ? "Select a company first." : "Failed to save vendor."));
    } finally {
      setSaving(false);
    }
  }

  async function saveCompanyProfile() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (!selectedCompanyRecord?.company_id) throw new Error("NO_COMPANY_SELECTED");
      await apiFetch("/admin-masters/company-profile", {
        method: "PUT",
        body: JSON.stringify({ company_id: Number(selectedCompanyRecord.company_id), ...companyProfileForm }),
      });
      await loadAll();
      setNotice(`${selectedCompanyRecord.display_name || selectedCompanyRecord.company_code || "Company"} profile updated.`);
    } catch (e) {
      setError(e?.data?.error || (e?.message === "NO_COMPANY_SELECTED" ? "Select a company first." : "Failed to save company profile."));
    } finally {
      setSaving(false);
    }
  }

  async function uploadCompanyAsset(assetKey, file) {
    const fd = new FormData();
    fd.append("file", file);
    if (selectedCompanyRecord?.company_id) fd.append("company_id", String(selectedCompanyRecord.company_id));
    await apiFetchForm(`/admin-masters/company-profile/${assetKey}`, fd, { method: "POST" });
    await loadAll();
    if (assetKey === "logo") setLogoFileKey((x) => x + 1);
    if (assetKey === "signature") setSignatureFileKey((x) => x + 1);
    setNotice(`${selectedCompanyRecord?.display_name || selectedCompanyRecord?.company_code || "Company"} ${assetKey} updated.`);
  }

  async function removeCompanyAsset(assetKey) {
    if (!selectedCompanyRecord?.company_id) throw new Error("NO_COMPANY_SELECTED");
    await apiFetch(`/admin-masters/company-profile/${assetKey}?company_id=${encodeURIComponent(String(selectedCompanyRecord.company_id))}`, { method: "DELETE" });
    await loadAll();
    setNotice(`${selectedCompanyRecord.display_name || selectedCompanyRecord.company_code || "Company"} ${assetKey} removed.`);
  }

  function connectDistributorMailbox() {
    if (!distributorForm.id) return;
    const redirectTo = "/?page=admin_masters";
    window.location.href = `/mail-accounts/google/connect/distributor/${distributorForm.id}?redirectTo=${encodeURIComponent(redirectTo)}`;
  }

  async function disconnectDistributorMailbox() {
    if (!distributorForm.id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/mail-accounts/distributor/${distributorForm.id}/disconnect`, { method: "POST", body: JSON.stringify({}) });
      await loadAll();
      setNotice("Distributor shared mailbox disconnected.");
      setDistributorForm(emptyDistributor());
    } catch (e) {
      setError(e?.data?.error || "Failed to disconnect distributor mailbox.");
    } finally {
      setSaving(false);
    }
  }

  async function saveMaster() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (selectedMaster.key === "terms_master" && !String(masterForm.default_description || "").trim()) {
        throw new Error("TERM_DESCRIPTION_REQUIRED");
      }
      if (selectedMaster.key === "exchange_rates") {
        if (!inrCurrency?.id) {
          throw new Error("EXCHANGE_RATE_BASE_MISSING");
        }
        if (!masterForm.to_currency_id || !masterForm.rate_date) {
          throw new Error("EXCHANGE_RATE_FIELDS_REQUIRED");
        }
        if (String(inrCurrency.id) === String(masterForm.to_currency_id)) {
          throw new Error("EXCHANGE_RATE_SAME_CURRENCY");
        }
      }
      const payload = { [selectedMaster.nameField]: masterForm[selectedMaster.nameField], is_active: masterForm.is_active };
      if (selectedMaster.codeField) payload[selectedMaster.codeField] = masterForm[selectedMaster.codeField];
      for (const extra of selectedMaster.extras) payload[extra.key] = masterForm[extra.key];
      if (selectedMaster.key === "exchange_rates") payload.from_currency_id = String(inrCurrency.id);
      if (masterForm.id) {
        await apiFetch(`/admin-masters/${selectedMaster.key}/${encodeURIComponent(String(masterForm.id))}`, { method: "PUT", body: JSON.stringify(payload) });
        setNotice(`${selectedMaster.label} updated.`);
      } else {
        await apiFetch(`/admin-masters/${selectedMaster.key}`, { method: "POST", body: JSON.stringify(payload) });
        setNotice(`${selectedMaster.label} created.`);
      }
      await loadAll();
      setMasterForm(emptyMaster(selectedMaster));
    } catch (e) {
      setError(
        e?.message === "TERM_DESCRIPTION_REQUIRED"
          ? "Default description is required for terms."
          : e?.message === "EXCHANGE_RATE_BASE_MISSING"
            ? "INR currency master is required before exchange rates can be maintained."
          : e?.message === "EXCHANGE_RATE_FIELDS_REQUIRED"
            ? "Quote currency and rate date are required."
            : e?.message === "EXCHANGE_RATE_SAME_CURRENCY"
              ? "Quote currency must be different from base currency."
              : e?.data?.error || "Failed to save master."
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteMaster(confirmPhrase) {
    if (!masterForm.id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/admin-masters/${selectedMaster.key}/${encodeURIComponent(String(masterForm.id))}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm_phrase: confirmPhrase }),
      });
      await loadAll();
      setMasterForm(emptyMaster(selectedMaster));
      setNotice(`${selectedMaster.label} deleted.`);
      setDeleteConfirmOpen(false);
    } catch (e) {
      setError(e?.data?.error === "MASTER_IN_USE" ? `${selectedMaster.label} is in use and cannot be deleted.` : e?.data?.error || "Failed to delete master.");
    } finally {
      setSaving(false);
    }
  }

  async function loadExpenseLimits() {
    if (!selectedCompanyId) return;
    try {
      const data = await apiFetch(`/admin-masters/expense-policy-limits?company_id=${encodeURIComponent(selectedCompanyId)}`);
      setExpenseLimits(data.limits || []);
    } catch (e) {
      setExpenseLimits([]);
    }
  }

  async function saveExpenseLimit() {
    if (!selectedCompanyId || !expenseForm.category.trim()) return;
    setExpenseBusy(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/admin-masters/expense-policy-limits`, {
        method: "PUT",
        body: JSON.stringify({
          company_id: Number(selectedCompanyId),
          category: expenseForm.category.trim(),
          daily_cap: expenseForm.daily_cap === "" ? null : Number(expenseForm.daily_cap),
          claim_cap: expenseForm.claim_cap === "" ? null : Number(expenseForm.claim_cap),
          is_active: expenseForm.is_active !== false,
        }),
      });
      setNotice("Expense policy limit saved.");
      setExpenseForm({ category: "", daily_cap: "", claim_cap: "", is_active: true });
      await loadExpenseLimits();
    } catch (e) {
      setError(e?.data?.error || "Failed to save expense policy.");
    } finally {
      setExpenseBusy(false);
    }
  }

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>;

  const stats = [
    { label: "Companies", value: bootstrap.company_profiles.length, note: "AI and AT seller identities", accent: "#1f5eff" },
    { label: "Distributors", value: bootstrap.distributors.length, note: "channel partner records", accent: "#14804a" },
    { label: "Vendors", value: bootstrap.vendors.length, note: "procurement-ready vendors", accent: "#d97706" },
    { label: "Commercial masters", value: MASTER_OPTIONS.length, note: "lookup families maintained here", accent: "#8b5cf6" },
  ];

  const sectionOptions = [
    {
      key: "company",
      label: "Company Profile",
      note: nextIncompleteCompany
        ? `${companyCompletionRows.filter((item) => item.percent === 100).length}/${companyCompletionRows.length || 0} ready. ${nextIncompleteCompany.company_code} still needs completion.`
        : "Invoice identity, statutory details, assets, and bank data.",
    },
    {
      key: "distributors",
      label: "Distributors",
      note:
        distributorsMissingMailbox.length || distributorsMissingContact.length
          ? `${distributorsMissingMailbox.length} mailbox gaps • ${distributorsMissingContact.length} contact gaps`
          : "Channel partner records and shared mailbox setup.",
    },
    {
      key: "vendors",
      label: "Vendors",
      note:
        vendorComplianceAlerts.length || inactiveVendors.length
          ? `${vendorComplianceAlerts.length} compliance gaps • ${inactiveVendors.length} inactive`
          : "Vendor compliance, TDS, contact, and active status.",
    },
    {
      key: "commercial",
      label: "Commercial Masters",
      note: missingCommercialMasters.length
        ? `${missingCommercialMasters.length} master families still need baseline setup`
        : "Countries, currencies, terms, codes, and designations. Roles/groups → Org & Access.",
    },
    {
      key: "expense_policy",
      label: "Expense Policy",
      note: "Daily and claim caps by expense category for My Duty claims.",
    },
    {
      key: "gsp",
      label: "GSP / E-Way",
      note: "MasterGST sandbox or production settings (credentials stay in env).",
    },
  ];

  const activeDistributor = bootstrap.distributors.find((item) => String(item.id) === String(distributorForm.id)) || null;

  function renderCompanyProfile() {
    if (!selectedCompanyRecord) {
      return <SurfaceCard title="Company profile" subtitle="No active companies are available for UI maintenance yet." />;
    }

    const currentProfile = selectedCompanyRecord.profile || emptyCompanyProfile();

    return (
      <div style={{ display: "grid", gap: 16 }}>
        <SurfaceCard
          title="Company selector"
          subtitle="Maintain both seller entities from this UI. Switch between AI and AT here instead of editing any company row directly in the database."
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {bootstrap.company_profiles.map((item) => {
              const active = String(item.company_id) === String(selectedCompanyRecord.company_id);
              return (
                <button
                  key={item.company_id}
                  type="button"
                  onClick={() => setSelectedCompanyId(String(item.company_id))}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    borderRadius: 18,
                    padding: 14,
                    border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
                    background: active ? "linear-gradient(180deg, #eef4ff 0%, #f8fbff 100%)" : "#fff",
                    boxShadow: active ? "0 12px 28px rgba(31, 94, 255, 0.12)" : "0 10px 22px rgba(15, 23, 42, 0.05)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>{item.display_name || item.legal_name || "Company"}</strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.company_code || "—"}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>{item.profile?.gstin || "GST not set yet"}</div>
                  <div style={{ fontSize: 12, opacity: 0.68 }}>
                    Last updated: {item.profile?.updated_at ? new Date(item.profile.updated_at).toLocaleString() : "Not saved yet"}
                  </div>
                </button>
              );
            })}
          </div>
        </SurfaceCard>

        <div style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: 16 }}>
        <SurfaceCard
          title={`${selectedCompanyRecord.company_code || "Company"} profile`}
          subtitle={`${selectedCompanyRecord.display_name || selectedCompanyRecord.legal_name || "Selected company"} details are maintained from this screen for quote, invoice, and document output.`}
          actions={<div style={{ fontSize: 12, opacity: 0.68 }}>Last updated: {currentProfile?.updated_at ? new Date(currentProfile.updated_at).toLocaleString() : "Not saved yet"}</div>}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <Field label="Company Name">
                <input value={companyProfileForm.company_name} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, company_name: e.target.value }))} />
              </Field>
              <Field label="Website">
                <input value={companyProfileForm.website} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, website: e.target.value }))} placeholder="www.absstem.com" />
              </Field>
              <Field label="Address Line 1">
                <input value={companyProfileForm.address_line1} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, address_line1: e.target.value }))} />
              </Field>
              <Field label="Address Line 2">
                <input value={companyProfileForm.address_line2} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, address_line2: e.target.value }))} />
              </Field>
              <Field label="Address Line 3">
                <input value={companyProfileForm.address_line3} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, address_line3: e.target.value }))} />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
                <Field label="City">
                  <input value={companyProfileForm.city} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, city: e.target.value }))} />
                </Field>
                <Field label="State">
                  <input value={companyProfileForm.state} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, state: e.target.value }))} />
                </Field>
                <Field label="State Code">
                  <input value={companyProfileForm.state_code} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, state_code: e.target.value }))} />
                </Field>
                <Field label="Pincode">
                  <input value={companyProfileForm.pincode} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, pincode: e.target.value }))} />
                </Field>
              </div>
              <Field label="Country">
                <input value={companyProfileForm.country} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, country: e.target.value }))} />
              </Field>
            </div>
            <div>
              <Field label="GSTIN">
                <input value={companyProfileForm.gstin} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, gstin: e.target.value }))} />
              </Field>
              <Field label="PAN">
                <input value={companyProfileForm.pan} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, pan: e.target.value }))} />
              </Field>
              <Field label="Contact Name">
                <input value={companyProfileForm.contact_name} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, contact_name: e.target.value }))} />
              </Field>
              <Field label="Contact Email">
                <input value={companyProfileForm.contact_email} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, contact_email: e.target.value }))} />
              </Field>
              <Field label="Contact Phone">
                <input value={companyProfileForm.contact_phone} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, contact_phone: e.target.value }))} />
              </Field>
              <Field label="Invoice Declaration">
                <textarea rows={7} style={{ width: "100%" }} value={companyProfileForm.invoice_declaration} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, invoice_declaration: e.target.value }))} />
              </Field>
            </div>
          </div>
        </SurfaceCard>

        {selectedCompanyRecord?.company_id && canViewDrive(me, "statutory") ? (
          <div style={{ marginTop: 16 }}>
            <DriveFilesPanel
              me={me}
              category="statutory"
              companyId={selectedCompanyRecord.company_id}
              title="Statutory documents"
              subtitle={`GST RC, cancelled cheques, PAN, and related filings for ${selectedCompanyRecord.company_code || "this company"}. Served only through the ERP Drive proxy.`}
              accept=".pdf,.png,.jpg,.jpeg,.webp"
            />
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 16 }}>
          <SurfaceCard title="Brand assets" subtitle={`Logo and signature files for ${selectedCompanyRecord.company_code || "this company"} are controlled from here.`}>
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff" }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Brand Logo</div>
                <Field label="Current">
                  <div style={{ fontSize: 13, opacity: 0.84 }}>{currentProfile?.logo_file_name || "Not set"}</div>
                </Field>
                <Field label="Upload / Replace">
                  <input
                    key={logoFileKey}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
                    onChange={(e) => {
                      const file = e.target.files && e.target.files[0];
                      if (file) uploadCompanyAsset("logo", file).catch((err) => setError(err?.data?.error || "Upload failed."));
                    }}
                  />
                </Field>
                <button type="button" onClick={() => removeCompanyAsset("logo").catch((err) => setError(err?.data?.error || "Remove failed."))}>
                  Remove Logo
                </button>
              </div>
              <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff" }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Authorised Signature</div>
                <Field label="Current">
                  <div style={{ fontSize: 13, opacity: 0.84 }}>{currentProfile?.signature_file_name || "Not set"}</div>
                </Field>
                <Field label="Upload / Replace">
                  <input
                    key={signatureFileKey}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg"
                    onChange={(e) => {
                      const file = e.target.files && e.target.files[0];
                      if (file) uploadCompanyAsset("signature", file).catch((err) => setError(err?.data?.error || "Upload failed."));
                    }}
                  />
                </Field>
                <button type="button" onClick={() => removeCompanyAsset("signature").catch((err) => setError(err?.data?.error || "Remove failed."))}>
                  Remove Signature
                </button>
              </div>
            </div>
          </SurfaceCard>

          <SurfaceCard title="Bank details" subtitle="These details stay bundled with the company identity for invoice and accounts-facing references.">
            <Field label="Bank Name">
              <input value={companyProfileForm.bank_name} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, bank_name: e.target.value }))} />
            </Field>
            <Field label="Bank Branch">
              <input value={companyProfileForm.bank_branch} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, bank_branch: e.target.value }))} />
            </Field>
            <Field label="Account Name">
              <input value={companyProfileForm.account_name} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, account_name: e.target.value }))} />
            </Field>
            <Field label="Account No">
              <input value={companyProfileForm.account_no} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, account_no: e.target.value }))} />
            </Field>
            <Field label="IFSC">
              <input value={companyProfileForm.ifsc} onChange={(e) => setCompanyProfileForm((prev) => ({ ...prev, ifsc: e.target.value }))} />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              <button type="button" onClick={() => setCompanyProfileForm({ ...emptyCompanyProfile(), ...currentProfile })}>
                Reset
              </button>
              <button type="button" onClick={saveCompanyProfile} disabled={saving}>
                Save {selectedCompanyRecord.company_code || "Company"} Profile
              </button>
            </div>
          </SurfaceCard>
        </div>
      </div>
      </div>
    );
  }

  function renderDistributors() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 16 }}>
        <SurfaceCard title="Distributor editor" subtitle="Use this focused panel to create or update channel partner records and shared mailbox linkage.">
          <Field label="Distributor Code">
            <input value={distributorForm.distributor_code} onChange={(e) => setDistributorForm((prev) => ({ ...prev, distributor_code: e.target.value }))} />
          </Field>
          <Field label="Company Name">
            <input value={distributorForm.company_name} onChange={(e) => setDistributorForm((prev) => ({ ...prev, company_name: e.target.value }))} />
          </Field>
          <Field label="Country">
            <select value={distributorForm.country_id} onChange={(e) => setDistributorForm((prev) => ({ ...prev, country_id: e.target.value }))}>
              <option value="">-- None --</option>
              {bootstrap.countries.map((country) => (
                <option key={country.id} value={String(country.id)}>
                  {country.country_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contact Email">
            <input value={distributorForm.contact_email} onChange={(e) => setDistributorForm((prev) => ({ ...prev, contact_email: e.target.value }))} />
          </Field>
          <Field label="Contact Phone">
            <input value={distributorForm.contact_phone} onChange={(e) => setDistributorForm((prev) => ({ ...prev, contact_phone: e.target.value }))} />
          </Field>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input type="checkbox" checked={distributorForm.is_active} onChange={(e) => setDistributorForm((prev) => ({ ...prev, is_active: e.target.checked }))} />
            Active distributor
          </label>
          {distributorForm.id ? (
            <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff", marginBottom: 14 }}>
              <div style={{ fontWeight: 700 }}>Shared Mailbox</div>
              <div style={{ fontSize: 12, opacity: 0.76, marginTop: 6 }}>
                {activeDistributor?.shared_mail_connected ? activeDistributor?.shared_mailbox_email || "Connected" : "Not connected"}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <button type="button" onClick={connectDistributorMailbox} disabled={saving}>
                  Connect Google Mail
                </button>
                {activeDistributor?.shared_mail_connected ? (
                  <button type="button" onClick={disconnectDistributorMailbox} disabled={saving}>
                    Disconnect
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={() => setDistributorForm(emptyDistributor())}>
              Reset
            </button>
            <button type="button" onClick={saveDistributor} disabled={saving}>
              {distributorForm.id ? "Update Distributor" : "Create Distributor"}
            </button>
          </div>
        </SurfaceCard>

        <SurfaceCard title="Distributor directory" subtitle="Click any card to pull it into the editor without scanning a wide table.">
          <div style={{ display: "grid", gap: 10, maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }}>
            {bootstrap.distributors.length ? (
              bootstrap.distributors.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => editDistributor(item)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e3e8f2",
                    borderRadius: 16,
                    padding: 14,
                    background: String(item.id) === String(distributorForm.id) ? "#eef4ff" : "#fbfcff",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>{item.company_name || "Unnamed distributor"}</strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.distributor_code || "—"}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>{item.contact_email || "No email"} • {item.contact_phone || "No phone"}</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    Mailbox: {item.shared_mail_connected ? item.shared_mailbox_email || "Connected" : "Not connected"} • Status: {item.is_active ? "Active" : "Inactive"}
                  </div>
                </button>
              ))
            ) : (
              <div style={{ padding: 12, opacity: 0.72 }}>No distributors found.</div>
            )}
          </div>
        </SurfaceCard>
      </div>
    );
  }

  function renderVendors() {
    const vendorRows = selectedCompanyId
      ? bootstrap.vendors.filter((v) => String(v.company_id || "") === String(selectedCompanyId))
      : [];
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <SurfaceCard title="Vendor editor" subtitle="Keep GST, TDS, address, and contact details together in one procurement-ready form.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <Field label="Vendor Code">
                <input
                  value={vendorForm.vendor_code}
                  onChange={(e) => setVendorForm((prev) => ({ ...prev, vendor_code: e.target.value }))}
                  readOnly={Boolean(vendorForm.id)}
                  disabled={Boolean(vendorForm.id)}
                />
                {vendorForm.id ? <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Locked after create</div> : null}
              </Field>
              <Field label="Company Name">
                <input value={vendorForm.company_name} onChange={(e) => setVendorForm((prev) => ({ ...prev, company_name: e.target.value }))} />
              </Field>
              <Field label="Country">
                <select value={vendorForm.country_id} onChange={(e) => setVendorForm((prev) => ({ ...prev, country_id: e.target.value }))}>
                  <option value="">-- None --</option>
                  {bootstrap.countries.map((country) => (
                    <option key={country.id} value={String(country.id)}>
                      {country.country_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="GSTIN">
                <input
                  value={vendorForm.gstin}
                  onChange={(e) => setVendorForm((prev) => ({ ...prev, gstin: e.target.value }))}
                  readOnly={Boolean(vendorForm.id && vendorForm.gstin_locked)}
                  disabled={Boolean(vendorForm.id && vendorForm.gstin_locked)}
                />
                {vendorForm.id && vendorForm.gstin_locked ? <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Locked after create</div> : null}
              </Field>
              <Field label="PAN No">
                <input value={vendorForm.pan_no} onChange={(e) => setVendorForm((prev) => ({ ...prev, pan_no: e.target.value }))} />
              </Field>
              <Field label="Address Line 1">
                <input value={vendorForm.address_line1} onChange={(e) => setVendorForm((prev) => ({ ...prev, address_line1: e.target.value }))} />
              </Field>
              <Field label="Address Line 2">
                <input value={vendorForm.address_line2} onChange={(e) => setVendorForm((prev) => ({ ...prev, address_line2: e.target.value }))} />
              </Field>
              <Field label="Address Line 3">
                <input value={vendorForm.address_line3} onChange={(e) => setVendorForm((prev) => ({ ...prev, address_line3: e.target.value }))} />
              </Field>
            </div>
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
                <Field label="City">
                  <input value={vendorForm.city} onChange={(e) => setVendorForm((prev) => ({ ...prev, city: e.target.value }))} />
                </Field>
                <Field label="State">
                  <input value={vendorForm.state} onChange={(e) => setVendorForm((prev) => ({ ...prev, state: e.target.value }))} />
                </Field>
                <Field label="Pincode">
                  <input value={vendorForm.pincode} onChange={(e) => setVendorForm((prev) => ({ ...prev, pincode: e.target.value }))} />
                </Field>
              </div>
              <Field label="Contact Name">
                <input value={vendorForm.contact_name} onChange={(e) => setVendorForm((prev) => ({ ...prev, contact_name: e.target.value }))} />
              </Field>
              <Field label="Contact Email">
                <input value={vendorForm.contact_email} onChange={(e) => setVendorForm((prev) => ({ ...prev, contact_email: e.target.value }))} />
              </Field>
              <Field label="Contact Phone">
                <input value={vendorForm.contact_phone} onChange={(e) => setVendorForm((prev) => ({ ...prev, contact_phone: e.target.value }))} />
              </Field>
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input type="checkbox" checked={vendorForm.msme_registered} onChange={(e) => setVendorForm((prev) => ({ ...prev, msme_registered: e.target.checked }))} />
                MSME Registered
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input type="checkbox" checked={vendorForm.tds_enabled} onChange={(e) => setVendorForm((prev) => ({ ...prev, tds_enabled: e.target.checked }))} />
                TDS Enabled
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input type="checkbox" checked={vendorForm.tds_exempt} onChange={(e) => setVendorForm((prev) => ({ ...prev, tds_exempt: e.target.checked }))} />
                TDS Exempt
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="TDS Section">
                  <select value={vendorForm.tds_section_id} onChange={(e) => setVendorForm((prev) => ({ ...prev, tds_section_id: e.target.value }))}>
                    <option value="">-- None --</option>
                    {bootstrap.tds_sections.map((section) => (
                      <option key={section.id} value={String(section.id)}>
                        {section.section_code} - {section.section_name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Lower Deduction %">
                  <input value={vendorForm.lower_deduction_rate} onChange={(e) => setVendorForm((prev) => ({ ...prev, lower_deduction_rate: e.target.value }))} />
                </Field>
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input type="checkbox" checked={vendorForm.is_active} onChange={(e) => setVendorForm((prev) => ({ ...prev, is_active: e.target.checked }))} />
                Active vendor
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button type="button" onClick={() => setVendorForm(emptyVendor())}>
                  Reset
                </button>
                <button type="button" onClick={saveVendor} disabled={saving}>
                  {vendorForm.id ? "Update Vendor" : "Create Vendor"}
                </button>
              </div>
            </div>
          </div>
        </SurfaceCard>

        <SurfaceCard title="Vendor directory" subtitle="Each vendor opens as a card so scanning GST, TDS, and contact setup is easier.">
          <div style={{ display: "grid", gap: 10, maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }}>
            {vendorRows.length ? (
              vendorRows.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => editVendor(item)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e3e8f2",
                    borderRadius: 16,
                    padding: 14,
                    background: String(item.id) === String(vendorForm.id) ? "#eef4ff" : "#fbfcff",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <strong>{item.company_name || "Unnamed vendor"}</strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.vendor_code || "—"}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>GSTIN: {item.gstin || "—"} • PAN: {item.pan_no || "—"}</div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>
                    TDS: {item.tds_enabled ? item.tds_section_code || "Enabled" : "No"} • Contact: {item.contact_name || "—"} • Status: {item.is_active ? "Active" : "Inactive"}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{item.contact_email || "No email"} • {item.contact_phone || "No phone"}</div>
                </button>
              ))
            ) : (
              <div style={{ padding: 12, opacity: 0.72 }}>No vendors found.</div>
            )}
          </div>
        </SurfaceCard>
      </div>
    );
  }

  function renderCommercialMasters() {
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <SurfaceCard
          title="Commercial baseline pins"
          subtitle="Empty families block quotes and orders. Ready families can still be opened for cleanup."
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            {commercialMasterPins.map((item) => {
              const empty = item.count === 0;
              const active = selectedMasterKey === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSelectedMasterKey(item.key)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    borderRadius: 14,
                    padding: "12px 14px",
                    border: active ? "1px solid #96b5ff" : empty ? "1px solid #f2dfb0" : "1px solid #d6f4df",
                    background: active ? "#eef4ff" : empty ? "#fff9ec" : "#f2fff6",
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <strong style={{ fontSize: 13, color: empty ? "#8b5a00" : "#0a7a35" }}>{item.label}</strong>
                  <span style={{ fontSize: 12, opacity: 0.78 }}>{empty ? "Empty — needs baseline" : `${item.count} ready`}</span>
                </button>
              );
            })}
          </div>
        </SurfaceCard>
        <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.1fr", gap: 16 }}>
          <SurfaceCard title="Commercial master editor" subtitle="Switch between lookup, role, and department families without leaving the admin desk.">
            <Field label="Master Type">
              <select value={selectedMasterKey} onChange={(e) => setSelectedMasterKey(e.target.value)}>
                {MASTER_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            {selectedMaster.key === "exchange_rates" ? (
              <Field label="Base Currency">
                <input value={inrCurrency ? `${inrCurrency.currency_code} - ${inrCurrency.currency_name}` : "INR currency not found"} disabled />
              </Field>
            ) : null}
            {selectedMaster.codeField ? (
              <Field label={selectedMaster.codeLabel}>
                <input value={masterForm[selectedMaster.codeField]} onChange={(e) => setMasterForm((prev) => ({ ...prev, [selectedMaster.codeField]: e.target.value }))} />
              </Field>
            ) : null}
            <Field label={selectedMaster.nameLabel}>
              <input
                type={selectedMaster.nameInputType || "text"}
                step={selectedMaster.nameStep}
                value={masterForm[selectedMaster.nameField]}
                onChange={(e) => setMasterForm((prev) => ({ ...prev, [selectedMaster.nameField]: e.target.value }))}
              />
            </Field>
            {selectedMasterExtras.map((extra) => (
              <Field key={extra.key} label={extra.label}>
                {extra.type === "select" ? (
                  <select value={masterForm[extra.key]} onChange={(e) => setMasterForm((prev) => ({ ...prev, [extra.key]: e.target.value }))}>
                    {(extra.options || []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : extra.type === "textarea" ? (
                  <textarea rows={5} style={{ width: "100%" }} value={masterForm[extra.key]} onChange={(e) => setMasterForm((prev) => ({ ...prev, [extra.key]: e.target.value }))} />
                ) : (
                  <input type={extra.type || "text"} step={extra.step} value={masterForm[extra.key]} onChange={(e) => setMasterForm((prev) => ({ ...prev, [extra.key]: e.target.value }))} />
                )}
              </Field>
            ))}
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
              <input type="checkbox" checked={masterForm.is_active} onChange={(e) => setMasterForm((prev) => ({ ...prev, is_active: e.target.checked }))} />
              Active
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" onClick={() => setMasterForm(emptyMaster(selectedMaster))}>
                Reset
              </button>
              {masterForm.id ? (
                <button type="button" onClick={() => setDeleteConfirmOpen(true)} disabled={saving}>
                  Delete {selectedMaster.label}
                </button>
              ) : null}
              <button type="button" onClick={saveMaster} disabled={saving}>
                {masterForm.id ? `Update ${selectedMaster.label}` : `Create ${selectedMaster.label}`}
              </button>
            </div>
          </SurfaceCard>

          <SurfaceCard
            title={`${selectedMaster.label} directory`}
            subtitle="Search and pick a master card instead of working through a full-width matrix."
            actions={
              <input
                value={masterQuery}
                onChange={(e) => setMasterQuery(e.target.value)}
                placeholder={`Search ${selectedMaster.label.toLowerCase()}`}
                style={{ minWidth: 220 }}
              />
            }
          >
            <div style={{ display: "grid", gap: 10, maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }}>
              {filteredMasterItems.length ? (
                filteredMasterItems.map((item) => (
                  <button
                    key={String(item[selectedMaster.idField || "id"])}
                    type="button"
                    onClick={() => editMaster(item)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      border: "1px solid #e3e8f2",
                      borderRadius: 16,
                      padding: 14,
                      background: String(item[selectedMaster.idField || "id"]) === String(masterForm.id) ? "#eef4ff" : "#fbfcff",
                      display: "grid",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong>
                        {selectedMaster.key === "exchange_rates"
                          ? `${item.from_currency_code || "?"} -> ${item.to_currency_code || "?"}`
                          : item[selectedMaster.nameField] || "Unnamed record"}
                      </strong>
                      {selectedMaster.codeField ? <span style={{ fontSize: 12, opacity: 0.72 }}>{item[selectedMaster.codeField] || "—"}</span> : null}
                    </div>
                    {selectedMasterExtras.length ? (
                      <div style={{ fontSize: 12, opacity: 0.74 }}>
                        {selectedMasterExtras
                          .map((extra) => {
                            if (extra.key === "country_id") return `${extra.label}: ${item.country_name || item.country_code || item[extra.key] || "—"}`;
                            if (extra.key === "state_id") return `${extra.label}: ${item.state_name || item.state_code || item[extra.key] || "—"}`;
                            if (extra.key === "to_currency_id") return `${extra.label}: ${item.to_currency_code || item.to_currency_name || item[extra.key] || "—"}`;
                            return `${extra.label}: ${item[extra.key] ?? "—"}`;
                          })
                          .join(" • ")}
                      </div>
                    ) : null}
                    {selectedMaster.key === "exchange_rates" ? (
                      <div style={{ fontSize: 12, opacity: 0.78 }}>
                        Base: {item.from_currency_code || "INR"} • Exchange Rate: {item.rate_value ?? "—"} • Date: {item.rate_date || "—"}
                      </div>
                    ) : null}
                    <div style={{ fontSize: 12, opacity: 0.72 }}>Status: {item.is_active ? "Active" : "Inactive"}</div>
                  </button>
                ))
              ) : (
                <div style={{ padding: 12, opacity: 0.72 }}>No matching {selectedMaster.label.toLowerCase()} records found.</div>
              )}
            </div>
          </SurfaceCard>
        </div>

      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1320, width: "100%", display: "grid", gap: 16 }}>
      <section
        style={{
          border: "1px solid #dfe5ef",
          borderRadius: 24,
          padding: 22,
          background: "linear-gradient(135deg, #f7fbff 0%, #ffffff 58%, #f9fbff 100%)",
          boxShadow: "0 18px 42px rgba(25, 37, 61, 0.08)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Master governance desk</div>
            <h2 style={{ margin: "8px 0 0", fontSize: 32, lineHeight: 1.15 }}>Admin Masters turned into a cleaner setup control surface.</h2>
            <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.76, maxWidth: 760, lineHeight: 1.7 }}>
              Start with the records blocking setup readiness, then jump directly into the existing company, distributor, vendor, or commercial editor without scanning the full admin shell.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {headerChips.map((chip) => (
                <HeaderChip key={chip.label} {...chip} />
              ))}
            </div>
          </div>
          <button type="button" onClick={() => loadAll().catch(() => {})} disabled={loading}>
            Refresh
          </button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
        {stats.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 16, alignItems: "start" }}>
        <SurfaceCard title="Fix now" subtitle="Jump straight to the setup lane most likely to block operational admins next.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {focusActions.map((item) => (
              <FocusActionCard key={item.key} {...item} />
            ))}
          </div>
        </SurfaceCard>

        <SurfaceCard title="Review rail" subtitle="Use this to scan setup risk before opening any editor.">
          <div style={{ display: "grid", gap: 10 }}>
            {nextIncompleteCompany ? (
              <div style={{ border: "1px solid #f2dfb0", background: "#fff9ec", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#8b5a00", fontSize: 13 }}>Company setup gap</strong>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                  {nextIncompleteCompany.company_code} still misses {nextIncompleteCompany.missingDetails.slice(0, 4).join(", ")}
                  {nextIncompleteCompany.missingDetails.length > 4 ? ", and more" : ""}.
                </div>
              </div>
            ) : null}
            {distributorsMissingMailbox.length ? (
              <div style={{ border: "1px solid #ffd8d8", background: "#fff3f3", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#b00020", fontSize: 13 }}>Distributor mailbox pending</strong>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                  {distributorsMissingMailbox.length} distributor records still do not have shared mailbox connectivity.
                </div>
              </div>
            ) : null}
            {vendorComplianceAlerts.length ? (
              <div style={{ border: "1px solid #d9e6ff", background: "#eef4ff", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#234a8f", fontSize: 13 }}>Vendor compliance review</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>
                  {vendorComplianceAlerts.length} vendors are missing GST, contact email, or TDS section coverage.
                </div>
              </div>
            ) : null}
            {missingCommercialMasters.length ? (
              <div style={{ border: "1px solid #e6ddff", background: "#f6f2ff", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#7c3aed", fontSize: 13 }}>Commercial master baseline</strong>
                <div style={{ fontSize: 12, opacity: 0.82, marginTop: 4 }}>
                  Empty: {missingCommercialMasters.map((item) => item.label).join(", ")}.
                  {readyCommercialMasters.length ? ` Ready: ${readyCommercialMasters.map((item) => item.label).join(", ")}.` : ""}
                </div>
              </div>
            ) : null}
            {!nextIncompleteCompany && !distributorsMissingMailbox.length && !vendorComplianceAlerts.length && !missingCommercialMasters.length ? (
              <div style={{ border: "1px solid #d6f4df", background: "#f2fff6", borderRadius: 14, padding: 12 }}>
                <strong style={{ color: "#0a7a35", fontSize: 13 }}>Setup baseline is healthy</strong>
                <div style={{ fontSize: 12, opacity: 0.78, marginTop: 4 }}>
                  Core company, distributor, vendor, and commercial master checks are covered. This is a good point for cleanup and consistency review.
                </div>
              </div>
            ) : null}
          </div>
        </SurfaceCard>
      </section>

      <SurfaceCard
        title="Company profile completion"
        subtitle="Track each company’s baseline setup so AI and AT can be hardened independently before operators rely on inherited defaults."
        actions={<div style={{ fontSize: 12, opacity: 0.68 }}>{companyCompletionRows.filter((item) => item.percent === 100).length}/{companyCompletionRows.length || 0} company profiles fully ready</div>}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {companyCompletionRows.map((item) => (
            <CompletionBar
              key={item.company_id}
              label={`${item.company_code} — ${item.display_name}`}
              percent={item.percent}
              tone={item.tone}
              note={item.note}
              onClick={() => setSelectedCompanyId(String(item.company_id))}
            />
          ))}
        </div>
      </SurfaceCard>

      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {sectionOptions.map((section) => (
          <SectionButton key={section.key} active={activeSection === section.key} label={section.label} note={section.note} onClick={() => setActiveSection(section.key)} />
        ))}
      </section>

      {selectedCompanyRecord ? (
        <div
          style={{
            border: "1px solid #c7d7ff",
            background: "linear-gradient(90deg, #eef4ff 0%, #f8fbff 100%)",
            borderRadius: 14,
            padding: "12px 16px",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#1f5eff", fontWeight: 800 }}>Company context</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
              Editing for {selectedCompanyRecord.company_code || "—"} — {selectedCompanyRecord.display_name || selectedCompanyRecord.legal_name || "Company"}
            </div>
            <div style={{ fontSize: 12, opacity: 0.74, marginTop: 4 }}>
              {activeSection === "vendors"
                ? "Vendor list is filtered to this company where company_id is set."
                : activeSection === "company"
                  ? "Profile, logo, and signature apply only to this seller entity."
                  : "Commercial masters are shared; company profile and vendors stay entity-specific."}
            </div>
          </div>
          {selectedCompanyProgress ? (
            <span style={{ fontSize: 13, fontWeight: 700, color: selectedCompanyProgress.tone }}>
              Profile {selectedCompanyProgress.percent}%
            </span>
          ) : null}
        </div>
      ) : null}

      {activeSection === "company" ? renderCompanyProfile() : null}
      {activeSection === "distributors" ? renderDistributors() : null}
      {activeSection === "vendors" ? renderVendors() : null}
      {activeSection === "commercial" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div
            style={{
              border: "1px solid #fde68a",
              background: "#fffbeb",
              borderRadius: 12,
              padding: "10px 12px",
              fontSize: 13,
              color: "#92400e",
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span>{ORG_ACCESS_ONLY_NOTE}</span>
            {typeof onNavigate === "function" ? (
              <button type="button" onClick={() => onNavigate("users", { resetQuote: true, view: "orgchart" })}>
                Open Org & Access
              </button>
            ) : null}
          </div>
          {renderCommercialMasters()}
        </div>
      ) : null}
      {activeSection === "expense_policy" ? (
        <SurfaceCard title="Expense policy limits" subtitle="Caps used by My Duty / expense claims for the selected company.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
            <label>
              Category
              <input value={expenseForm.category} onChange={(e) => setExpenseForm((p) => ({ ...p, category: e.target.value }))} placeholder="travel / meals / …" />
            </label>
            <label>
              Daily cap
              <input type="number" value={expenseForm.daily_cap} onChange={(e) => setExpenseForm((p) => ({ ...p, daily_cap: e.target.value }))} />
            </label>
            <label>
              Claim cap
              <input type="number" value={expenseForm.claim_cap} onChange={(e) => setExpenseForm((p) => ({ ...p, claim_cap: e.target.value }))} />
            </label>
            <label style={{ display: "flex", alignItems: "end", gap: 8 }}>
              <input type="checkbox" checked={expenseForm.is_active} onChange={(e) => setExpenseForm((p) => ({ ...p, is_active: e.target.checked }))} />
              Active
            </label>
            <div style={{ display: "flex", alignItems: "end" }}>
              <button type="button" disabled={expenseBusy} onClick={saveExpenseLimit}>
                {expenseBusy ? "Saving…" : "Save limit"}
              </button>
            </div>
          </div>
          <button type="button" onClick={() => loadExpenseLimits()} style={{ marginBottom: 10 }}>
            Refresh
          </button>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#64748b" }}>
                <th style={{ padding: 6 }}>Category</th>
                <th>Daily</th>
                <th>Claim</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {expenseLimits.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ padding: 12, color: "#94a3b8" }}>
                    No limits yet for this company.
                  </td>
                </tr>
              ) : (
                expenseLimits.map((row) => (
                  <tr key={row.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                    <td style={{ padding: 6 }}>{row.category}</td>
                    <td>{row.daily_cap ?? "—"}</td>
                    <td>{row.claim_cap ?? "—"}</td>
                    <td>{row.is_active ? "Yes" : "No"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </SurfaceCard>
      ) : null}
      {activeSection === "gsp" ? <EinvoiceGspSettings companyId={selectedCompanyId} /> : null}

      <TypedConfirmModal
        open={deleteConfirmOpen}
        title={`Delete ${selectedMaster.label}`}
        message={`This hard-deletes the selected ${selectedMaster.label.toLowerCase()} if it is not in use. Type DELETE to confirm.`}
        confirmPhrase="DELETE"
        confirmLabel="Delete permanently"
        busy={saving}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={deleteMaster}
      />
    </div>
  );
}
