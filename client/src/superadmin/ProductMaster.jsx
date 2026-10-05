import { useEffect, useMemo, useRef, useState } from "react";
import { BoolStatusChip, DeskChip as MicroChip, DeskStat as StatCard, MiniMetric } from "../shared/joshUi";
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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDownloadTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("") + "_" + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

async function downloadFile(path, fallbackFileName) {
  const res = await fetch(path, {
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new Error("Download failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }

  const blob = await res.blob();
  const disposition = String(res.headers.get("content-disposition") || "");
  const fileNameMatch = disposition.match(/filename="?([^"]+)"?/i);
  const fileName = fileNameMatch?.[1] || fallbackFileName;
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(objectUrl);
}

function Field({ label, children, help }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "#42506b", marginBottom: 5 }}>
        {label}
      </div>
      {children}
      {help ? <div style={{ fontSize: 11, color: "#69758e", marginTop: 5, lineHeight: 1.5 }}>{help}</div> : null}
    </div>
  );
}

const controlStyle = {
  width: "100%",
  minHeight: 36,
  borderRadius: 8,
  border: "1px solid #b8c5da",
  padding: "0 10px",
  background: "linear-gradient(180deg, #f9fbfe 0%, #ffffff 100%)",
  color: "#152235",
  boxSizing: "border-box",
};

const textAreaStyle = {
  width: "100%",
  minHeight: 78,
  borderRadius: 8,
  border: "1px solid #b8c5da",
  padding: "9px 10px",
  background: "linear-gradient(180deg, #f9fbfe 0%, #ffffff 100%)",
  color: "#152235",
  boxSizing: "border-box",
  resize: "vertical",
};

function emptyAttribute(index = 1) {
  return { key: `new-${index}-${Date.now()}`, sort_order: index, caption: "", spec_value: "" };
}

function emptyForm() {
  return {
    id: null,
    item_code: "",
    item_name: "",
    brand: "",
    item_type: "",
    uom: "",
    hsn_no: "",
    list_price: "",
    gst_pct: "",
    description: "",
    serial_no_required: false,
    is_manufactured: false,
    mfg_job_prefix: "",
    sourcing_mode: "buy_external",
    intercompany_source_company_id: "",
    is_saleable: true,
    is_purchaseable: true,
    is_stocked: true,
    policy_remarks: "",
    is_auto_generated: false,
    is_active: true,
    family_key: "",
    module_role: "",
    variant_key: "",
    category_id: "",
    group_id: "",
    category_name: "",
    group_name: "",
    attributes: [emptyAttribute(1), emptyAttribute(2), emptyAttribute(3)],
  };
}

const OXYGEN_ATTRIBUTE_PRESET = [
  { caption: "PURITY", spec_value: "95 %" },
  { caption: "FLOW", spec_value: "30 Nm3/hr" },
  { caption: "DRY AIR REQUIRED", spec_value: "230 CFM" },
  { caption: "RECOMMENDED OXYGEN STORAGE", spec_value: "6000 L" },
  { caption: "RECOMMENDED AIR RECEIVER", spec_value: "2500 L" },
];

function normalizeCaptionKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function buildFormSignature(form) {
  if (!form) return "";
  return JSON.stringify({
    item_code: String(form.item_code || "").trim(),
    item_name: String(form.item_name || "").trim(),
    brand: String(form.brand || "").trim(),
    item_type: String(form.item_type || "").trim(),
    uom: String(form.uom || "").trim(),
    hsn_no: String(form.hsn_no || "").trim(),
    list_price: form.list_price === "" ? "" : String(form.list_price),
    gst_pct: form.gst_pct === "" ? "" : String(form.gst_pct),
    description: String(form.description || "").trim(),
    serial_no_required: Boolean(form.serial_no_required),
    is_manufactured: Boolean(form.is_manufactured),
    mfg_job_prefix: String(form.mfg_job_prefix || "").trim(),
    sourcing_mode: String(form.sourcing_mode || "").trim(),
    intercompany_source_company_id: String(form.intercompany_source_company_id || "").trim(),
    is_saleable: Boolean(form.is_saleable),
    is_purchaseable: Boolean(form.is_purchaseable),
    is_stocked: Boolean(form.is_stocked),
    policy_remarks: String(form.policy_remarks || "").trim(),
    is_auto_generated: Boolean(form.is_auto_generated),
    is_active: Boolean(form.is_active),
    family_key: String(form.family_key || "").trim(),
    module_role: String(form.module_role || "").trim(),
    variant_key: String(form.variant_key || "").trim(),
    category_id: String(form.category_id || "").trim(),
    group_id: String(form.group_id || "").trim(),
    attributes: Array.isArray(form.attributes)
      ? form.attributes
          .map((item) => ({
            caption: String(item.caption || "").trim(),
            spec_value: String(item.spec_value || "").trim(),
          }))
          .filter((item) => item.caption || item.spec_value)
      : [],
  });
}

function isBlankAttribute(item) {
  return !String(item?.caption || "").trim() && !String(item?.spec_value || "").trim();
}

function normalizeProductToForm(product) {
  const attrs = Array.isArray(product?.attributes) && product.attributes.length
    ? product.attributes.map((item, index) => ({
        key: item.id || `attr-${index + 1}`,
        sort_order: item.sort_order || index + 1,
        caption: item.caption || "",
        spec_value: item.spec_value || "",
      }))
    : [emptyAttribute(1), emptyAttribute(2), emptyAttribute(3)];

  return {
    id: product?.id ?? null,
    item_code: product?.item_code || "",
    item_name: product?.item_name || "",
    brand: product?.brand || "",
    item_type: product?.item_type || "",
    uom: product?.uom || "",
    hsn_no: product?.hsn_no || "",
    list_price: product?.list_price === null || product?.list_price === undefined ? "" : String(product.list_price),
    gst_pct: product?.gst_pct === null || product?.gst_pct === undefined ? "" : String(product.gst_pct),
    description: product?.description || "",
    serial_no_required: Boolean(product?.serial_no_required),
    is_manufactured: Boolean(product?.company_policy?.is_manufactured ?? product?.is_manufactured),
    mfg_job_prefix: product?.company_policy?.mfg_job_prefix || product?.mfg_job_prefix || "",
    sourcing_mode: product?.company_policy?.sourcing_mode || "buy_external",
    intercompany_source_company_id: product?.company_policy?.intercompany_source_company_id
      ? String(product.company_policy.intercompany_source_company_id)
      : "",
    is_saleable: product?.company_policy?.is_saleable !== false,
    is_purchaseable: product?.company_policy?.is_purchaseable !== false,
    is_stocked: product?.company_policy?.is_stocked !== false,
    policy_remarks: product?.company_policy?.remarks || "",
    is_auto_generated: Boolean(product?.is_auto_generated),
    is_active: product?.is_active !== false,
    family_key: product?.family_key || "",
    module_role: product?.module_role || "",
    variant_key: product?.variant_key || "",
    category_id: product?.category_id ? String(product.category_id) : "",
    group_id: product?.group_id ? String(product.group_id) : "",
    category_name: product?.category_name || "",
    group_name: product?.group_name || "",
    attributes: attrs,
  };
}

function sourcingModeLabel(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "manufacture") return "Manufactured here";
  if (mode === "buy_intercompany") return "Intercompany sourced";
  if (mode === "service_only") return "Service only";
  if (mode === "blocked") return "Blocked";
  return "Externally sourced";
}

function countLabel(value, singular, plural) {
  const count = Number(value) || 0;
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildProductPreviewNote(summary) {
  if (!summary) return "No product rows were found yet.";
  const issues = [];
  if (summary.blank_rows) issues.push(`${countLabel(summary.blank_rows, "blank row was", "blank rows were")} ignored`);
  if (summary.missing_item_code_rows) issues.push(`${countLabel(summary.missing_item_code_rows, "row is", "rows are")} missing Item Code`);
  if (summary.missing_category_rows) issues.push(`${countLabel(summary.missing_category_rows, "row is", "rows are")} missing Category`);
  if (summary.missing_group_rows) issues.push(`${countLabel(summary.missing_group_rows, "row is", "rows are")} missing Group`);
  if (summary.duplicate_item_code_rows) issues.push(`${countLabel(summary.duplicate_item_code_rows, "duplicate item code must", "duplicate item codes must")} be fixed before import`);
  return issues.length ? issues.join(" • ") : "Shared product columns look ready to load.";
}

function buildCompanyPolicyPreviewNote(summary) {
  if (!summary?.total_rows) return "No company-specific rules were found in this file.";
  const issues = [];
  if (summary.blank_rows) issues.push(`${countLabel(summary.blank_rows, "blank row was", "blank rows were")} ignored`);
  if (summary.missing_company_rows) issues.push(`${countLabel(summary.missing_company_rows, "row is", "rows are")} missing Company`);
  if (summary.missing_item_code_rows) issues.push(`${countLabel(summary.missing_item_code_rows, "row is", "rows are")} missing Item Code`);
  if (summary.invalid_sourcing_mode_rows) issues.push(`${countLabel(summary.invalid_sourcing_mode_rows, "row has", "rows have")} invalid sourcing`);
  if (summary.invalid_company_rows) issues.push(`${countLabel(summary.invalid_company_rows, "row has", "rows have")} an unknown company`);
  if (summary.invalid_intercompany_source_rows) issues.push(`${countLabel(summary.invalid_intercompany_source_rows, "row has", "rows have")} an invalid source company`);
  if (summary.incomplete_ic_pair_rows) {
    issues.push(
      `${countLabel(summary.incomplete_ic_pair_rows, "IC buy row lacks", "IC buy rows lack")} a matching manufacture policy on the source company`
    );
  }
  if (summary.missing_product_rows) issues.push(`${countLabel(summary.missing_product_rows, "row points", "rows point")} to an item code not found in Product Master`);
  if (summary.duplicate_company_item_rows) issues.push(`${countLabel(summary.duplicate_company_item_rows, "duplicate company-item row must", "duplicate company-item rows must")} be fixed before import`);
  return issues.length ? issues.join(" • ") : "Company-policy columns look ready to load.";
}

function buildImportCompletionNotice(summary) {
  const products = summary?.products || {};
  const companyPolicies = summary?.company_policies || {};
  return `Import finished. Products saved: ${products.imported || 0}. Company rules saved: ${companyPolicies.imported || 0}. Skipped: ${summary?.skipped || 0}.`;
}

function getImportErrorMessage(error, fallbackMessage) {
  const code = error?.data?.error;
  const details = error?.data?.details || {};
  const location = details?.sheet && details?.row_number ? ` in ${details.sheet} row ${details.row_number}` : "";
  const itemCode = details?.item_code ? ` for item code ${details.item_code}` : "";
  if (code === "NO_FILE") return "Choose an import file first. XLSX is recommended, and CSV stays available as fallback.";
  if (code === "PRODUCTS_SHEET_REQUIRED") return "This workbook needs a `Product Master` sheet, or the legacy `Products` sheet layout.";
  if (code === "INCONSISTENT_PRODUCT_ROWS") {
    const conflict = Array.isArray(details?.conflicts) && details.conflicts.length ? details.conflicts[0] : null;
    if (conflict) {
      return `Repeated item code ${conflict.item_code} has conflicting ${conflict.field} values between rows ${conflict.first_row_number || "?"} and ${conflict.conflicting_row_number || "?"}. Keep shared product columns identical across company rows.`;
    }
    return "Repeated item codes have conflicting shared product values. Keep the common columns identical across company rows.";
  }
  if (code === "ITEM_CODE_REQUIRED") return `Item Code is required${location}.`.trim();
  if (code === "CATEGORY_REQUIRED") return `Category is required${location}${itemCode}.`.trim();
  if (code === "GROUP_REQUIRED") return `Group is required${location}${itemCode}.`.trim();
  if (code === "DUPLICATE_ITEM_CODE_ROWS") return "Duplicate `Item Code` rows were found in Products. Fix them before applying the import.";
  if (code === "DUPLICATE_COMPANY_ITEM_ROWS") return "Duplicate `Company + Item Code` rows were found in the company-policy columns. Fix them before applying the import.";
  return code || fallbackMessage;
}

export default function ProductMaster({ me }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [dupGroups, setDupGroups] = useState([]);
  const [mergePreview, setMergePreview] = useState(null);
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [oxygenAudit, setOxygenAudit] = useState(null);
  const [manufacturingAudit, setManufacturingAudit] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [groups, setGroups] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [activeCompanyId, setActiveCompanyId] = useState(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [form, setForm] = useState(emptyForm());
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [showCategoryQuickAdd, setShowCategoryQuickAdd] = useState(false);
  const [showGroupQuickAdd, setShowGroupQuickAdd] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [editorTab, setEditorTab] = useState("basics");
  const [operatingMode, setOperatingMode] = useState("catalog"); // catalog | company | pair
  const [workspaceTab, setWorkspaceTab] = useState("import");
  const [bulkSpecText, setBulkSpecText] = useState("");
  const [lastSavedSignature, setLastSavedSignature] = useState(buildFormSignature(emptyForm()));
  const [lastSavedLabel, setLastSavedLabel] = useState("New draft opened");
  const [companyPolicies, setCompanyPolicies] = useState([]);
  const [policyCompanyId, setPolicyCompanyId] = useState("");
  const [pairForm, setPairForm] = useState({
    manufacturer_company_id: "",
    buyer_company_id: "",
    manufacturer_mfg_job_prefix: "N",
    manufacturer_is_saleable: true,
    buyer_is_saleable: true,
    buyer_is_purchaseable: true,
    buyer_is_stocked: true,
  });
  const editorSectionRef = useRef(null);
  const operationsSectionRef = useRef(null);
  const editorTabs =
    operatingMode === "catalog" ? ["basics", "commercial", "specs"] : operatingMode === "company" ? ["policy"] : [];
  const workspaceTabs = ["import", "maintenance", "readiness"];
  const modeTabs = [
    { key: "catalog", label: "Catalog" },
    { key: "company", label: "Company" },
    { key: "pair", label: "Intercompany pair" },
  ];

  useEffect(() => {
    refreshAll().catch(() => {});
  }, []);

  const filteredGroupOptions = useMemo(() => {
    if (!form.category_id) return groups;
    return groups.filter((item) => String(item.category_id) === String(form.category_id));
  }, [form.category_id, groups]);

  const selectedCategoryName = useMemo(() => {
    const match = categories.find((item) => String(item.id) === String(form.category_id));
    return match?.category_name || form.category_name || "";
  }, [categories, form.category_id, form.category_name]);

  const isOxygenCategory = /^oxygen$/i.test(selectedCategoryName);

  const listingGroupOptions = useMemo(() => {
    if (!categoryFilter) return groups;
    return groups.filter((item) => String(item.category_id) === String(categoryFilter));
  }, [categoryFilter, groups]);

  const productStats = useMemo(() => {
    const total = products.length;
    const active = products.filter((item) => item.is_active !== false).length;
    const manufactured = products.filter((item) => item.is_manufactured === true).length;
    const serialTracked = products.filter((item) => item.serial_no_required === true).length;
    return { total, active, manufactured, serialTracked };
  }, [products]);

  const selectedCatalogIndex = useMemo(
    () => products.findIndex((item) => Number(item.id) === Number(form.id)),
    [products, form.id]
  );

  const selectedCatalogProduct = useMemo(
    () => (selectedCatalogIndex >= 0 ? products[selectedCatalogIndex] : null),
    [products, selectedCatalogIndex]
  );

  const selectedGroupName = useMemo(() => {
    const match = groups.find((item) => String(item.id) === String(form.group_id));
    return match?.group_name || form.group_name || "";
  }, [groups, form.group_id, form.group_name]);

  const selectedProductMode = form.id ? "Editing existing product" : "Creating new product";
  const activeAttributeCount = useMemo(
    () => form.attributes.filter((item) => item.caption || item.spec_value).length,
    [form.attributes]
  );

  const activeCompany = useMemo(
    () => companies.find((item) => String(item.id) === String(activeCompanyId || "")) || null,
    [companies, activeCompanyId]
  );

  const currentCompanyLabel = useMemo(
    () => activeCompany?.company_name || activeCompany?.company_code || (activeCompanyId ? `Company ${activeCompanyId}` : "current company"),
    [activeCompany, activeCompanyId]
  );

  const selectedSourceCompanyLabel = useMemo(() => {
    const match = companies.find((item) => String(item.id) === String(form.intercompany_source_company_id || ""));
    return match?.company_name || match?.company_code || "";
  }, [companies, form.intercompany_source_company_id]);

  const formSignature = useMemo(() => buildFormSignature(form), [form]);
  const hasUnsavedChanges = formSignature !== lastSavedSignature;

  const policyCompany = useMemo(
    () => companies.find((item) => String(item.id) === String(policyCompanyId || activeCompanyId || "")) || null,
    [companies, policyCompanyId, activeCompanyId]
  );

  const policyCompanyLabel = useMemo(
    () => policyCompany?.company_name || policyCompany?.company_code || (policyCompanyId ? `Company ${policyCompanyId}` : currentCompanyLabel),
    [policyCompany, policyCompanyId, currentCompanyLabel]
  );

  const editorOwnershipLabel = useMemo(() => {
    const companyLabel = operatingMode === "company" ? policyCompanyLabel : currentCompanyLabel;
    if (form.sourcing_mode === "manufacture") return `Manufactured in ${companyLabel}`;
    if (form.sourcing_mode === "buy_intercompany") {
      return `Sourced in ${companyLabel} from ${selectedSourceCompanyLabel || "the partner company"}`;
    }
    if (form.sourcing_mode === "buy_external") return `Purchased in ${companyLabel} from external supply`;
    if (form.sourcing_mode === "service_only") return `Service-only item in ${companyLabel}`;
    if (form.sourcing_mode === "blocked") return `Blocked for operational use in ${companyLabel}`;
    return `Policy pending in ${companyLabel}`;
  }, [currentCompanyLabel, form.sourcing_mode, operatingMode, policyCompanyLabel, selectedSourceCompanyLabel]);

  const needsIcPairHint = useMemo(() => {
    if (!companyPolicies.length || companies.length < 2) return false;
    const hasManufacture = companyPolicies.some((row) => row.sourcing_mode === "manufacture");
    const hasIcBuy = companyPolicies.some((row) => row.sourcing_mode === "buy_intercompany");
    return hasManufacture !== hasIcBuy;
  }, [companyPolicies, companies.length]);

  const saveBlockers = useMemo(() => {
    const blockers = [];
    if (operatingMode === "pair") {
      if (!form.id) blockers.push("Save catalog product first");
      if (!String(pairForm.manufacturer_company_id || "").trim()) blockers.push("Manufacturer company");
      if (!String(pairForm.buyer_company_id || "").trim()) blockers.push("Buyer company");
      if (String(pairForm.manufacturer_company_id) === String(pairForm.buyer_company_id)) blockers.push("Distinct companies");
      if (!String(pairForm.manufacturer_mfg_job_prefix || "").trim()) blockers.push("Manufacturing prefix");
      return blockers;
    }
    if (operatingMode === "company") {
      if (!form.id) blockers.push("Save catalog product first");
      if (!String(policyCompanyId || activeCompanyId || "").trim()) blockers.push("Company");
      if (form.sourcing_mode === "buy_intercompany" && !String(form.intercompany_source_company_id || "").trim()) blockers.push("Source company");
      if (form.sourcing_mode === "manufacture" && !String(form.mfg_job_prefix || "").trim()) blockers.push("Manufacturing prefix");
      return blockers;
    }
    if (!String(form.item_code || "").trim()) blockers.push("Product code");
    if (!String(form.item_name || "").trim()) blockers.push("Product name");
    if (!String(form.category_id || "").trim()) blockers.push("Category");
    if (!String(form.group_id || "").trim()) blockers.push("Group");
    return blockers;
  }, [form, operatingMode, pairForm, policyCompanyId, activeCompanyId]);

  const footerState = useMemo(() => {
    if (!form.id) return { label: "New draft", tone: "#fff7ea", color: "#8b5a00" };
    if (hasUnsavedChanges) return { label: "Unsaved changes", tone: "#fff3f3", color: "#b00020" };
    return { label: "Saved", tone: "#eefbf3", color: "#0b7d45" };
  }, [form.id, hasUnsavedChanges]);

  function applyPolicyRowToForm(row) {
    if (!row) return;
    setForm((prev) => ({
      ...prev,
      is_manufactured: Boolean(row.is_manufactured),
      mfg_job_prefix: row.mfg_job_prefix || "",
      sourcing_mode: row.sourcing_mode || "buy_external",
      intercompany_source_company_id: row.intercompany_source_company_id ? String(row.intercompany_source_company_id) : "",
      is_saleable: row.is_saleable !== false,
      is_purchaseable: row.is_purchaseable !== false,
      is_stocked: row.is_stocked !== false,
      policy_remarks: row.remarks || "",
    }));
  }

  async function loadCompanyPolicies(productId, preferredCompanyId = null) {
    if (!productId) {
      setCompanyPolicies([]);
      return [];
    }
    const data = await apiFetch(`/products/admin/${productId}/company-policies`);
    const rows = Array.isArray(data?.policies) ? data.policies : [];
    setCompanyPolicies(rows);
    const preferred = preferredCompanyId || policyCompanyId || activeCompanyId;
    const match = rows.find((row) => String(row.company_id) === String(preferred)) || rows[0] || null;
    if (match) {
      setPolicyCompanyId(String(match.company_id));
      applyPolicyRowToForm(match);
    }
    return rows;
  }

  function seedPairFormFromCompanies(rows = companyPolicies) {
    const byCode = (code) => companies.find((c) => String(c.company_code || "").toUpperCase() === code);
    const ai = byCode("AI");
    const at = byCode("AT");
    const manufacture = rows.find((row) => row.sourcing_mode === "manufacture");
    const icBuy = rows.find((row) => row.sourcing_mode === "buy_intercompany");
    setPairForm((prev) => ({
      ...prev,
      manufacturer_company_id: String(manufacture?.company_id || ai?.id || prev.manufacturer_company_id || ""),
      buyer_company_id: String(icBuy?.company_id || at?.id || prev.buyer_company_id || ""),
      manufacturer_mfg_job_prefix: manufacture?.mfg_job_prefix || prev.manufacturer_mfg_job_prefix || "N",
      manufacturer_is_saleable: manufacture ? manufacture.is_saleable !== false : prev.manufacturer_is_saleable,
      buyer_is_saleable: icBuy ? icBuy.is_saleable !== false : prev.buyer_is_saleable,
      buyer_is_purchaseable: icBuy ? icBuy.is_purchaseable !== false : prev.buyer_is_purchaseable,
      buyer_is_stocked: icBuy ? icBuy.is_stocked !== false : prev.buyer_is_stocked,
    }));
  }

  async function loadBootstrap() {
    const data = await apiFetch("/products/admin/bootstrap");
    setCategories(Array.isArray(data?.categories) ? data.categories : []);
    setGroups(Array.isArray(data?.groups) ? data.groups : []);
    setCompanies(Array.isArray(data?.companies) ? data.companies : []);
    setActiveCompanyId(Number(data?.active_company_id) || null);
  }

  async function loadProducts() {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (statusFilter) params.set("status", statusFilter);
    if (categoryFilter) params.set("category_id", categoryFilter);
    if (groupFilter) params.set("group_id", groupFilter);
    const data = await apiFetch(`/products/admin/list?${params.toString()}`);
    setProducts(Array.isArray(data?.products) ? data.products : []);
  }

  async function refreshAll() {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadBootstrap(), loadProducts(), loadManufacturingAudit()]);
    } catch (e) {
      setError(e?.data?.error || "Failed to load Product Master.");
    } finally {
      setLoading(false);
    }
  }

  async function loadManufacturingAudit() {
    const data = await apiFetch("/products/admin/maintenance/manufacturing-readiness-audit");
    setManufacturingAudit(data?.audit || null);
  }

  async function editProduct(productId) {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch(`/products/admin/${productId}`);
      const nextForm = normalizeProductToForm(data?.product || null);
      setForm(nextForm);
      setLastSavedSignature(buildFormSignature(nextForm));
      setLastSavedLabel("Loaded from catalog");
      setEditorTab("basics");
      setOperatingMode("catalog");
      setNotice("");
      const rows = await loadCompanyPolicies(productId, activeCompanyId);
      seedPairFormFromCompanies(rows);
    } catch (e) {
      setError(e?.data?.error || "Failed to load product.");
    } finally {
      setSaving(false);
    }
  }

  function startNew() {
    const nextForm = emptyForm();
    setForm(nextForm);
    setLastSavedSignature(buildFormSignature(nextForm));
    setLastSavedLabel("New draft opened");
    setEditorTab("basics");
    setOperatingMode("catalog");
    setCompanyPolicies([]);
    setNotice("");
    setError("");
  }

  function setOperatingModeSafe(nextMode) {
    setOperatingMode(nextMode);
    if (nextMode === "catalog") setEditorTab("basics");
    if (nextMode === "company") {
      setEditorTab("policy");
      if (form.id) {
        loadCompanyPolicies(form.id, policyCompanyId || activeCompanyId).catch(() => {});
      }
    }
    if (nextMode === "pair") {
      seedPairFormFromCompanies(companyPolicies);
    }
  }

  function selectPolicyCompany(nextCompanyId) {
    const companyId = String(nextCompanyId || "");
    setPolicyCompanyId(companyId);
    const match = companyPolicies.find((row) => String(row.company_id) === companyId);
    if (match) {
      applyPolicyRowToForm(match);
      return;
    }
    setForm((prev) => ({
      ...prev,
      is_manufactured: false,
      mfg_job_prefix: "",
      sourcing_mode: "buy_external",
      intercompany_source_company_id: "",
      is_saleable: true,
      is_purchaseable: true,
      is_stocked: true,
      policy_remarks: "",
    }));
  }

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setAttribute(index, key, value) {
    setForm((prev) => ({
      ...prev,
      attributes: prev.attributes.map((item, idx) => (idx === index ? { ...item, [key]: value } : item)),
    }));
  }

  function addAttributeRow() {
    setForm((prev) => ({
      ...prev,
      attributes: [...prev.attributes, emptyAttribute(prev.attributes.length + 1)],
    }));
  }

  function addSuggestedAttributes(suggestions) {
    setForm((prev) => {
      const existing = new Set(prev.attributes.map((item) => normalizeCaptionKey(item.caption)).filter(Boolean));
      const missing = (suggestions || []).filter((item) => !existing.has(normalizeCaptionKey(item.caption)));
      if (!missing.length) return prev;

      const next = [...prev.attributes];
      for (const suggestion of missing) {
        const blankIndex = next.findIndex(isBlankAttribute);
        if (blankIndex >= 0) {
          next[blankIndex] = {
            ...next[blankIndex],
            caption: suggestion.caption,
            spec_value: next[blankIndex].spec_value || suggestion.spec_value,
          };
        } else {
          next.push({
            ...emptyAttribute(next.length + 1),
            caption: suggestion.caption,
            spec_value: suggestion.spec_value,
          });
        }
      }

      return {
        ...prev,
        attributes: next.map((item, index) => ({ ...item, sort_order: index + 1 })),
      };
    });
  }

  function removeAttributeRow(index) {
    setForm((prev) => {
      const next = prev.attributes.filter((_, idx) => idx !== index);
      return {
        ...prev,
        attributes: next.length ? next.map((item, idx) => ({ ...item, sort_order: idx + 1 })) : [emptyAttribute(1)],
      };
    });
  }

  function applyBulkAttributes() {
    const lines = String(bulkSpecText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return;

    setForm((prev) => {
      const existing = prev.attributes
        .map((item) => ({
          ...item,
          _captionKey: normalizeCaptionKey(item.caption),
        }))
        .filter((item) => item.caption || item.spec_value);

      const incoming = [];
      for (const line of lines) {
        const parts = line.split(/\t|:|=/);
        if (!parts.length) continue;
        const caption = (parts.shift() || "").trim();
        const specValue = parts.join(":").trim();
        if (!caption && !specValue) continue;
        incoming.push({ caption, spec_value: specValue });
      }

      if (!incoming.length) return prev;

      const incomingMap = new Map();
      for (const item of incoming) {
        incomingMap.set(normalizeCaptionKey(item.caption), item);
      }

      const updatedExisting = existing.map((item) => {
        const match = incomingMap.get(item._captionKey);
        if (!match) return { caption: item.caption, spec_value: item.spec_value };
        incomingMap.delete(item._captionKey);
        return {
          caption: match.caption || item.caption,
          spec_value: match.spec_value || item.spec_value,
        };
      });

      const appended = Array.from(incomingMap.values());
      const next = [...updatedExisting, ...appended].map((item, index) => ({
        ...emptyAttribute(index + 1),
        ...item,
        sort_order: index + 1,
      }));

      return {
        ...prev,
        attributes: next.length ? next : [emptyAttribute(1)],
      };
    });

    setBulkSpecText("");
    setNotice("Specification lines added to the draft.");
  }

  function stepCatalogSelection(direction) {
    if (!products.length) return;
    if (selectedCatalogIndex < 0) {
      const fallbackIndex = direction > 0 ? 0 : products.length - 1;
      editProduct(products[fallbackIndex].id);
      return;
    }
    const nextIndex = selectedCatalogIndex + direction;
    if (nextIndex < 0 || nextIndex >= products.length) return;
    editProduct(products[nextIndex].id);
  }

  function moveEditorTab(direction) {
    const currentIndex = editorTabs.indexOf(editorTab);
    if (currentIndex < 0) return;
    const nextIndex = Math.max(0, Math.min(editorTabs.length - 1, currentIndex + direction));
    setEditorTab(editorTabs[nextIndex]);
  }

  function moveWorkspaceTab(direction) {
    const currentIndex = workspaceTabs.indexOf(workspaceTab);
    if (currentIndex < 0) return;
    const nextIndex = Math.max(0, Math.min(workspaceTabs.length - 1, currentIndex + direction));
    setWorkspaceTab(workspaceTabs[nextIndex]);
  }

  useEffect(() => {
    function handleGlobalShortcuts(event) {
      if (!event.altKey) return;
      if (event.defaultPrevented) return;

      if (!event.shiftKey && /^[1-4]$/.test(event.key)) {
        const next = editorTabs[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          setEditorTab(next);
          editorSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }

      if (event.shiftKey && /^[1-3]$/.test(event.key)) {
        const next = workspaceTabs[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          setWorkspaceTab(next);
          operationsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }

      if (!event.shiftKey && (event.key === "e" || event.key === "E")) {
        event.preventDefault();
        editorSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      if (!event.shiftKey && (event.key === "o" || event.key === "O")) {
        event.preventDefault();
        operationsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    window.addEventListener("keydown", handleGlobalShortcuts);
    return () => window.removeEventListener("keydown", handleGlobalShortcuts);
  }, [operatingMode]);

  async function createCategory() {
    if (!newCategoryName.trim()) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/products/admin/category", {
        method: "POST",
        body: JSON.stringify({ category_name: newCategoryName.trim() }),
      });
      await loadBootstrap();
      setField("category_id", String(data?.category?.id || ""));
      setNewCategoryName("");
      setShowCategoryQuickAdd(false);
      setNotice("Category created.");
    } catch (e) {
      setError(e?.data?.error || "Failed to create category.");
    } finally {
      setSaving(false);
    }
  }

  async function createGroup() {
    if (!newGroupName.trim() || !form.category_id) return;
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/products/admin/group", {
        method: "POST",
        body: JSON.stringify({ category_id: Number(form.category_id), group_name: newGroupName.trim() }),
      });
      await loadBootstrap();
      setField("group_id", String(data?.group?.id || ""));
      setNewGroupName("");
      setShowGroupQuickAdd(false);
      setNotice("Group created.");
    } catch (e) {
      setError(e?.data?.error || "Failed to create group.");
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (operatingMode === "pair") {
        if (!form.id) throw Object.assign(new Error("Save catalog first"), { data: { error: "SAVE_CATALOG_FIRST" } });
        const data = await apiFetch(`/products/admin/${form.id}/company-policies/pair`, {
          method: "PUT",
          body: JSON.stringify({
            manufacturer_company_id: Number(pairForm.manufacturer_company_id),
            buyer_company_id: Number(pairForm.buyer_company_id),
            manufacturer_policy: {
              sourcing_mode: "manufacture",
              is_manufactured: true,
              mfg_job_prefix: pairForm.manufacturer_mfg_job_prefix || "N",
              is_saleable: Boolean(pairForm.manufacturer_is_saleable),
              is_purchaseable: true,
              is_stocked: true,
            },
            buyer_policy: {
              sourcing_mode: "buy_intercompany",
              is_saleable: Boolean(pairForm.buyer_is_saleable),
              is_purchaseable: Boolean(pairForm.buyer_is_purchaseable),
              is_stocked: Boolean(pairForm.buyer_is_stocked),
            },
          }),
        });
        const rows = Array.isArray(data?.policies) ? data.policies : await loadCompanyPolicies(form.id);
        setCompanyPolicies(rows);
        seedPairFormFromCompanies(rows);
        setLastSavedSignature(buildFormSignature(form));
        setLastSavedLabel("Intercompany pair saved");
        setNotice("Intercompany pair saved for both companies.");
        await loadProducts();
        return;
      }

      if (operatingMode === "company") {
        if (!form.id) throw Object.assign(new Error("Save catalog first"), { data: { error: "SAVE_CATALOG_FIRST" } });
        const companyId = Number(policyCompanyId || activeCompanyId);
        const data = await apiFetch(`/products/admin/${form.id}/company-policy`, {
          method: "PUT",
          body: JSON.stringify({
            company_id: companyId,
            company_policy: {
              is_manufactured: Boolean(form.is_manufactured),
              mfg_job_prefix: form.mfg_job_prefix || null,
              sourcing_mode: form.sourcing_mode || "buy_external",
              intercompany_source_company_id:
                form.sourcing_mode === "buy_intercompany" && form.intercompany_source_company_id
                  ? Number(form.intercompany_source_company_id)
                  : null,
              is_saleable: Boolean(form.is_saleable),
              is_purchaseable: Boolean(form.is_purchaseable),
              is_stocked: Boolean(form.is_stocked),
              remarks: form.policy_remarks || null,
            },
          }),
        });
        const nextForm = normalizeProductToForm(data?.product);
        setForm(nextForm);
        setCompanyPolicies(Array.isArray(data?.policies) ? data.policies : companyPolicies);
        setLastSavedSignature(buildFormSignature(nextForm));
        setLastSavedLabel("Company policy saved");
        setNotice(`Company policy saved for ${policyCompanyLabel}. Shared SKU unchanged.`);
        await loadProducts();
        return;
      }

      const payload = {
        save_mode: "catalog",
        update_company_policy: !form.id,
        item_code: form.item_code,
        item_name: form.item_name,
        brand: form.brand,
        item_type: form.item_type,
        uom: form.uom,
        hsn_no: form.hsn_no,
        list_price: form.list_price === "" ? null : Number(form.list_price),
        gst_pct: form.gst_pct === "" ? null : Number(form.gst_pct),
        description: form.description,
        serial_no_required: Boolean(form.serial_no_required),
        is_auto_generated: Boolean(form.is_auto_generated),
        is_active: Boolean(form.is_active),
        category_id: form.category_id ? Number(form.category_id) : null,
        group_id: form.group_id ? Number(form.group_id) : null,
        family_key: form.family_key || null,
        module_role: form.module_role || null,
        variant_key: form.variant_key || null,
        attributes: form.attributes
          .map((item, index) => ({
            sort_order: index + 1,
            caption: item.caption,
            spec_value: item.spec_value,
          }))
          .filter((item) => item.caption || item.spec_value),
      };
      if (!form.id) {
        payload.company_policy = {
          is_manufactured: false,
          sourcing_mode: "buy_external",
          is_saleable: true,
          is_purchaseable: true,
          is_stocked: true,
        };
      }

      const data = form.id
        ? await apiFetch(`/products/admin/${form.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiFetch("/products/admin", { method: "POST", body: JSON.stringify(payload) });

      await loadProducts();
      const nextForm = normalizeProductToForm(data?.product);
      setForm(nextForm);
      setLastSavedSignature(buildFormSignature(nextForm));
      setLastSavedLabel(form.id ? "Catalog saved" : "Draft created");
      setNotice(form.id ? "Shared catalog saved. Company policies were not changed." : "Product created.");
      if (data?.product?.id) {
        const rows = await loadCompanyPolicies(data.product.id, activeCompanyId);
        seedPairFormFromCompanies(rows);
      }
    } catch (e) {
      const code = e?.data?.error;
      if (code === "DUPLICATE_ITEM_CODE") setError("This item code already exists.");
      else if (code === "ITEM_CODE_REQUIRED") setError("Item code is required.");
      else if (code === "CATEGORY_REQUIRED") setError("Category is required.");
      else if (code === "GROUP_REQUIRED") setError("Group is required.");
      else if (code === "INTERCOMPANY_SOURCE_REQUIRED") setError("Source company is required for intercompany sourcing.");
      else if (code === "INTERCOMPANY_SOURCE_SAME_COMPANY") setError("Source company must differ from the policy company.");
      else if (code === "INTERCOMPANY_SOURCE_NOT_FOUND") setError("Source company was not found.");
      else if (code === "INTERCOMPANY_SOURCE_INACTIVE") setError("Source company policy is blocked or not saleable for this SKU.");
      else if (code === "INTERCOMPANY_SOURCE_NOT_MANUFACTURER") setError("Source company must manufacture this SKU.");
      else if (code === "SAVE_CATALOG_FIRST") setError("Save the shared catalog product first.");
      else if (code === "PAIR_COMPANIES_MUST_DIFFER") setError("Manufacturer and buyer companies must be different.");
      else setError(code || "Failed to save product.");
    } finally {
      setSaving(false);
    }
  }

  async function previewImport() {
    if (!importFile) return;
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("file", importFile);
      const data = await apiFetchForm("/products/admin/import/preview", fd, { method: "POST" });
      setImportPreview(data?.preview || null);
    } catch (e) {
      setError(getImportErrorMessage(e, "Failed to review the import file."));
    } finally {
      setImporting(false);
    }
  }

  async function runOxygenPackageBackfill() {
    setMaintenanceBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/products/admin/maintenance/oxygen-package-backfill", {
        method: "POST",
      });
      await loadProducts();
      const summary = data?.summary || {};
      setNotice(
        `Oxygen package backfill complete. Products matched: ${summary.matched_products || 0}. Products backfilled: ${
          summary.backfilled_products || 0
        }. Attributes inserted: ${summary.inserted_attributes || 0}.`
      );
      const auditData = await apiFetch("/products/admin/maintenance/oxygen-package-audit");
      setOxygenAudit(auditData?.audit || null);
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || "Failed to backfill Oxygen package captions.");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function runOxygenPackageAudit() {
    setMaintenanceBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/products/admin/maintenance/oxygen-package-audit");
      const audit = data?.audit || null;
      setOxygenAudit(audit);
      setNotice(
        `Oxygen audit complete. Ready: ${audit?.ready_products || 0}. Missing captions: ${audit?.missing_products || 0}. Unmatched: ${
          audit?.unmatched_products || 0
        }.`
      );
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || "Failed to audit Oxygen package readiness.");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function runManufacturingAudit() {
    setMaintenanceBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/products/admin/maintenance/manufacturing-readiness-audit");
      const audit = data?.audit || null;
      setManufacturingAudit(audit);
      setNotice(
        `Manufacturing audit complete. Ready: ${audit?.ready_count || 0}. Missing FG flag: ${audit?.missing_fg_flag_count || 0}. Missing prefix: ${audit?.missing_prefix_count || 0}. Missing BOM: ${audit?.missing_bom_count || 0}.`
      );
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || "Failed to audit manufacturing readiness.");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function applyImport(confirmPhrase) {
    if (!importFile) return;
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const fd = new FormData();
      fd.append("confirm_phrase", String(confirmPhrase || ""));
      fd.append("file", importFile);
      const data = await apiFetchForm("/products/admin/import/apply", fd, { method: "POST" });
      const summary = data?.summary || {};
      setNotice(buildImportCompletionNotice(summary));
      setImportPreview(null);
      setImportFile(null);
      setApplyConfirmOpen(false);
      await refreshAll();
    } catch (e) {
      setError(getImportErrorMessage(e, "Failed to apply the import file."));
    } finally {
      setImporting(false);
    }
  }

  async function loadDuplicates() {
    try {
      const data = await apiFetch("/products/admin/duplicates?limit=30");
      setDupGroups(data.groups || []);
    } catch (_e) {
      setDupGroups([]);
    }
  }

  async function previewProductMerge(sourceId, targetId) {
    setMergeBusy(true);
    setError("");
    try {
      const data = await apiFetch("/products/admin/merge/preview", {
        method: "POST",
        body: JSON.stringify({ source_product_id: sourceId, target_product_id: targetId }),
      });
      setMergePreview(data);
      setMergeConfirmOpen(true);
    } catch (e) {
      setError(e?.data?.error || "Failed to preview product merge.");
    } finally {
      setMergeBusy(false);
    }
  }

  async function executeProductMerge(confirmPhrase) {
    if (!mergePreview?.source_product?.id || !mergePreview?.target_product?.id) return;
    setMergeBusy(true);
    setError("");
    try {
      const data = await apiFetch("/products/admin/merge/execute", {
        method: "POST",
        body: JSON.stringify({
          source_product_id: mergePreview.source_product.id,
          target_product_id: mergePreview.target_product.id,
          confirm_phrase: String(confirmPhrase || ""),
        }),
      });
      setNotice(data.message || "Products merged.");
      setMergeConfirmOpen(false);
      setMergePreview(null);
      await Promise.all([refreshAll(), loadDuplicates()]);
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || "Failed to merge products.");
    } finally {
      setMergeBusy(false);
    }
  }

  async function downloadCurrentWorkbook() {
    setError("");
    setNotice("");
    try {
      await downloadFile(
        `/products/admin/import/current-workbook?v=${Date.now()}`,
        `ProductMaster_Current_EXPORT_${formatDownloadTimestamp()}.xlsx`
      );
      setNotice("Current Product Master downloaded.");
    } catch (e) {
      setError(e?.data?.detail || e?.data?.error || "Failed to download current Product Master.");
    }
  }

  return (
    <div style={{ maxWidth: 1480, width: "100%", padding: "6px 0 16px" }}>
      <div
        style={{
          marginBottom: 14,
          border: "1px solid #aab9d1",
          borderRadius: 18,
          padding: 16,
          background: "linear-gradient(135deg, #eef3fa 0%, #f8fbff 28%, #dfeafc 100%)",
          boxShadow: "0 18px 40px rgba(10, 22, 40, 0.14)",
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.56, marginBottom: 8 }}>
              Product Operations Console
            </div>
            <h2 style={{ margin: 0, fontSize: 30, lineHeight: 1.1 }}>Product Master</h2>
            <div style={{ fontSize: 13, color: "#57647d", marginTop: 8, maxWidth: 760, lineHeight: 1.6 }}>
              Shared product definition, company policy, and workbook operations now sit in clearer work zones so the team
              can browse, edit, and bulk-load without crossing wires.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              <MicroChip label={`Company ${currentCompanyLabel}`} tone="#eef4ff" color="#234a8f" />
              <MicroChip label={selectedProductMode} tone="#f6f7fb" color="#546076" />
              <MicroChip label={form.id ? "Shared + policy editor" : "New draft ready"} tone="#f2fff6" color="#0b7d45" />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={startNew}>New Product</button>
            <button onClick={() => refreshAll().catch(() => {})} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        <div className="product-master-stats" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 12, marginTop: 18 }}>
          <StatCard label="Visible Products" value={productStats.total} tone="#143d7a" />
          <StatCard label="Active" value={productStats.active} tone="#0a7a35" />
          <StatCard label="Manufactured FG" value={productStats.manufactured} tone="#7c4d00" />
          <StatCard label="Serial Controlled" value={productStats.serialTracked} tone="#7a1637" />
        </div>
      </div>

      {error ? (
        <div style={{ color: "#9f1428", marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "#fff2f4", border: "1px solid #f0b7c1", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.7)" }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div style={{ color: "#0d6b33", marginBottom: 10, padding: "10px 12px", borderRadius: 10, background: "#effbf4", border: "1px solid #b9e7c8", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.7)" }}>
          {notice}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 0.92fr) minmax(640px, 1.48fr)", gap: 18, alignItems: "start" }}>
          <SectionCard
            title="Catalog Radar"
            subtitle="Search, filter, and open products without the editor noise"
            actions={
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => loadProducts().catch(() => {})} disabled={loading}>
                  {loading ? "Refreshing..." : "Apply Filters"}
                </button>
                <button type="button" onClick={startNew}>
                  New Draft
                </button>
              </div>
            }
          >
            <div
              style={{
                border: "1px solid #c5d3e8",
                borderRadius: 12,
                padding: 10,
                background: "linear-gradient(180deg, #f0f5fd 0%, #e8f0fb 100%)",
                marginBottom: 12,
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                <MiniMetric label="In View" value={products.length} />
                <MiniMetric label="Active" value={productStats.active} />
                <MiniMetric label="Manufactured" value={productStats.manufactured} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, alignItems: "center" }}>
                <FocusStrip
                  label="Current Focus"
                  value={
                    selectedCatalogProduct
                      ? `${selectedCatalogProduct.item_code || "No code"} • ${selectedCatalogProduct.item_name || "Unnamed product"}`
                      : form.id
                        ? "Loaded product is outside the current filtered view"
                        : "No product selected from the catalog yet"
                  }
                  tone={selectedCatalogProduct ? "#eef4ff" : "#f6f7fb"}
                  color={selectedCatalogProduct ? "#234a8f" : "#546076"}
                />
                <button
                  type="button"
                  onClick={() => stepCatalogSelection(-1)}
                  disabled={selectedCatalogIndex <= 0}
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => stepCatalogSelection(1)}
                  disabled={selectedCatalogIndex < 0 || selectedCatalogIndex >= products.length - 1}
                >
                  Next
                </button>
              </div>
            </div>

            <div className="product-master-filters" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search code, name, brand, category, group" style={{ ...controlStyle, gridColumn: "1 / -1" }} />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={controlStyle}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="">All</option>
              </select>
              <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setGroupFilter(""); }} style={controlStyle}>
                <option value="">All Categories</option>
                {categories.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.category_name}
                  </option>
                ))}
              </select>
              <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} style={controlStyle}>
                <option value="">All Groups</option>
                {listingGroupOptions.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.group_name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => { setQuery(""); setStatusFilter("active"); setCategoryFilter(""); setGroupFilter(""); }}>
                Clear Filters
              </button>
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              <MicroChip label={`${products.length} in view`} tone="#eef4ff" color="#234a8f" />
              <MicroChip label={statusFilter ? `${statusFilter} only` : "all statuses"} tone="#f6f7fb" color="#5d6782" />
              <MicroChip label={categoryFilter ? categories.find((item) => String(item.id) === String(categoryFilter))?.category_name || "category filtered" : "all categories"} tone="#fff6e8" color="#8b5a00" />
              <MicroChip label={groupFilter ? listingGroupOptions.find((item) => String(item.id) === String(groupFilter))?.group_name || "group filtered" : "all groups"} tone="#f2fff6" color="#0b7d45" />
              <MicroChip label={`Sourcing chips = ${currentCompanyLabel}`} tone="#eef4ff" color="#234a8f" />
              {needsIcPairHint ? <MicroChip label="Selected SKU needs IC pair" tone="#fff7ea" color="#8b5a00" /> : null}
            </div>

            <div style={{ display: "grid", gap: 8, maxHeight: "calc(100vh - 320px)", overflowY: "auto", paddingRight: 2 }}>
              {loading ? (
                <div style={{ padding: 14 }}>Loading products…</div>
              ) : products.length ? (
                products.map((item) => {
                  const selected = Number(form.id) === Number(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => editProduct(item.id)}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        border: selected ? "1px solid #7fa0d9" : "1px solid #d5deea",
                        borderRadius: 12,
                        padding: 10,
                        background: selected ? "linear-gradient(135deg, #e6eefc 0%, #ffffff 52%, #edf4ff 100%)" : "linear-gradient(180deg, #ffffff 0%, #fbfcfe 100%)",
                        boxShadow: selected ? "0 10px 24px rgba(25, 61, 124, 0.14)" : "0 4px 12px rgba(16, 29, 48, 0.05)",
                        display: "grid",
                        gap: 7,
                        position: "relative",
                        borderLeft: selected ? "4px solid #2354d5" : "4px solid transparent",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>{item.item_code}</div>
                          <div style={{ fontWeight: 800, fontSize: 15, marginTop: 3 }}>{item.item_name}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          {selected ? <MicroChip label="In editor" tone="#eef4ff" color="#234a8f" /> : null}
                          <StatusPill active={item.is_active !== false} />
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <MicroChip label={item.category_name || "No category"} tone="#f6f7fb" color="#546076" />
                        <MicroChip label={item.group_name || "No group"} tone="#f6f7fb" color="#546076" />
                        <MicroChip
                          label={sourcingModeLabel(item.sourcing_mode)}
                          tone={item.sourcing_mode === "buy_intercompany" ? "#eef4ff" : item.sourcing_mode === "manufacture" ? "#eefbf3" : "#f6f7fb"}
                          color={item.sourcing_mode === "buy_intercompany" ? "#2354d5" : item.sourcing_mode === "manufacture" ? "#0b7d45" : "#546076"}
                        />
                        {item.serial_no_required ? <MicroChip label="Serial" tone="#fff2f3" color="#9f2042" /> : null}
                        {item.is_manufactured ? <MicroChip label={`MFG ${item.mfg_job_prefix || "?"}`} tone="#fff6e8" color="#8b5a00" /> : null}
                      </div>

                      <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.45 }}>
                        {item.sourcing_mode === "manufacture"
                          ? `Manufactured in ${currentCompanyLabel}`
                          : item.sourcing_mode === "buy_intercompany"
                            ? `Sourced in ${currentCompanyLabel} from ${item.intercompany_source_company_name || "the partner company"}`
                            : item.sourcing_mode === "buy_external"
                              ? `Purchased in ${currentCompanyLabel} from external supply`
                              : item.sourcing_mode === "service_only"
                                ? `Service-only item in ${currentCompanyLabel}`
                                : `Operationally blocked in ${currentCompanyLabel}`}
                      </div>

                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "#526079" }}>
                        <InlineMeta label="List" value={item.list_price ?? "—"} />
                        <InlineMeta label="GST" value={item.gst_pct ?? "—"} />
                        <InlineMeta label="Specs" value={item.attribute_count ?? 0} />
                        <InlineMeta label="Brand" value={item.brand || "—"} />
                      </div>
                    </button>
                  );
                })
              ) : (
                <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                  No products found. Adjust filters or create a fresh product.
                </div>
              )}
            </div>
          </SectionCard>

          <div ref={editorSectionRef} style={{ minWidth: 0 }}>
            <div
              style={{
                border: "1px solid #c2cfdf",
                borderRadius: 16,
                overflow: "hidden",
                background: "linear-gradient(180deg, #ffffff 0%, #f9fbfe 100%)",
                boxShadow: "0 16px 36px rgba(11, 22, 39, 0.12)",
              }}
            >
            <div
              style={{
                padding: 14,
                borderBottom: "1px solid #d8e2ef",
                background: "linear-gradient(180deg, #eef4fb 0%, #f8fbff 100%)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.56 }}>{selectedProductMode}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{form.item_name || "New Product Draft"}</div>
                  <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6 }}>
                    {form.item_code || "No item code yet"}
                    {selectedCategoryName ? ` • ${selectedCategoryName}` : ""}
                    {selectedGroupName ? ` • ${selectedGroupName}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <StatusPill active={form.is_active} />
                  {form.serial_no_required ? <MicroChip label="Serial tracked" tone="#fff2f3" color="#9f2042" /> : null}
                  {operatingMode !== "catalog" && form.is_manufactured ? (
                    <MicroChip label={`MFG ${form.mfg_job_prefix || "Pending prefix"}`} tone="#fff6e8" color="#8b5a00" />
                  ) : null}
                  {operatingMode !== "catalog" ? (
                    <MicroChip
                      label={sourcingModeLabel(form.sourcing_mode)}
                      tone={form.sourcing_mode === "buy_intercompany" ? "#eef4ff" : form.sourcing_mode === "manufacture" ? "#eefbf3" : "#f6f7fb"}
                      color={form.sourcing_mode === "buy_intercompany" ? "#2354d5" : form.sourcing_mode === "manufacture" ? "#0b7d45" : "#546076"}
                    />
                  ) : (
                    <MicroChip label="Shared SKU" tone="#eef4ff" color="#234a8f" />
                  )}
                  {needsIcPairHint ? <MicroChip label="Needs IC pair" tone="#fff7ea" color="#8b5a00" /> : null}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {modeTabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setOperatingModeSafe(tab.key)}
                    style={{
                      border: operatingMode === tab.key ? "1px solid #7fa0d9" : "1px solid #d5deea",
                      background: operatingMode === tab.key ? "linear-gradient(180deg, #e8f0ff 0%, #f7faff 100%)" : "#ffffff",
                      fontWeight: operatingMode === tab.key ? 700 : 500,
                      borderRadius: 999,
                      padding: "8px 14px",
                      cursor: "pointer",
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {operatingMode === "company" ? (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: "#eef4ff", border: "1px solid #c5d5f5" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#234a8f" }}>
                    Editing policy for {policyCompanyLabel} — shared SKU unchanged.
                  </div>
                </div>
              ) : null}
              {operatingMode === "pair" ? (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: "#eefbf3", border: "1px solid #b9e4c8" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#0b7d45" }}>
                    One save sets manufacturer to manufacture and buyer to buy intercompany from that manufacturer.
                  </div>
                </div>
              ) : null}
              {operatingMode === "catalog" ? (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: "#f6f7fb", border: "1px solid #d8dee8" }}>
                  <div style={{ fontSize: 13, color: "#546076" }}>
                    Catalog edits shared identity only. Company sourcing and IC routing stay in Company / Intercompany pair modes.
                  </div>
                </div>
              ) : null}

              {operatingMode === "catalog" ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
                  <MiniMetric label="Specs" value={activeAttributeCount} />
                  <MiniMetric label="GST %" value={form.gst_pct || "—"} />
                  <MiniMetric label="List Price" value={form.list_price || "—"} />
                </div>
              ) : null}

              {operatingMode !== "pair" ? (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "linear-gradient(180deg, #eef4fb 0%, #f8fbff 100%)", border: "1px solid #cfdbeb" }}>
                  <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58, marginBottom: 6 }}>
                    {operatingMode === "catalog" ? "Shared catalog" : "Manufactured In / Sourced From"}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                    {operatingMode === "catalog"
                      ? "One shared SKU for all companies. Switch to Company or Intercompany pair to set per-company routing."
                      : editorOwnershipLabel}
                  </div>
                </div>
              ) : null}

              {operatingMode === "catalog" ? (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                    <EditorTabButton label="Basics" active={editorTab === "basics"} onClick={() => setEditorTab("basics")} onMove={moveEditorTab} />
                    <EditorTabButton label="Commercial" active={editorTab === "commercial"} onClick={() => setEditorTab("commercial")} onMove={moveEditorTab} />
                    <EditorTabButton label="Specs" active={editorTab === "specs"} onClick={() => setEditorTab("specs")} onMove={moveEditorTab} />
                    <button type="button" onClick={() => operationsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                      Jump To Operations
                    </button>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.64, marginTop: 10 }}>
                    Keyboard: `Alt+1..3` switches catalog tabs. `Alt+E` returns to this editor workspace.
                  </div>
                </>
              ) : null}
            </div>

            <div style={{ padding: 14, display: "grid", gap: 12, maxHeight: "calc(100vh - 90px)", overflowY: "auto" }}>
              {operatingMode === "catalog" && editorTab === "basics" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1.08fr 0.92fr", gap: 16, alignItems: "start" }}>
                  <SectionBlock title="Shared Definition" subtitle="Common identity and classification used by both AT and AI">
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 10 }}>
                      <Field
                        label="Product Code"
                        help={form.id ? "Locked after create." : "Use the master code that downstream desks will reference."}
                      >
                        <input
                          value={form.item_code}
                          onChange={(e) => setField("item_code", e.target.value)}
                          style={controlStyle}
                          readOnly={Boolean(form.id)}
                          disabled={Boolean(form.id)}
                        />
                      </Field>
                      <Field label="Product Name" help="Use the clearest operator-facing name, not just an internal shorthand.">
                        <input value={form.item_name} onChange={(e) => setField("item_name", e.target.value)} style={controlStyle} />
                      </Field>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="Brand / Make">
                        <input value={form.brand} onChange={(e) => setField("brand", e.target.value)} style={controlStyle} />
                      </Field>
                      <Field label="Product Type" help="Example: equipment, consumable, assembly, or service item.">
                        <input value={form.item_type} onChange={(e) => setField("item_type", e.target.value)} style={controlStyle} />
                      </Field>
                    </div>
                    <Field label="Product Description" help="Shared description used across desks and reports.">
                      <textarea rows={3} value={form.description} onChange={(e) => setField("description", e.target.value)} style={textAreaStyle} />
                    </Field>
                    <div style={{ display: "grid", gap: 8 }}>
                      <Field label="Category" help="Choose the broad catalog bucket first.">
                        <select
                          value={form.category_id}
                          onChange={(e) => {
                            setField("category_id", e.target.value);
                            setField("group_id", "");
                          }}
                          style={controlStyle}
                        >
                          <option value="">-- Select category --</option>
                          {categories.map((item) => (
                            <option key={item.id} value={String(item.id)}>
                              {item.category_name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <QuickAddInline
                        open={showCategoryQuickAdd}
                        onToggle={() => setShowCategoryQuickAdd((value) => !value)}
                        toggleLabel={showCategoryQuickAdd ? "Hide quick add" : "Add Category"}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                          <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} placeholder="New category" style={controlStyle} />
                          <button type="button" onClick={createCategory} disabled={saving || !newCategoryName.trim()}>
                            Add
                          </button>
                        </div>
                      </QuickAddInline>
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      <Field label="Group" help="Choose the more specific grouping inside the selected category.">
                        <select value={form.group_id} onChange={(e) => setField("group_id", e.target.value)} style={controlStyle}>
                          <option value="">-- Select group --</option>
                          {filteredGroupOptions.map((item) => (
                            <option key={item.id} value={String(item.id)}>
                              {item.group_name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <QuickAddInline
                        open={showGroupQuickAdd}
                        onToggle={() => setShowGroupQuickAdd((value) => !value)}
                        toggleLabel={showGroupQuickAdd ? "Hide quick add" : "Add Group"}
                      >
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                          <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="New group" disabled={!form.category_id} style={controlStyle} />
                          <button type="button" onClick={createGroup} disabled={saving || !form.category_id || !newGroupName.trim()}>
                            Add
                          </button>
                        </div>
                      </QuickAddInline>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      <Field label="Family Key" help="Explicit family for configurator and modular PDF.">
                        <select value={form.family_key || ""} onChange={(e) => setField("family_key", e.target.value)} style={controlStyle}>
                          <option value="">— None —</option>
                          <option value="NGEN">NGEN</option>
                          <option value="NGENX">NGENX</option>
                          <option value="MEDO">MEDO</option>
                          <option value="MEDO_C">MEDO_C</option>
                          <option value="IDOS">IDOS</option>
                          <option value="IDOS_C">IDOS_C</option>
                          <option value="SHIELD">SHIELD</option>
                        </select>
                      </Field>
                      <Field label="Module Role" help="Package section role (generator, air, storage, booster…).">
                        <select value={form.module_role || ""} onChange={(e) => setField("module_role", e.target.value)} style={controlStyle}>
                          <option value="">— None —</option>
                          <option value="generator">generator</option>
                          <option value="air_system">air_system</option>
                          <option value="gas_storage">gas_storage</option>
                          <option value="booster">booster</option>
                          <option value="shield">shield</option>
                          <option value="accessory">accessory</option>
                          <option value="spare">spare</option>
                          <option value="other">other</option>
                        </select>
                      </Field>
                      <Field label="Variant" help="nGEN variant HF / SH / UH.">
                        <select value={form.variant_key || ""} onChange={(e) => setField("variant_key", e.target.value)} style={controlStyle}>
                          <option value="">— None —</option>
                          <option value="HF">HF</option>
                          <option value="SH">SH</option>
                          <option value="UH">UH</option>
                        </select>
                      </Field>
                    </div>
                  </SectionBlock>

                  <div style={{ display: "grid", gap: 16 }}>
                    <SectionBlock title="Draft Compass" subtitle="Get the identity right before pricing, policy, and specs">
                      <div style={{ display: "grid", gap: 10 }}>
                        <FocusStrip
                          label="Classification"
                          value={selectedCategoryName && selectedGroupName ? `${selectedCategoryName} -> ${selectedGroupName}` : "Category and group still need confirmation"}
                          tone={selectedCategoryName && selectedGroupName ? "#eefbf3" : "#fff7ea"}
                          color={selectedCategoryName && selectedGroupName ? "#0b7d45" : "#8b5a00"}
                        />
                        <FocusStrip
                          label="Current Company"
                          value={currentCompanyLabel}
                          tone="#eef4ff"
                          color="#234a8f"
                        />
                        <FocusStrip
                          label="Next Step"
                          value="Finish Commercial and Specs here, then switch to Company or Intercompany pair for routing."
                          tone="#f6f7fb"
                          color="#546076"
                        />
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                        <button type="button" onClick={() => setEditorTab("commercial")}>
                          Go To Commercial
                        </button>
                        <button type="button" onClick={() => setOperatingModeSafe("company")} disabled={!form.id}>
                          Open Company Lens
                        </button>
                      </div>
                    </SectionBlock>

                    <SectionBlock title="Editor Snapshot" subtitle="Quick context while you build the product">
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        <MiniMetric label="Mode" value={form.id ? "Existing" : "New"} />
                        <MiniMetric label="Specs Ready" value={activeAttributeCount} />
                        <MiniMetric label="Source" value={sourcingModeLabel(form.sourcing_mode)} />
                        <MiniMetric label="Status" value={form.is_active ? "Active" : "Inactive"} />
                      </div>
                    </SectionBlock>
                  </div>
                </div>
              ) : null}

              {operatingMode === "catalog" && editorTab === "commercial" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 0.92fr", gap: 16, alignItems: "start" }}>
                  <SectionBlock title="Commercial Defaults" subtitle="Tax, pricing, and lifecycle controls used across the business">
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      <Field label="Stock UOM" help="Base unit used in stock, BOM, and transactional rows.">
                        <input value={form.uom} onChange={(e) => setField("uom", e.target.value)} style={controlStyle} />
                      </Field>
                      <Field label="HSN / SAC Code" help="Used for GST classification and invoicing alignment.">
                        <input value={form.hsn_no} onChange={(e) => setField("hsn_no", e.target.value)} style={controlStyle} />
                      </Field>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="Default List Price" help="Starting commercial rate before desk-specific negotiation.">
                        <input type="number" value={form.list_price} onChange={(e) => setField("list_price", e.target.value)} step="0.01" style={controlStyle} />
                      </Field>
                      <Field label="GST Rate %" help="Enter the rate only. The system applies the percentage where relevant.">
                        <input type="number" value={form.gst_pct} onChange={(e) => setField("gst_pct", e.target.value)} step="0.01" style={controlStyle} />
                      </Field>
                    </div>
                    <div style={{ display: "grid", gap: 10 }}>
                      <SegmentedBooleanRow label="Serial No Required" checked={form.serial_no_required} onChange={(checked) => setField("serial_no_required", checked)} />
                      <SegmentedBooleanRow label="Auto Generated" checked={form.is_auto_generated} onChange={(checked) => setField("is_auto_generated", checked)} />
                      <SegmentedBooleanRow label="Active" checked={form.is_active} onChange={(checked) => setField("is_active", checked)} />
                    </div>
                  </SectionBlock>

                  <SectionBlock title="Commercial Snapshot" subtitle="The most important defaults at a glance">
                    <div style={{ display: "grid", gap: 10 }}>
                      <FocusStrip label="UOM / HSN" value={`${form.uom || "No UOM"} • ${form.hsn_no || "No HSN"}`} tone="#f6f7fb" color="#546076" />
                      <FocusStrip label="Price / GST" value={`${form.list_price || "No price"} • GST ${form.gst_pct || "—"}`} tone="#eef4ff" color="#234a8f" />
                      <FocusStrip
                        label="Lifecycle"
                        value={`${form.is_active ? "Active" : "Inactive"} • ${form.serial_no_required ? "Serial tracked" : "No serial tracking"}`}
                        tone={form.is_active ? "#eefbf3" : "#fff7ea"}
                        color={form.is_active ? "#0b7d45" : "#8b5a00"}
                      />
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                      <button type="button" onClick={() => setEditorTab("specs")}>
                        Continue To Specs
                      </button>
                      <button type="button" onClick={() => setOperatingModeSafe("company")} disabled={!form.id}>
                        Open Company Lens
                      </button>
                    </div>
                  </SectionBlock>
                </div>
              ) : null}

              {operatingMode === "company" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1.08fr 0.92fr", gap: 16, alignItems: "start" }}>
                  <SectionBlock title="Company Policy" subtitle={`Operational behavior for ${policyCompanyLabel}`}>
                    <Field label="Company" help="Pick AT or AI (or any company) to edit that company's policy only.">
                      <select
                        value={policyCompanyId || String(activeCompanyId || "")}
                        onChange={(e) => selectPolicyCompany(e.target.value)}
                        style={controlStyle}
                      >
                        <option value="">-- Select company --</option>
                        {companies.map((item) => (
                          <option key={item.id} value={String(item.id)}>
                            {item.company_name || item.company_code || `Company ${item.id}`}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <div style={{ fontSize: 12, opacity: 0.72, marginBottom: 8 }}>
                      Shared catalog fields stay in Catalog mode. Saving here updates only {policyCompanyLabel}.
                    </div>
                    <PolicyGroup title="Routing">
                      <SegmentedBooleanRow
                        label="Treat As Manufactured FG?"
                        checked={form.is_manufactured}
                        onChange={(checked) => {
                          setField("is_manufactured", checked);
                          if (!checked) setField("mfg_job_prefix", "");
                        }}
                      />
                      <Field label="Fulfilment Route" help="Decide whether this item is bought, intercompany-sourced, manufactured, service-only, or blocked.">
                        <select
                          value={form.sourcing_mode}
                          onChange={(e) => {
                            const next = e.target.value;
                            setField("sourcing_mode", next);
                            if (next !== "buy_intercompany") setField("intercompany_source_company_id", "");
                            if (next !== "manufacture") {
                              setField("is_manufactured", false);
                              setField("mfg_job_prefix", "");
                            }
                          }}
                          style={controlStyle}
                        >
                          <option value="buy_external">Buy External</option>
                          <option value="buy_intercompany">Buy Intercompany</option>
                          <option value="manufacture">Manufacture</option>
                          <option value="service_only">Service Only</option>
                          <option value="blocked">Blocked</option>
                        </select>
                      </Field>
                      {form.sourcing_mode === "buy_intercompany" ? (
                        <Field label="Source Company" help="Pick the supplying company when fulfilment route is intercompany.">
                          <select
                            value={form.intercompany_source_company_id}
                            onChange={(e) => setField("intercompany_source_company_id", e.target.value)}
                            style={controlStyle}
                          >
                            <option value="">-- Select source company --</option>
                            {companies
                              .filter((item) => String(item.id) !== String(policyCompanyId || activeCompanyId || ""))
                              .map((item) => (
                                <option key={item.id} value={String(item.id)}>
                                  {item.company_name || item.company_code || `Company ${item.id}`}
                                </option>
                              ))}
                          </select>
                        </Field>
                      ) : null}
                    </PolicyGroup>

                    <PolicyGroup title="Commercial Permissions">
                      <div style={{ display: "grid", gap: 8 }}>
                        <SegmentedBooleanRow label="Saleable in this company" checked={form.is_saleable} onChange={(checked) => setField("is_saleable", checked)} />
                        <SegmentedBooleanRow label="Purchaseable in this company" checked={form.is_purchaseable} onChange={(checked) => setField("is_purchaseable", checked)} />
                        <SegmentedBooleanRow label="Stocked in this company" checked={form.is_stocked} onChange={(checked) => setField("is_stocked", checked)} />
                      </div>
                    </PolicyGroup>

                    <PolicyGroup title="Manufacturing Control">
                      <Field label="Manufacturing Job Prefix" help="Used to auto-build manufacturing job IDs and related machine serial patterns.">
                        <select
                          value={form.mfg_job_prefix}
                          onChange={(e) => setField("mfg_job_prefix", e.target.value)}
                          disabled={!form.is_manufactured || form.sourcing_mode !== "manufacture"}
                          style={controlStyle}
                        >
                          <option value="">-- Select prefix --</option>
                          <option value="M">M • Medical Oxygen</option>
                          <option value="N">N • Nitrogen</option>
                          <option value="ID">ID • Industrial Oxygen</option>
                        </select>
                      </Field>
                      <Field label="Internal Policy Notes" help="Use this for operational remarks that explain why the current company policy is set this way.">
                        <textarea rows={2} value={form.policy_remarks} onChange={(e) => setField("policy_remarks", e.target.value)} style={textAreaStyle} />
                      </Field>
                    </PolicyGroup>
                  </SectionBlock>

                  <SectionBlock title="Policy Snapshot" subtitle="See the routing outcome before saving">
                    <div style={{ display: "grid", gap: 10 }}>
                      <FocusStrip label="Ownership" value={editorOwnershipLabel} tone="#eef4ff" color="#234a8f" />
                      <FocusStrip
                        label="Sale / Purchase / Stock"
                        value={`${form.is_saleable ? "Saleable" : "Not saleable"} • ${form.is_purchaseable ? "Purchaseable" : "Not purchaseable"} • ${form.is_stocked ? "Stocked" : "Not stocked"}`}
                        tone="#f6f7fb"
                        color="#546076"
                      />
                      <FocusStrip
                        label="Manufacturing Prefix"
                        value={form.mfg_job_prefix || "No prefix selected"}
                        tone={form.mfg_job_prefix ? "#eefbf3" : "#fff7ea"}
                        color={form.mfg_job_prefix ? "#0b7d45" : "#8b5a00"}
                      />
                      {companyPolicies.length ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>All company policies</div>
                          {companyPolicies.map((row) => (
                            <FocusStrip
                              key={`${row.company_id}-${row.sourcing_mode}`}
                              label={row.company_code || row.company_name || `Company ${row.company_id}`}
                              value={sourcingModeLabel(row.sourcing_mode)}
                              tone={String(row.company_id) === String(policyCompanyId) ? "#eef4ff" : "#f6f7fb"}
                              color={String(row.company_id) === String(policyCompanyId) ? "#234a8f" : "#546076"}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                      <button type="button" onClick={() => setOperatingModeSafe("pair")} disabled={!form.id}>
                        Open Intercompany Pair
                      </button>
                    </div>
                  </SectionBlock>
                </div>
              ) : null}

              {operatingMode === "pair" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1.08fr 0.92fr", gap: 16, alignItems: "start" }}>
                  <SectionBlock title="Intercompany Pair" subtitle="Manufacturer manufactures; buyer buys intercompany from that manufacturer">
                    {!form.id ? (
                      <div style={{ padding: 12, borderRadius: 10, background: "#fff7ea", border: "1px solid #f0d9a8", marginBottom: 12 }}>
                        Save the shared catalog product first, then set the AT↔AI pair in one action.
                      </div>
                    ) : null}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="Manufacturer company" help="Defaults to AI when available.">
                        <select
                          value={pairForm.manufacturer_company_id}
                          onChange={(e) => setPairForm((prev) => ({ ...prev, manufacturer_company_id: e.target.value }))}
                          style={controlStyle}
                        >
                          <option value="">-- Select manufacturer --</option>
                          {companies.map((item) => (
                            <option key={item.id} value={String(item.id)}>
                              {item.company_name || item.company_code || `Company ${item.id}`}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Buyer company" help="Defaults to AT when available.">
                        <select
                          value={pairForm.buyer_company_id}
                          onChange={(e) => setPairForm((prev) => ({ ...prev, buyer_company_id: e.target.value }))}
                          style={controlStyle}
                        >
                          <option value="">-- Select buyer --</option>
                          {companies.map((item) => (
                            <option key={item.id} value={String(item.id)}>
                              {item.company_name || item.company_code || `Company ${item.id}`}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <Field label="Manufacturer job prefix">
                      <select
                        value={pairForm.manufacturer_mfg_job_prefix}
                        onChange={(e) => setPairForm((prev) => ({ ...prev, manufacturer_mfg_job_prefix: e.target.value }))}
                        style={controlStyle}
                      >
                        <option value="M">M • Medical Oxygen</option>
                        <option value="N">N • Nitrogen</option>
                        <option value="ID">ID • Industrial Oxygen</option>
                      </select>
                    </Field>
                    <PolicyGroup title="Optional saleable flags">
                      <SegmentedBooleanRow
                        label="Manufacturer saleable"
                        checked={pairForm.manufacturer_is_saleable}
                        onChange={(checked) => setPairForm((prev) => ({ ...prev, manufacturer_is_saleable: checked }))}
                      />
                      <SegmentedBooleanRow
                        label="Buyer saleable"
                        checked={pairForm.buyer_is_saleable}
                        onChange={(checked) => setPairForm((prev) => ({ ...prev, buyer_is_saleable: checked }))}
                      />
                      <SegmentedBooleanRow
                        label="Buyer purchaseable"
                        checked={pairForm.buyer_is_purchaseable}
                        onChange={(checked) => setPairForm((prev) => ({ ...prev, buyer_is_purchaseable: checked }))}
                      />
                      <SegmentedBooleanRow
                        label="Buyer stocked"
                        checked={pairForm.buyer_is_stocked}
                        onChange={(checked) => setPairForm((prev) => ({ ...prev, buyer_is_stocked: checked }))}
                      />
                    </PolicyGroup>
                  </SectionBlock>

                  <SectionBlock title="Pair Preview" subtitle="What one Save will write">
                    <div style={{ display: "grid", gap: 10 }}>
                      <FocusStrip
                        label="Manufacturer"
                        value={`${companies.find((c) => String(c.id) === String(pairForm.manufacturer_company_id))?.company_code || "—"} → Manufacture (${pairForm.manufacturer_mfg_job_prefix || "N"})`}
                        tone="#eefbf3"
                        color="#0b7d45"
                      />
                      <FocusStrip
                        label="Buyer"
                        value={`${companies.find((c) => String(c.id) === String(pairForm.buyer_company_id))?.company_code || "—"} → Buy intercompany from manufacturer`}
                        tone="#eef4ff"
                        color="#234a8f"
                      />
                      {needsIcPairHint ? (
                        <FocusStrip label="Checklist" value="Current policies look incomplete — save the pair to align both sides." tone="#fff7ea" color="#8b5a00" />
                      ) : companyPolicies.length ? (
                        <FocusStrip label="Checklist" value="Existing manufacture / IC policies already present for this SKU." tone="#eefbf3" color="#0b7d45" />
                      ) : (
                        <FocusStrip label="Checklist" value="No company policies loaded yet for this SKU." tone="#f6f7fb" color="#546076" />
                      )}
                    </div>
                  </SectionBlock>
                </div>
              ) : null}

              {operatingMode === "catalog" && editorTab === "specs" ? (
                <div style={{ display: "grid", gap: 16 }}>
                  <SectionBlock
                    title="Specification Attributes"
                    subtitle="Maintain captions and values without losing focus in the larger editor"
                    actions={
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {isOxygenCategory ? (
                          <button type="button" onClick={() => addSuggestedAttributes(OXYGEN_ATTRIBUTE_PRESET)}>
                            Insert Oxygen Caption Set
                          </button>
                        ) : null}
                        <button type="button" onClick={addAttributeRow}>
                          Add Attribute
                        </button>
                      </div>
                    }
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 12, marginBottom: 14 }}>
                      <div style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 12, background: "#fbfcff" }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>Bulk Add Helper</div>
                        <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginBottom: 8 }}>
                          Paste one spec per line using `Caption: Value`, `Caption=Value`, or tab-separated pairs.
                        </div>
                        <textarea
                          rows={6}
                          value={bulkSpecText}
                          onChange={(e) => setBulkSpecText(e.target.value)}
                          placeholder={"PURITY: 93 +/- 3%\nFLOW: 10 Nm3/hr\nDRY AIR REQUIRED: Yes"}
                          style={textAreaStyle}
                        />
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                          <button type="button" onClick={applyBulkAttributes} disabled={!bulkSpecText.trim()}>
                            Add Lines To Specs
                          </button>
                          {bulkSpecText.trim() ? (
                            <button type="button" onClick={() => setBulkSpecText("")}>
                              Clear Paste Box
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 12, background: "#fbfcff" }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>Spec Workflow</div>
                        <div style={{ display: "grid", gap: 8 }}>
                          <FocusStrip label="Rows In Draft" value={`${form.attributes.length} total • ${activeAttributeCount} filled`} tone="#eef4ff" color="#234a8f" />
                          <FocusStrip label="Fast Path" value="Paste common captions in bulk, then refine the rows below." tone="#f6f7fb" color="#546076" />
                          <FocusStrip label="Best Use" value="Ideal for Oxygen packages, machine specs, and repeated catalog imports." tone="#eefbf3" color="#0b7d45" />
                        </div>
                      </div>
                    </div>
                    {isOxygenCategory ? (
                      <div style={{ marginBottom: 10, fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                        Preferred Oxygen captions: `PURITY`, `FLOW`, `DRY AIR REQUIRED`, `RECOMMENDED OXYGEN STORAGE`,
                        `RECOMMENDED AIR RECEIVER`.
                      </div>
                    ) : null}
                    <div style={{ display: "grid", gap: 10 }}>
                      {form.attributes.map((attr, index) => (
                        <div key={attr.key} style={{ border: "1px solid #eef2f7", borderRadius: 14, padding: 12, background: "#fcfdff" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
                            <strong>Attribute {index + 1}</strong>
                            <button type="button" onClick={() => removeAttributeRow(index)} disabled={form.attributes.length === 1}>
                              Remove
                            </button>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10 }}>
                            <Field label="Spec Caption" help="Short technical heading, for example PURITY or FLOW.">
                              <input value={attr.caption} onChange={(e) => setAttribute(index, "caption", e.target.value)} style={controlStyle} />
                            </Field>
                            <Field label="Spec Value" help="Technical value or explanatory text shown against the caption.">
                              <input value={attr.spec_value} onChange={(e) => setAttribute(index, "spec_value", e.target.value)} style={controlStyle} />
                            </Field>
                          </div>
                        </div>
                      ))}
                    </div>
                  </SectionBlock>
                </div>
              ) : null}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: 16,
                borderTop: "1px solid #eef2f7",
                background: "#fbfcff",
                position: "sticky",
                bottom: 0,
              }}
            >
              <div style={{ display: "grid", gap: 6, alignSelf: "center" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <MicroChip label={footerState.label} tone={footerState.tone} color={footerState.color} />
                  <MicroChip
                    label={saveBlockers.length ? `${saveBlockers.length} blocker${saveBlockers.length === 1 ? "" : "s"}` : "Ready to save"}
                    tone={saveBlockers.length ? "#fff7ea" : "#eefbf3"}
                    color={saveBlockers.length ? "#8b5a00" : "#0b7d45"}
                  />
                  <MicroChip label={lastSavedLabel} tone="#f6f7fb" color="#546076" />
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {saveBlockers.length
                    ? `Complete before saving: ${saveBlockers.join(", ")}.`
                    : operatingMode === "pair"
                      ? "Ready to save the manufacturer + buyer policy pair in one action."
                      : operatingMode === "company"
                        ? `Ready to save ${policyCompanyLabel} policy only. Shared SKU stays unchanged.`
                        : hasUnsavedChanges
                          ? "Catalog changes are ready to save. Company policies will not be overwritten."
                          : form.id
                            ? "No unsaved catalog changes right now."
                            : "This is a new draft. Save shared identity first, then set Company or Intercompany pair."}
                </div>
                <div style={{ fontSize: 11, opacity: 0.58 }}>
                  Keyboard: `Alt+1..3` catalog tabs, `Alt+Shift+1..3` operations tabs, `Alt+E` editor, `Alt+O` operations.
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={startNew}>
                  Start Fresh
                </button>
                <button type="button" onClick={save} disabled={saving || saveBlockers.length > 0}>
                  {saving
                    ? "Saving..."
                    : operatingMode === "pair"
                      ? "Save Intercompany Pair"
                      : operatingMode === "company"
                        ? "Save Company Policy"
                        : form.id
                          ? "Save Shared Catalog"
                          : "Create Product Record"}
                </button>
              </div>
            </div>
          </div>
        </div>
        </div>

        {form.id ? (
          <div style={{ display: "grid", gap: 14, marginBottom: 18 }}>
            {canViewDrive(me, "model_asset") ? (
              <DriveFilesPanel
                me={me}
                category="model_asset"
                productId={form.id}
                title="Machine & model assets"
                subtitle="GA drawings, P&ID, and technical sheets. Sales and Service may preview; only Engineering can upload."
                accept=".pdf,.png,.jpg,.jpeg,.webp,.dwg,.dxf"
              />
            ) : null}
            {canViewDrive(me, "marketing_collateral") ? (
              <DriveFilesPanel
                me={me}
                category="marketing_collateral"
                productId={form.id}
                title="Marketing collateral"
                subtitle="Brochures and videos for this model. Sales may preview/attach; only Marketing can upload."
                accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.ppt,.pptx"
              />
            ) : null}
          </div>
        ) : null}

        <SectionCard
          sectionRef={operationsSectionRef}
          title="Operations Dock"
          subtitle="Bulk workbook flow, maintenance utilities, and manufacturing readiness without crowding the editor"
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <WorkspaceTabButton label="Import" active={workspaceTab === "import"} onClick={() => setWorkspaceTab("import")} onMove={moveWorkspaceTab} />
              <WorkspaceTabButton label="Maintenance" active={workspaceTab === "maintenance"} onClick={() => setWorkspaceTab("maintenance")} onMove={moveWorkspaceTab} />
              <WorkspaceTabButton label="Readiness" active={workspaceTab === "readiness"} onClick={() => setWorkspaceTab("readiness")} onMove={moveWorkspaceTab} />
              <button type="button" onClick={() => editorSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                Jump To Editor
              </button>
            </div>
          }
        >
          <div style={{ fontSize: 12, opacity: 0.64, marginBottom: 12 }}>
            Keyboard: `Alt+Shift+1..3` switches these tabs. `Alt+O` jumps here from anywhere in Product Master.
          </div>
          {workspaceTab === "import" ? (
            <div style={{ display: "grid", gridTemplateColumns: "0.95fr 1.05fr", gap: 16 }}>
              <div style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 14, background: "#fcfdff" }}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>Workbook Flow</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  <MicroChip label="Shared catalog columns" tone="#eef4ff" color="#234a8f" />
                  <MicroChip label="Per-company policy columns" tone="#eefbf3" color="#0b7d45" />
                  <MicroChip label="XLSX recommended" tone="#f6f7fb" color="#546076" />
                </div>
                <Field
                  label="Import File"
                  help="One workbook, two layers: shared catalog columns (item code, name, category, commercial defaults, specs) and per-company policy columns (company, sourcing mode, IC source, saleable flags). CSV still works for shared product rows only."
                >
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={(e) => {
                      setImportFile(e.target.files?.[0] || null);
                      setImportPreview(null);
                    }}
                  />
                </Field>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginBottom: 10 }}>
                  {importFile
                    ? `Selected file: ${importFile.name}`
                    : "Download the blank guided workbook to start fresh, or download the current Product Master to edit existing database data offline."}
                </div>
                <div style={{ padding: 10, borderRadius: 10, background: "#fff7ea", border: "1px solid #f0d9a8", fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
                  IC pair checklist: when a buyer row uses Buy Intercompany, also include a Manufacture policy row for the source company (or set the pair in the Intercompany pair editor after import).
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => window.open(`/products/admin/import/template?v=${Date.now()}`, "_blank", "noopener,noreferrer")} disabled={importing}>
                    Download Blank Guided XLSX
                  </button>
                  <button type="button" onClick={downloadCurrentWorkbook} disabled={importing}>
                    Download Current Product Master
                  </button>
                  <button type="button" onClick={previewImport} disabled={importing || !importFile}>
                    {importing ? "Reviewing..." : "Review File"}
                  </button>
                  <button type="button" onClick={() => setApplyConfirmOpen(true)} disabled={importing || !importFile}>
                    {importing ? "Applying..." : "Apply Upload"}
                  </button>
                </div>
                {dupGroups.length ? (
                  <div style={{ marginTop: 14, border: "1px solid #e2e8f0", borderRadius: 10, padding: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Duplicate name watch ({dupGroups.length} groups)</div>
                    {dupGroups.slice(0, 8).map((group) => (
                      <div key={group.name_key} style={{ fontSize: 12, marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #f1f5f9" }}>
                        <div style={{ opacity: 0.7 }}>{group.name_key}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                          {(group.products || []).map((p) => (
                            <span key={p.id} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "2px 8px" }}>
                              {p.item_code}
                            </span>
                          ))}
                          {(group.products || []).length >= 2 ? (
                            <button
                              type="button"
                              disabled={mergeBusy}
                              onClick={() => previewProductMerge(group.products[1].id, group.products[0].id)}
                            >
                              Merge 2nd → 1st
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <button type="button" style={{ marginTop: 10 }} onClick={loadDuplicates}>
                    Scan duplicate product names
                  </button>
                )}
              </div>

              <div style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 14, background: "#fcfdff" }}>
                <div style={{ fontWeight: 800, marginBottom: 10 }}>Preview Console</div>
                {importPreview ? (
                  <div style={{ display: "grid", gap: 12 }}>
                    <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                      Import mode: {String(importPreview.format || "xlsx").toUpperCase()}
                      {Array.isArray(importPreview.sheet_names) && importPreview.sheet_names.length
                        ? ` • Sheets found: ${importPreview.sheet_names.join(", ")}`
                        : ""}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
                      {String(importPreview.format || "").toLowerCase() === "csv"
                        ? "CSV fallback detected. Only shared catalog (product) rows will be reviewed and loaded from this file."
                        : "Guided workbook detected. Preview is split into shared catalog rows vs per-company policy rows below."}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div style={{ border: "1px solid #c5d5f5", borderRadius: 12, padding: 10, background: "#f7faff" }}>
                        <div style={{ fontWeight: 800, marginBottom: 4 }}>Shared catalog</div>
                        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>Item identity, commercial defaults, specs</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Rows Checked" value={importPreview.products?.total_rows || 0} />
                          <MiniMetric label="Will Add" value={importPreview.products?.creates || 0} />
                          <MiniMetric label="Will Update" value={importPreview.products?.updates || 0} />
                          <MiniMetric label="Held Back" value={importPreview.products?.skipped || 0} />
                        </div>
                        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                          {buildProductPreviewNote(importPreview.products)}
                        </div>
                      </div>
                      <div style={{ border: "1px solid #b9e4c8", borderRadius: 12, padding: 10, background: "#f4fff8" }}>
                        <div style={{ fontWeight: 800, marginBottom: 4 }}>Per-company policy</div>
                        <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>Sourcing mode, IC source, saleable / stocked flags</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                          <MiniMetric label="Rows Checked" value={importPreview.company_policies?.total_rows || 0} />
                          <MiniMetric label="Will Add" value={importPreview.company_policies?.creates || 0} />
                          <MiniMetric label="Will Update" value={importPreview.company_policies?.updates || 0} />
                          <MiniMetric label="Held Back" value={importPreview.company_policies?.skipped || 0} />
                        </div>
                        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                          {buildCompanyPolicyPreviewNote(importPreview.company_policies)}
                        </div>
                        {Number(importPreview.company_policies?.incomplete_ic_pair_rows) > 0 ? (
                          <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: "#fff7ea", border: "1px solid #f0d9a8", fontSize: 12, lineHeight: 1.5 }}>
                            IC pair tip: {importPreview.company_policies.incomplete_ic_pair_rows} buy-intercompany row(s) lack a matching manufacture policy on the source company.
                            {(importPreview.company_policies.incomplete_ic_pair_samples || []).slice(0, 2).map((sample) => (
                              <div key={`${sample.item_code}-${sample.buyer_company}`}>
                                {sample.item_code}: {sample.buyer_company} ← {sample.source_company || "source"}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.7 }}>
                    Review shared catalog vs company-policy layers here before applying. Mandatory field issues, duplicate keys, and incomplete IC pairs
                    will appear in this preview console.
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {workspaceTab === "maintenance" ? (
            <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16 }}>
              <div style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 14, background: "#fcfdff" }}>
                <div style={{ fontWeight: 800, marginBottom: 8 }}>Maintenance Helper</div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginBottom: 10 }}>
                  Backfills missing `RECOMMENDED OXYGEN STORAGE` and `RECOMMENDED AIR RECEIVER` captions into existing Oxygen products
                  using the current model package map. Existing values are preserved.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={runOxygenPackageAudit} disabled={maintenanceBusy || importing || saving}>
                    {maintenanceBusy ? "Working..." : "Audit Oxygen Readiness"}
                  </button>
                  <button type="button" onClick={runOxygenPackageBackfill} disabled={maintenanceBusy || importing || saving}>
                    {maintenanceBusy ? "Working..." : "Backfill Oxygen Package Captions"}
                  </button>
                </div>
              </div>

              <div style={{ border: "1px solid #edf1f6", borderRadius: 16, padding: 14, background: "#fcfdff" }}>
                {oxygenAudit ? (
                  <div style={{ display: "grid", gap: 12 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="Active Oxygen" value={oxygenAudit.active_products || 0} />
                      <MiniMetric label="Matched" value={oxygenAudit.matched_products || 0} />
                      <MiniMetric label="Ready" value={oxygenAudit.ready_products || 0} />
                      <MiniMetric label="Missing" value={oxygenAudit.missing_products || 0} />
                      <MiniMetric label="Unmatched" value={oxygenAudit.unmatched_products || 0} />
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6 }}>
                      {oxygenAudit.missing_products
                        ? "Fallback cannot be removed yet. Run backfill, then re-audit until missing captions become 0."
                        : "All matched Oxygen products carry the preferred captions. Runtime fallback removal is now safer."}
                    </div>
                    {oxygenAudit.samples?.length ? (
                      <div style={{ display: "grid", gap: 8 }}>
                        {oxygenAudit.samples.map((item) => (
                          <div key={item.product_id} style={{ border: "1px solid #edf1f6", borderRadius: 10, padding: 10, background: "#ffffff" }}>
                            <div style={{ fontWeight: 700 }}>{item.item_name || item.item_code}</div>
                            <div style={{ fontSize: 12, opacity: 0.72 }}>{item.item_code || "—"}</div>
                            <div style={{ fontSize: 12, marginTop: 4 }}>
                              Missing: {Array.isArray(item.missing_captions) ? item.missing_captions.join(", ") : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, opacity: 0.72 }}>Run the oxygen audit to inspect caption readiness.</div>
                )}
              </div>
            </div>
          ) : null}

          {workspaceTab === "readiness" ? (
            manufacturingAudit ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, marginBottom: 12 }}>
                  <MiniMetric label="Candidates" value={manufacturingAudit.total_candidates || 0} />
                  <MiniMetric label="Ready" value={manufacturingAudit.ready_count || 0} />
                  <MiniMetric label="Missing FG Flag" value={manufacturingAudit.missing_fg_flag_count || 0} />
                  <MiniMetric label="Missing Prefix" value={manufacturingAudit.missing_prefix_count || 0} />
                  <MiniMetric label="Missing BOM" value={manufacturingAudit.missing_bom_count || 0} />
                </div>
                <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6, marginBottom: 10 }}>
                  {manufacturingAudit.audit_company_id
                    ? `Audit is using the selected company context for BOM coverage.`
                    : `Audit is showing global FG setup; select a company if you want company-specific BOM coverage.`}
                </div>
                {manufacturingAudit.samples?.length ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    {manufacturingAudit.samples.map((item) => (
                      <div key={item.product_id} style={{ border: "1px solid #edf1f6", borderRadius: 12, padding: 12, background: "#fafcff", display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                          <div>
                            <div style={{ fontWeight: 800 }}>{item.item_code || "—"} • {item.item_name || "Unnamed product"}</div>
                            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
                              {item.category_name || "No category"} • {item.group_name || "No group"}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {item.is_manufactured ? <MicroChip label="Manufactured FG" tone="#fff6e8" color="#8b5a00" /> : <MicroChip label="FG Flag Missing" tone="#fff3f3" color="#b00020" />}
                            <MicroChip label={`Prefix ${item.mfg_job_prefix || "Missing"}`} tone={item.mfg_job_prefix ? "#eef4ff" : "#fff3f3"} color={item.mfg_job_prefix ? "#234a8f" : "#b00020"} />
                            <MicroChip label={`Active BOM ${item.active_bom_count || 0}`} tone={item.active_bom_count ? "#f2fff6" : "#fff7ea"} color={item.active_bom_count ? "#0b7d45" : "#8b5a00"} />
                          </div>
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.78 }}>{item.note}</div>
                        <div>
                          <button type="button" onClick={() => editProduct(item.product_id)}>
                            Open In Editor
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: 14, borderRadius: 12, background: "#f2fff6", border: "1px solid #d6f4df", color: "#0a7a35" }}>
                    All currently audited manufacturing candidates look ready.
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, opacity: 0.72 }}>
                Run the manufacturing audit to see setup gaps.
              </div>
            )
          ) : null}
        </SectionCard>
      </div>

      <TypedConfirmModal
        open={applyConfirmOpen}
        title="Apply Product Master upload"
        message="This writes/updates live product rows from the workbook. Type APPLY UPLOAD to continue."
        confirmPhrase="APPLY UPLOAD"
        confirmLabel="Apply upload"
        busy={importing}
        onCancel={() => setApplyConfirmOpen(false)}
        onConfirm={applyImport}
      />
      <TypedConfirmModal
        open={mergeConfirmOpen}
        title="Merge products"
        message={
          mergePreview
            ? `Merge ${mergePreview.source_product?.item_code} into ${mergePreview.target_product?.item_code} (${mergePreview.reference_total || 0} refs). Type the source item code.`
            : null
        }
        confirmPhrase={String(mergePreview?.confirm_phrase || mergePreview?.source_product?.item_code || "MERGE").trim()}
        confirmLabel="Merge permanently"
        busy={mergeBusy}
        onCancel={() => {
          setMergeConfirmOpen(false);
          setMergePreview(null);
        }}
        onConfirm={executeProductMerge}
      />
    </div>
  );
}

function SectionCard({ sectionRef, title, subtitle, actions, children }) {
  return (
    <div
      ref={sectionRef}
      className="product-master-section-card"
      style={{
        border: "1px solid #bcc9da",
        borderRadius: 16,
        padding: 12,
        background: "linear-gradient(180deg, #ffffff 0%, #f8fbfe 100%)",
        boxShadow: "0 10px 24px rgba(13, 24, 43, 0.09)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 17, color: "#122033" }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 12, color: "#627088", marginTop: 3, lineHeight: 1.5 }}>{subtitle}</div> : null}
        </div>
        {actions || null}
      </div>
      {children}
    </div>
  );
}

function SectionBlock({ title, subtitle, actions, children }) {
  return (
    <div style={{ border: "1px solid #d7e0ec", borderRadius: 12, padding: 12, background: "linear-gradient(180deg, #ffffff 0%, #fafcff 100%)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 800, color: "#132236" }}>{title}</div>
          {subtitle ? <div style={{ fontSize: 11, color: "#68748a", marginTop: 3, lineHeight: 1.5 }}>{subtitle}</div> : null}
        </div>
        {actions || null}
      </div>
      {children}
    </div>
  );
}

function PolicyGroup({ title, children }) {
  return (
    <div style={{ border: "1px solid #d7e0ec", borderRadius: 10, padding: 10, background: "linear-gradient(180deg, #f9fbfe 0%, #f2f6fb 100%)" }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "#60718f", marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

function StatusPill({ active }) {
  return <BoolStatusChip active={active} />;
}

function InlineMeta({ label, value }) {
  return (
    <div style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
      <span style={{ opacity: 0.62 }}>{label}</span>
      <strong style={{ color: "#263247" }}>{value}</strong>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 12px",
        border: "1px solid #edf1f6",
        borderRadius: 12,
        background: checked ? "#f8fbff" : "#ffffff",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function SegmentedBooleanRow({ label, checked, onChange }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 10px",
        border: "1px solid #d4deea",
        borderRadius: 10,
        background: "linear-gradient(180deg, #ffffff 0%, #f9fbfe 100%)",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 700, color: "#1d2b40" }}>{label}</span>
      <div style={{ display: "inline-flex", border: "1px solid #bccade", borderRadius: 999, overflow: "hidden", background: "#edf2f8" }}>
        <button
          type="button"
          onClick={() => onChange(true)}
          style={{
            border: "none",
            background: checked ? "#234a8f" : "transparent",
            color: checked ? "#ffffff" : "#546076",
            padding: "7px 14px",
            fontWeight: 700,
          }}
        >
          Yes
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          style={{
            border: "none",
            background: checked ? "transparent" : "#44516b",
            color: "#ffffff",
            padding: "7px 14px",
            fontWeight: 700,
          }}
        >
          No
        </button>
      </div>
    </div>
  );
}

function QuickAddInline({ open, onToggle, toggleLabel, children }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div>
        <button type="button" onClick={onToggle}>
          {toggleLabel}
        </button>
      </div>
      {open ? (
        <div style={{ border: "1px dashed #b8c7dd", borderRadius: 10, padding: 8, background: "#f6f9fd" }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceTabButton({ label, active, onClick, onMove }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          onMove?.(1);
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          onMove?.(-1);
        }
      }}
      style={{
        border: active ? "1px solid #6e8fcb" : "1px solid #c5d1e1",
        background: active ? "linear-gradient(180deg, #e5eefc 0%, #f3f7ff 100%)" : "linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%)",
        color: active ? "#183a74" : "#44516b",
        borderRadius: 999,
        padding: "7px 12px",
        fontWeight: 700,
        boxShadow: active ? "inset 0 1px 0 rgba(255,255,255,0.9)" : "none",
      }}
    >
      {label}
    </button>
  );
}

function EditorTabButton({ label, active, onClick, onMove }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          onMove?.(1);
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          onMove?.(-1);
        }
      }}
      style={{
        border: active ? "1px solid #6e8fcb" : "1px solid #c5d1e1",
        background: active ? "linear-gradient(180deg, #e5eefc 0%, #f3f7ff 100%)" : "linear-gradient(180deg, #ffffff 0%, #f7f9fc 100%)",
        color: active ? "#183a74" : "#44516b",
        borderRadius: 999,
        padding: "7px 12px",
        fontWeight: 700,
        boxShadow: active ? "inset 0 1px 0 rgba(255,255,255,0.9)" : "none",
      }}
    >
      {label}
    </button>
  );
}

function FocusStrip({ label, value, tone, color }) {
  return (
    <div
      style={{
        border: "1px solid #d4deea",
        borderRadius: 10,
        padding: "8px 10px",
        background: tone || "#ffffff",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.85)",
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "#627088", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: color || "#263247" }}>{value}</div>
    </div>
  );
}
