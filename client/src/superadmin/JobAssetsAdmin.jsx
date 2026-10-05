import { useEffect, useMemo, useState } from "react";

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

const ASSET_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "scrapped", label: "Scrapped" },
];

const SOURCE_KIND_OPTIONS = [
  { value: "manufacturing_bom", label: "Manufacturing BOM" },
  { value: "manual_snapshot", label: "Manual Snapshot" },
  { value: "imported_bom", label: "Imported BOM" },
  { value: "field_override", label: "Field Override" },
];

const MAPPING_TYPE_OPTIONS = [
  { value: "consumable", label: "Consumable" },
  { value: "spare", label: "Spare" },
  { value: "service_kit", label: "Service Kit" },
  { value: "replacement", label: "Replacement" },
];

function emptyAsset() {
  return {
    id: null,
    customer_id: "",
    sales_order_id: "",
    dispatch_id: "",
    job_card_id: "",
    asset_status: "active",
    job_id: "",
    serial_no: "",
    asset_code: "",
    asset_name: "",
    finished_good_product_id: "",
    installation_date: "",
    commissioning_date: "",
    warranty_start_date: "",
    warranty_end_date: "",
    site_name: "",
    site_address: "",
    remarks: "",
  };
}

function emptyBomLine(jobAssetId = "") {
  return {
    id: null,
    job_asset_id: jobAssetId ? String(jobAssetId) : "",
    bom_id: "",
    line_no: "",
    installed_product_id: "",
    installed_item_code: "",
    installed_item_name: "",
    uom: "",
    qty_installed: "1",
    remarks: "",
    source_kind: "manual_snapshot",
  };
}

function emptyMapping() {
  return {
    id: null,
    parent_product_id: "",
    replacement_product_id: "",
    mapping_type: "consumable",
    qty_per_parent: "1",
    is_recommended: true,
    is_mandatory: false,
    service_interval_hours: "",
    service_interval_days: "",
    notes: "",
    is_active: true,
  };
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export default function JobAssetsAdmin() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeSection, setActiveSection] = useState("assets");
  const [bootstrap, setBootstrap] = useState({
    active_company_id: null,
    companies: [],
    customers: [],
    products: [],
    sales_orders: [],
    dispatches: [],
    job_cards: [],
    manufacturing_boms: [],
    job_assets: [],
    aftermarket_mappings: [],
  });
  const [assetQuery, setAssetQuery] = useState("");
  const [mappingQuery, setMappingQuery] = useState("");
  const [selectedJobAssetId, setSelectedJobAssetId] = useState("");
  const [assetForm, setAssetForm] = useState(emptyAsset());
  const [bomLineForm, setBomLineForm] = useState(emptyBomLine());
  const [mappingForm, setMappingForm] = useState(emptyMapping());
  const [bomLinesLoading, setBomLinesLoading] = useState(false);
  const [bomLines, setBomLines] = useState([]);

  const activeCompany = useMemo(
    () => bootstrap.companies.find((item) => String(item.id) === String(bootstrap.active_company_id)) || null,
    [bootstrap.active_company_id, bootstrap.companies]
  );

  const selectedAssetRecord = useMemo(
    () => bootstrap.job_assets.find((item) => String(item.id) === String(selectedJobAssetId)) || null,
    [bootstrap.job_assets, selectedJobAssetId]
  );

  const productOptions = useMemo(
    () =>
      bootstrap.products.map((item) => ({
        value: String(item.id),
        label: `${item.item_code || "—"} - ${item.item_name || "Unnamed product"}`,
        product: item,
      })),
    [bootstrap.products]
  );

  const filteredAssetRows = useMemo(() => {
    const q = assetQuery.trim().toLowerCase();
    if (!q) return bootstrap.job_assets;
    return bootstrap.job_assets.filter((item) =>
      [
        item.job_id,
        item.serial_no,
        item.asset_code,
        item.asset_name,
        item.customer_name,
        item.finished_good_item_code,
        item.finished_good_item_name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [assetQuery, bootstrap.job_assets]);

  const filteredMappingRows = useMemo(() => {
    const q = mappingQuery.trim().toLowerCase();
    if (!q) return bootstrap.aftermarket_mappings;
    return bootstrap.aftermarket_mappings.filter((item) =>
      [
        item.parent_item_code,
        item.parent_item_name,
        item.replacement_item_code,
        item.replacement_item_name,
        item.mapping_type,
        item.notes,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [bootstrap.aftermarket_mappings, mappingQuery]);

  const filteredSalesOrders = useMemo(
    () =>
      bootstrap.sales_orders.filter((item) => !assetForm.customer_id || String(item.customer_id) === String(assetForm.customer_id)),
    [assetForm.customer_id, bootstrap.sales_orders]
  );

  const filteredDispatches = useMemo(
    () =>
      bootstrap.dispatches.filter((item) => {
        if (assetForm.customer_id && String(item.customer_id) !== String(assetForm.customer_id)) return false;
        if (assetForm.sales_order_id && String(item.sales_order_id || "") !== String(assetForm.sales_order_id)) return false;
        return true;
      }),
    [assetForm.customer_id, assetForm.sales_order_id, bootstrap.dispatches]
  );

  const filteredJobCards = useMemo(
    () =>
      bootstrap.job_cards.filter((item) => {
        if (assetForm.sales_order_id && String(item.sales_order_id || "") !== String(assetForm.sales_order_id)) return false;
        if (assetForm.finished_good_product_id && String(item.finished_good_product_id || "") !== String(assetForm.finished_good_product_id)) return false;
        return true;
      }),
    [assetForm.finished_good_product_id, assetForm.sales_order_id, bootstrap.job_cards]
  );

  const filteredBomOptions = useMemo(
    () =>
      bootstrap.manufacturing_boms.filter((item) => {
        const productId = selectedAssetRecord?.finished_good_product_id || assetForm.finished_good_product_id;
        if (!productId) return true;
        return String(item.finished_good_product_id) === String(productId);
      }),
    [bootstrap.manufacturing_boms, selectedAssetRecord?.finished_good_product_id, assetForm.finished_good_product_id]
  );

  const currentAssetBomCount = selectedAssetRecord?.bom_line_count || bomLines.length;
  const recommendedMappingCount = bootstrap.aftermarket_mappings.filter((item) => item.is_recommended).length;

  async function loadAll(preferredAssetId = null) {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/job-assets-admin/bootstrap");
      setBootstrap({
        active_company_id: data?.active_company_id || null,
        companies: Array.isArray(data?.companies) ? data.companies : [],
        customers: Array.isArray(data?.customers) ? data.customers : [],
        products: Array.isArray(data?.products) ? data.products : [],
        sales_orders: Array.isArray(data?.sales_orders) ? data.sales_orders : [],
        dispatches: Array.isArray(data?.dispatches) ? data.dispatches : [],
        job_cards: Array.isArray(data?.job_cards) ? data.job_cards : [],
        manufacturing_boms: Array.isArray(data?.manufacturing_boms) ? data.manufacturing_boms : [],
        job_assets: Array.isArray(data?.job_assets) ? data.job_assets : [],
        aftermarket_mappings: Array.isArray(data?.aftermarket_mappings) ? data.aftermarket_mappings : [],
      });
      const nextAssetId = preferredAssetId || selectedJobAssetId;
      const nextRows = Array.isArray(data?.job_assets) ? data.job_assets : [];
      setSelectedJobAssetId((prev) => {
        if (nextAssetId && nextRows.some((item) => String(item.id) === String(nextAssetId))) return String(nextAssetId);
        if (prev && nextRows.some((item) => String(item.id) === String(prev))) return prev;
        return nextRows[0]?.id ? String(nextRows[0].id) : "";
      });
    } catch (e) {
      setError(e?.data?.error || "Failed to load Job Asset Admin.");
    } finally {
      setLoading(false);
    }
  }

  async function loadBomLines(jobAssetId) {
    const id = Number(jobAssetId);
    if (!Number.isFinite(id) || id <= 0) {
      setBomLines([]);
      setBomLineForm(emptyBomLine());
      return;
    }
    setBomLinesLoading(true);
    try {
      const data = await apiFetch(`/job-assets-admin/job-assets/${id}/bom-lines`);
      const rows = Array.isArray(data?.bom_lines) ? data.bom_lines : [];
      setBomLines(rows);
      setBomLineForm((prev) => ({
        ...emptyBomLine(String(id)),
        source_kind: prev.source_kind || "manual_snapshot",
      }));
    } catch (e) {
      setBomLines([]);
      setError(e?.data?.error || "Failed to load asset BOM lines.");
    } finally {
      setBomLinesLoading(false);
    }
  }

  useEffect(() => {
    loadAll().catch(() => {});
  }, []);

  useEffect(() => {
    loadBomLines(selectedJobAssetId).catch(() => {});
  }, [selectedJobAssetId]);

  function editAsset(item) {
    setAssetForm({
      id: item.id,
      customer_id: item.customer_id ? String(item.customer_id) : "",
      sales_order_id: item.sales_order_id ? String(item.sales_order_id) : "",
      dispatch_id: item.dispatch_id ? String(item.dispatch_id) : "",
      job_card_id: item.job_card_id ? String(item.job_card_id) : "",
      asset_status: item.asset_status || "active",
      job_id: item.job_id || "",
      serial_no: item.serial_no || "",
      asset_code: item.asset_code || "",
      asset_name: item.asset_name || "",
      finished_good_product_id: item.finished_good_product_id ? String(item.finished_good_product_id) : "",
      installation_date: item.installation_date || "",
      commissioning_date: item.commissioning_date || "",
      warranty_start_date: item.warranty_start_date || "",
      warranty_end_date: item.warranty_end_date || "",
      site_name: item.site_name || "",
      site_address: item.site_address || "",
      remarks: item.remarks || "",
    });
    setSelectedJobAssetId(String(item.id));
    setActiveSection("assets");
    setError("");
    setNotice("");
  }

  function editBomLine(item) {
    setBomLineForm({
      id: item.id,
      job_asset_id: item.job_asset_id ? String(item.job_asset_id) : "",
      bom_id: item.bom_id ? String(item.bom_id) : "",
      line_no: item.line_no === null || item.line_no === undefined ? "" : String(item.line_no),
      installed_product_id: item.installed_product_id ? String(item.installed_product_id) : "",
      installed_item_code: item.installed_item_code || "",
      installed_item_name: item.installed_item_name || "",
      uom: item.uom || "",
      qty_installed: item.qty_installed === null || item.qty_installed === undefined ? "1" : String(item.qty_installed),
      remarks: item.remarks || "",
      source_kind: item.source_kind || "manual_snapshot",
    });
    setActiveSection("bom");
    setError("");
    setNotice("");
  }

  function editMapping(item) {
    setMappingForm({
      id: item.id,
      parent_product_id: item.parent_product_id ? String(item.parent_product_id) : "",
      replacement_product_id: item.replacement_product_id ? String(item.replacement_product_id) : "",
      mapping_type: item.mapping_type || "consumable",
      qty_per_parent: item.qty_per_parent === null || item.qty_per_parent === undefined ? "1" : String(item.qty_per_parent),
      is_recommended: item.is_recommended !== false,
      is_mandatory: Boolean(item.is_mandatory),
      service_interval_hours: item.service_interval_hours === null || item.service_interval_hours === undefined ? "" : String(item.service_interval_hours),
      service_interval_days: item.service_interval_days === null || item.service_interval_days === undefined ? "" : String(item.service_interval_days),
      notes: item.notes || "",
      is_active: item.is_active !== false,
    });
    setActiveSection("mappings");
    setError("");
    setNotice("");
  }

  function resetAssetForm() {
    setAssetForm(emptyAsset());
  }

  function resetBomLineForm() {
    setBomLineForm(emptyBomLine(selectedJobAssetId));
  }

  function resetMappingForm() {
    setMappingForm(emptyMapping());
  }

  async function saveAsset() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        customer_id: assetForm.customer_id ? Number(assetForm.customer_id) : null,
        sales_order_id: assetForm.sales_order_id ? Number(assetForm.sales_order_id) : null,
        dispatch_id: assetForm.dispatch_id ? Number(assetForm.dispatch_id) : null,
        job_card_id: assetForm.job_card_id ? Number(assetForm.job_card_id) : null,
        asset_status: assetForm.asset_status,
        job_id: assetForm.job_id,
        serial_no: assetForm.serial_no,
        asset_code: assetForm.asset_code,
        asset_name: assetForm.asset_name,
        finished_good_product_id: assetForm.finished_good_product_id ? Number(assetForm.finished_good_product_id) : null,
        installation_date: assetForm.installation_date || null,
        commissioning_date: assetForm.commissioning_date || null,
        warranty_start_date: assetForm.warranty_start_date || null,
        warranty_end_date: assetForm.warranty_end_date || null,
        site_name: assetForm.site_name,
        site_address: assetForm.site_address,
        remarks: assetForm.remarks,
      };
      const data = assetForm.id
        ? await apiFetch(`/job-assets-admin/job-assets/${assetForm.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiFetch("/job-assets-admin/job-assets", { method: "POST", body: JSON.stringify(payload) });
      const nextId = data?.job_asset?.id ? String(data.job_asset.id) : "";
      await loadAll(nextId);
      if (nextId) setSelectedJobAssetId(nextId);
      setAssetForm(emptyAsset());
      setNotice(assetForm.id ? "Job Asset updated." : "Job Asset created.");
    } catch (e) {
      setError(e?.data?.error || "Failed to save Job Asset.");
    } finally {
      setSaving(false);
    }
  }

  async function removeAsset() {
    if (!assetForm.id) return;
    if (!window.confirm("Delete this Job Asset and its BOM snapshot lines?")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/job-assets-admin/job-assets/${assetForm.id}`, { method: "DELETE" });
      const removedId = String(assetForm.id);
      setAssetForm(emptyAsset());
      if (String(selectedJobAssetId) === removedId) setSelectedJobAssetId("");
      await loadAll();
      setNotice("Job Asset deleted.");
    } catch (e) {
      setError(e?.data?.error || "Failed to delete Job Asset.");
    } finally {
      setSaving(false);
    }
  }

  async function saveBomLine() {
    if (!selectedJobAssetId) {
      setError("Select a Job Asset first.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        bom_id: bomLineForm.bom_id ? Number(bomLineForm.bom_id) : null,
        line_no: bomLineForm.line_no ? Number(bomLineForm.line_no) : null,
        installed_product_id: bomLineForm.installed_product_id ? Number(bomLineForm.installed_product_id) : null,
        installed_item_code: bomLineForm.installed_item_code,
        installed_item_name: bomLineForm.installed_item_name,
        uom: bomLineForm.uom,
        qty_installed: bomLineForm.qty_installed,
        remarks: bomLineForm.remarks,
        source_kind: bomLineForm.source_kind,
      };
      await (bomLineForm.id
        ? apiFetch(`/job-assets-admin/bom-lines/${bomLineForm.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : apiFetch(`/job-assets-admin/job-assets/${selectedJobAssetId}/bom-lines`, { method: "POST", body: JSON.stringify(payload) }));
      await Promise.all([loadBomLines(selectedJobAssetId), loadAll(selectedJobAssetId)]);
      setBomLineForm(emptyBomLine(selectedJobAssetId));
      setNotice(bomLineForm.id ? "Asset BOM line updated." : "Asset BOM line created.");
    } catch (e) {
      setError(e?.data?.error || "Failed to save asset BOM line.");
    } finally {
      setSaving(false);
    }
  }

  async function removeBomLine(id) {
    if (!id) return;
    if (!window.confirm("Delete this BOM snapshot line?")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/job-assets-admin/bom-lines/${id}`, { method: "DELETE" });
      await Promise.all([loadBomLines(selectedJobAssetId), loadAll(selectedJobAssetId)]);
      if (String(bomLineForm.id) === String(id)) setBomLineForm(emptyBomLine(selectedJobAssetId));
      setNotice("Asset BOM line deleted.");
    } catch (e) {
      setError(e?.data?.error || "Failed to delete asset BOM line.");
    } finally {
      setSaving(false);
    }
  }

  async function saveMapping() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        parent_product_id: mappingForm.parent_product_id ? Number(mappingForm.parent_product_id) : null,
        replacement_product_id: mappingForm.replacement_product_id ? Number(mappingForm.replacement_product_id) : null,
        mapping_type: mappingForm.mapping_type,
        qty_per_parent: mappingForm.qty_per_parent,
        is_recommended: mappingForm.is_recommended,
        is_mandatory: mappingForm.is_mandatory,
        service_interval_hours: mappingForm.service_interval_hours ? Number(mappingForm.service_interval_hours) : null,
        service_interval_days: mappingForm.service_interval_days ? Number(mappingForm.service_interval_days) : null,
        notes: mappingForm.notes,
        is_active: mappingForm.is_active,
      };
      await (mappingForm.id
        ? apiFetch(`/job-assets-admin/aftermarket-mappings/${mappingForm.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : apiFetch("/job-assets-admin/aftermarket-mappings", { method: "POST", body: JSON.stringify(payload) }));
      await loadAll(selectedJobAssetId);
      setMappingForm(emptyMapping());
      setNotice(mappingForm.id ? "Aftermarket mapping updated." : "Aftermarket mapping created.");
    } catch (e) {
      setError(e?.data?.error || "Failed to save aftermarket mapping.");
    } finally {
      setSaving(false);
    }
  }

  async function removeMapping() {
    if (!mappingForm.id) return;
    if (!window.confirm("Delete this installed-to-replacement mapping?")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/job-assets-admin/aftermarket-mappings/${mappingForm.id}`, { method: "DELETE" });
      await loadAll(selectedJobAssetId);
      setMappingForm(emptyMapping());
      setNotice("Aftermarket mapping deleted.");
    } catch (e) {
      setError(e?.data?.error || "Failed to delete aftermarket mapping.");
    } finally {
      setSaving(false);
    }
  }

  function renderAssetSection() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "0.96fr 1.04fr", gap: 16 }}>
        <SurfaceCard title="Job asset editor" subtitle="Capture the deployed machine identity once so every spare quote can point at the right serial and commercial origin.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <Field label="Customer">
                <select value={assetForm.customer_id} onChange={(e) => setAssetForm((prev) => ({ ...prev, customer_id: e.target.value }))}>
                  <option value="">-- Select customer --</option>
                  {bootstrap.customers.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.customer_code || "—"} - {item.customer_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Job ID">
                <input value={assetForm.job_id} onChange={(e) => setAssetForm((prev) => ({ ...prev, job_id: e.target.value }))} placeholder="AT-N085" />
              </Field>
              <Field label="Serial No">
                <input value={assetForm.serial_no} onChange={(e) => setAssetForm((prev) => ({ ...prev, serial_no: e.target.value }))} placeholder="AT-N085" />
              </Field>
              <Field label="Asset Code">
                <input value={assetForm.asset_code} onChange={(e) => setAssetForm((prev) => ({ ...prev, asset_code: e.target.value }))} />
              </Field>
              <Field label="Asset Name">
                <input value={assetForm.asset_name} onChange={(e) => setAssetForm((prev) => ({ ...prev, asset_name: e.target.value }))} />
              </Field>
              <Field label="Finished Good">
                <select value={assetForm.finished_good_product_id} onChange={(e) => setAssetForm((prev) => ({ ...prev, finished_good_product_id: e.target.value }))}>
                  <option value="">-- Select finished good --</option>
                  {productOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Asset Status">
                <select value={assetForm.asset_status} onChange={(e) => setAssetForm((prev) => ({ ...prev, asset_status: e.target.value }))}>
                  {ASSET_STATUS_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <Field label="Sales Order">
                <select value={assetForm.sales_order_id} onChange={(e) => setAssetForm((prev) => ({ ...prev, sales_order_id: e.target.value }))}>
                  <option value="">-- None --</option>
                  {filteredSalesOrders.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.so_number} - {item.customer_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Dispatch">
                <select value={assetForm.dispatch_id} onChange={(e) => setAssetForm((prev) => ({ ...prev, dispatch_id: e.target.value }))}>
                  <option value="">-- None --</option>
                  {filteredDispatches.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.dispatch_number} - {item.customer_name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Job Card">
                <select value={assetForm.job_card_id} onChange={(e) => setAssetForm((prev) => ({ ...prev, job_card_id: e.target.value }))}>
                  <option value="">-- None --</option>
                  {filteredJobCards.map((item) => (
                    <option key={item.id} value={String(item.id)}>
                      {item.job_card_number} - {item.job_id || item.finished_good_item_code || "No job id"}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Installation Date">
                  <input type="date" value={assetForm.installation_date} onChange={(e) => setAssetForm((prev) => ({ ...prev, installation_date: e.target.value }))} />
                </Field>
                <Field label="Commissioning Date">
                  <input type="date" value={assetForm.commissioning_date} onChange={(e) => setAssetForm((prev) => ({ ...prev, commissioning_date: e.target.value }))} />
                </Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Warranty Start">
                  <input type="date" value={assetForm.warranty_start_date} onChange={(e) => setAssetForm((prev) => ({ ...prev, warranty_start_date: e.target.value }))} />
                </Field>
                <Field label="Warranty End">
                  <input type="date" value={assetForm.warranty_end_date} onChange={(e) => setAssetForm((prev) => ({ ...prev, warranty_end_date: e.target.value }))} />
                </Field>
              </div>
              <Field label="Site Name">
                <input value={assetForm.site_name} onChange={(e) => setAssetForm((prev) => ({ ...prev, site_name: e.target.value }))} />
              </Field>
              <Field label="Site Address">
                <textarea rows={4} style={{ width: "100%" }} value={assetForm.site_address} onChange={(e) => setAssetForm((prev) => ({ ...prev, site_address: e.target.value }))} />
              </Field>
            </div>
          </div>
          <Field label="Remarks">
            <textarea rows={4} style={{ width: "100%" }} value={assetForm.remarks} onChange={(e) => setAssetForm((prev) => ({ ...prev, remarks: e.target.value }))} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={resetAssetForm}>
              Reset
            </button>
            {assetForm.id ? (
              <button type="button" onClick={removeAsset} disabled={saving}>
                Delete Asset
              </button>
            ) : null}
            <button type="button" onClick={saveAsset} disabled={saving}>
              {assetForm.id ? "Update Job Asset" : "Create Job Asset"}
            </button>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Asset directory"
          subtitle="Pick a deployed asset card to edit its header or jump straight to the BOM snapshot lane."
          actions={<input value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} placeholder="Search job assets" style={{ minWidth: 220 }} />}
        >
          <div style={{ display: "grid", gap: 10, maxHeight: "74vh", overflowY: "auto", paddingRight: 4 }}>
            {filteredAssetRows.length ? (
              filteredAssetRows.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => editAsset(item)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e3e8f2",
                    borderRadius: 16,
                    padding: 14,
                    background: String(item.id) === String(assetForm.id || selectedJobAssetId) ? "#eef4ff" : "#fbfcff",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>{item.job_id || item.serial_no || "Unnamed asset"}</strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.asset_status || "active"}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.78 }}>
                    Serial: {item.serial_no || "—"} • Customer: {item.customer_name || "—"}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>
                    FG: {item.finished_good_item_code || "—"} {item.finished_good_item_name ? `• ${item.finished_good_item_name}` : ""}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    SO: {item.so_number || "—"} • Dispatch: {item.dispatch_number || "—"} • BOM lines: {item.bom_line_count || 0}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>Site: {item.site_name || "Not tagged"}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedJobAssetId(String(item.id));
                        setActiveSection("bom");
                      }}
                    >
                      Open BOM
                    </button>
                  </div>
                </button>
              ))
            ) : (
              <div style={{ padding: 12, opacity: 0.72 }}>No job assets found for the active company.</div>
            )}
          </div>
        </SurfaceCard>
      </div>
    );
  }

  function renderBomSection() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "0.92fr 1.08fr", gap: 16 }}>
        <SurfaceCard title="Asset BOM editor" subtitle="Capture the installed snapshot for the selected deployed asset so Absstem Shield recommendations can resolve correctly.">
          <Field label="Selected Job Asset">
            <select value={selectedJobAssetId} onChange={(e) => setSelectedJobAssetId(e.target.value)}>
              <option value="">-- Select asset --</option>
              {bootstrap.job_assets.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.job_id || item.serial_no} - {item.customer_name}
                </option>
              ))}
            </select>
          </Field>
          {selectedAssetRecord ? (
            <div style={{ border: "1px solid #edf1f7", borderRadius: 14, padding: 12, background: "#fbfcff", marginBottom: 14 }}>
              <div style={{ fontWeight: 700 }}>{selectedAssetRecord.job_id || selectedAssetRecord.serial_no}</div>
              <div style={{ fontSize: 12, opacity: 0.74, marginTop: 6 }}>
                Customer: {selectedAssetRecord.customer_name || "—"} • FG: {selectedAssetRecord.finished_good_item_code || "—"} {selectedAssetRecord.finished_good_item_name || ""}
              </div>
              <div style={{ fontSize: 12, opacity: 0.72, marginTop: 6 }}>
                SO: {selectedAssetRecord.so_number || "—"} • Dispatch: {selectedAssetRecord.dispatch_number || "—"} • Current lines: {currentAssetBomCount || 0}
              </div>
            </div>
          ) : (
            <div style={{ padding: 12, border: "1px dashed #dfe5ef", borderRadius: 14, background: "#fbfcff", marginBottom: 14, opacity: 0.74 }}>
              Select an asset before adding its BOM snapshot.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Line No">
              <input value={bomLineForm.line_no} onChange={(e) => setBomLineForm((prev) => ({ ...prev, line_no: e.target.value }))} placeholder="10" />
            </Field>
            <Field label="Source Kind">
              <select value={bomLineForm.source_kind} onChange={(e) => setBomLineForm((prev) => ({ ...prev, source_kind: e.target.value }))}>
                {SOURCE_KIND_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Manufacturing BOM">
            <select value={bomLineForm.bom_id} onChange={(e) => setBomLineForm((prev) => ({ ...prev, bom_id: e.target.value }))}>
              <option value="">-- None --</option>
              {filteredBomOptions.map((item) => (
                <option key={item.id} value={String(item.id)}>
                  {item.bom_code} - {item.finished_good_item_code}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Installed Product">
            <select value={bomLineForm.installed_product_id} onChange={(e) => setBomLineForm((prev) => ({ ...prev, installed_product_id: e.target.value }))}>
              <option value="">-- Optional product link --</option>
              {productOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Installed Item Code">
            <input value={bomLineForm.installed_item_code} onChange={(e) => setBomLineForm((prev) => ({ ...prev, installed_item_code: e.target.value }))} />
          </Field>
          <Field label="Installed Item Name">
            <input value={bomLineForm.installed_item_name} onChange={(e) => setBomLineForm((prev) => ({ ...prev, installed_item_name: e.target.value }))} />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="UOM">
              <input value={bomLineForm.uom} onChange={(e) => setBomLineForm((prev) => ({ ...prev, uom: e.target.value }))} />
            </Field>
            <Field label="Qty Installed">
              <input value={bomLineForm.qty_installed} onChange={(e) => setBomLineForm((prev) => ({ ...prev, qty_installed: e.target.value }))} />
            </Field>
          </div>
          <Field label="Remarks">
            <textarea rows={4} style={{ width: "100%" }} value={bomLineForm.remarks} onChange={(e) => setBomLineForm((prev) => ({ ...prev, remarks: e.target.value }))} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={resetBomLineForm}>
              Reset
            </button>
            {bomLineForm.id ? (
              <button type="button" onClick={() => removeBomLine(bomLineForm.id)} disabled={saving}>
                Delete Line
              </button>
            ) : null}
            <button type="button" onClick={saveBomLine} disabled={saving || !selectedJobAssetId}>
              {bomLineForm.id ? "Update BOM Line" : "Create BOM Line"}
            </button>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Asset BOM snapshot"
          subtitle="The right-side queue shows what is installed on the selected machine, line by line."
          actions={
            selectedAssetRecord ? (
              <div style={{ fontSize: 12, opacity: 0.68 }}>
                {selectedAssetRecord.job_id || selectedAssetRecord.serial_no} • {bomLines.length} lines
              </div>
            ) : null
          }
        >
          <div style={{ display: "grid", gap: 10, maxHeight: "74vh", overflowY: "auto", paddingRight: 4 }}>
            {bomLinesLoading ? (
              <div style={{ padding: 12, opacity: 0.72 }}>Loading BOM lines…</div>
            ) : bomLines.length ? (
              bomLines.map((item) => (
                <div key={item.id} style={{ border: "1px solid #e3e8f2", borderRadius: 16, padding: 14, background: String(item.id) === String(bomLineForm.id) ? "#eef4ff" : "#fbfcff", display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>
                      {item.line_no}. {item.installed_item_code || "—"}
                    </strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.source_kind || "manual_snapshot"}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.78 }}>{item.installed_item_name || "Unnamed installed item"}</div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>
                    Qty: {item.qty_installed} {item.uom || ""} • BOM: {item.bom_code || "Manual"} • Product link: {item.installed_product_id || "Not linked"}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.remarks || "No remarks"}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => editBomLine(item)}>
                        Edit
                      </button>
                      <button type="button" onClick={() => removeBomLine(item.id)} disabled={saving}>
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: 12, opacity: 0.72 }}>{selectedJobAssetId ? "No BOM lines captured yet for this asset." : "Select a Job Asset to view its BOM snapshot."}</div>
            )}
          </div>
        </SurfaceCard>
      </div>
    );
  }

  function renderMappingsSection() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "0.94fr 1.06fr", gap: 16 }}>
        <SurfaceCard title="Aftermarket mapping editor" subtitle="Map what was installed on the machine to what must actually be quoted as the spare, kit, or consumable.">
          <Field label="Installed Parent Product">
            <select value={mappingForm.parent_product_id} onChange={(e) => setMappingForm((prev) => ({ ...prev, parent_product_id: e.target.value }))}>
              <option value="">-- Select installed parent --</option>
              {productOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Replacement Product">
            <select value={mappingForm.replacement_product_id} onChange={(e) => setMappingForm((prev) => ({ ...prev, replacement_product_id: e.target.value }))}>
              <option value="">-- Select replacement product --</option>
              {productOptions.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Mapping Type">
              <select value={mappingForm.mapping_type} onChange={(e) => setMappingForm((prev) => ({ ...prev, mapping_type: e.target.value }))}>
                {MAPPING_TYPE_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Qty Per Parent">
              <input value={mappingForm.qty_per_parent} onChange={(e) => setMappingForm((prev) => ({ ...prev, qty_per_parent: e.target.value }))} />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Service Interval Hours">
              <input value={mappingForm.service_interval_hours} onChange={(e) => setMappingForm((prev) => ({ ...prev, service_interval_hours: e.target.value }))} />
            </Field>
            <Field label="Service Interval Days">
              <input value={mappingForm.service_interval_days} onChange={(e) => setMappingForm((prev) => ({ ...prev, service_interval_days: e.target.value }))} />
            </Field>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input type="checkbox" checked={mappingForm.is_recommended} onChange={(e) => setMappingForm((prev) => ({ ...prev, is_recommended: e.target.checked }))} />
            Recommended in Absstem Shield
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input type="checkbox" checked={mappingForm.is_mandatory} onChange={(e) => setMappingForm((prev) => ({ ...prev, is_mandatory: e.target.checked }))} />
            Mandatory spare
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input type="checkbox" checked={mappingForm.is_active} onChange={(e) => setMappingForm((prev) => ({ ...prev, is_active: e.target.checked }))} />
            Mapping active
          </label>
          <Field label="Notes">
            <textarea rows={5} style={{ width: "100%" }} value={mappingForm.notes} onChange={(e) => setMappingForm((prev) => ({ ...prev, notes: e.target.value }))} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={resetMappingForm}>
              Reset
            </button>
            {mappingForm.id ? (
              <button type="button" onClick={removeMapping} disabled={saving}>
                Delete Mapping
              </button>
            ) : null}
            <button type="button" onClick={saveMapping} disabled={saving}>
              {mappingForm.id ? "Update Mapping" : "Create Mapping"}
            </button>
          </div>
        </SurfaceCard>

        <SurfaceCard
          title="Installed to replacement rules"
          subtitle="Use this directory to audit mappings like installed filter assembly to sellable filter element before service teams quote the wrong SKU."
          actions={<input value={mappingQuery} onChange={(e) => setMappingQuery(e.target.value)} placeholder="Search mappings" style={{ minWidth: 220 }} />}
        >
          <div style={{ display: "grid", gap: 10, maxHeight: "74vh", overflowY: "auto", paddingRight: 4 }}>
            {filteredMappingRows.length ? (
              filteredMappingRows.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => editMapping(item)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    border: "1px solid #e3e8f2",
                    borderRadius: 16,
                    padding: 14,
                    background: String(item.id) === String(mappingForm.id) ? "#eef4ff" : "#fbfcff",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <strong>
                      {item.parent_item_code || "—"} {"->"} {item.replacement_item_code || "—"}
                    </strong>
                    <span style={{ fontSize: 12, opacity: 0.72 }}>{item.mapping_type || "consumable"}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.78 }}>
                    {item.parent_item_name || "Unknown parent"} {"->"} {item.replacement_item_name || "Unknown replacement"}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.74 }}>
                    Qty: {item.qty_per_parent} • Recommended: {item.is_recommended ? "Yes" : "No"} • Mandatory: {item.is_mandatory ? "Yes" : "No"}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    Interval: {item.service_interval_hours || "—"} hrs / {item.service_interval_days || "—"} days • Status: {item.is_active ? "Active" : "Inactive"}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>{item.notes || "No notes"}</div>
                </button>
              ))
            ) : (
              <div style={{ padding: 12, opacity: 0.72 }}>No aftermarket mappings configured for the active company.</div>
            )}
          </div>
        </SurfaceCard>
      </div>
    );
  }

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>;

  const stats = [
    { label: "Job Assets", value: bootstrap.job_assets.length, note: "deployed serial-tagged systems", accent: "#1f5eff" },
    { label: "Asset BOM lines", value: bootstrap.job_assets.reduce((sum, item) => sum + toNumber(item.bom_line_count, 0), 0), note: "installed snapshot lines captured", accent: "#14804a" },
    { label: "Mappings", value: bootstrap.aftermarket_mappings.length, note: "installed to replacement rules", accent: "#d97706" },
    { label: "Recommended", value: recommendedMappingCount, note: "rules exposed into Absstem Shield", accent: "#8b5cf6" },
  ];

  return (
    <div style={{ maxWidth: 1360, width: "100%", display: "grid", gap: 16 }}>
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
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Aftermarket governance desk</div>
            <h2 style={{ margin: "8px 0 0", fontSize: 32, lineHeight: 1.15 }}>Job Assets, BOM snapshots, and replacement rules.</h2>
            <p style={{ margin: "12px 0 0", fontSize: 14, opacity: 0.76, maxWidth: 860, lineHeight: 1.7 }}>
              Maintain the deployed machine identity, capture what was installed on that exact asset, and map each installed component to the real sellable spare before service teams build quotes.
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              <span style={{ display: "inline-flex", minHeight: 28, alignItems: "center", padding: "4px 10px", borderRadius: 999, background: "rgba(31, 94, 255, 0.1)", color: "#1f5eff", fontSize: 11, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                {activeCompany ? `${activeCompany.company_code} active company` : "Select active company"}
              </span>
              {selectedAssetRecord ? (
                <span style={{ display: "inline-flex", minHeight: 28, alignItems: "center", padding: "4px 10px", borderRadius: 999, background: "rgba(20, 128, 74, 0.1)", color: "#14804a", fontSize: 11, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                  {selectedAssetRecord.job_id || selectedAssetRecord.serial_no} selected
                </span>
              ) : null}
            </div>
          </div>
          <button type="button" onClick={() => loadAll(selectedJobAssetId).catch(() => {})} disabled={loading}>
            Refresh
          </button>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14 }}>
        {stats.map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </section>

      {!bootstrap.active_company_id ? (
        <SurfaceCard title="Company context required" subtitle="Use the workspace company switch first. This maintenance page stays company-scoped so assets and mappings never cross seller boundaries." />
      ) : null}

      {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35" }}>{notice}</div> : null}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
        <SectionButton active={activeSection === "assets"} label="Job Assets" note="Maintain deployed serial-tagged assets and their commercial lineage." onClick={() => setActiveSection("assets")} />
        <SectionButton active={activeSection === "bom"} label="Asset BOM" note="Capture installed snapshot lines for the selected deployed asset." onClick={() => setActiveSection("bom")} />
        <SectionButton active={activeSection === "mappings"} label="Aftermarket Mappings" note="Translate installed components into the correct sellable spare lines." onClick={() => setActiveSection("mappings")} />
      </section>

      {activeSection === "assets" ? renderAssetSection() : null}
      {activeSection === "bom" ? renderBomSection() : null}
      {activeSection === "mappings" ? renderMappingsSection() : null}
    </div>
  );
}
