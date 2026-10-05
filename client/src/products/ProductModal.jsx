import React, { useEffect, useState } from "react";

function buildInitialFormData(product, categories, groups) {
  if (product) {
    let specs = {};
    try {
      specs = typeof product.specifications_json === "object" && product.specifications_json !== null
        ? product.specifications_json
        : JSON.parse(product.specifications_json || "{}");
    } catch (e) {
      specs = {};
    }

    const policy = product.company_policy || {};
    const itemCodeUpper = String(product.item_code || product.sku || "").toUpperCase();
    const isNitrogen = itemCodeUpper.startsWith("NGEN") || (product.category_name || "").toLowerCase().includes("nitrogen");
    const isIndustrialO2 = itemCodeUpper.startsWith("ID") || (product.category_name || "").toLowerCase().includes("industrial");
    
    // Auto-resolve proper Manufacturing Prefix (N for Nitrogen, ID for Industrial O2, M for Medical)
    const defaultPrefix = isNitrogen ? "N" : isIndustrialO2 ? "ID" : "M";
    const mfgPrefix = policy.mfg_job_prefix || product.mfg_job_prefix || defaultPrefix;

    // Sourcing Mode & Manufacturing Flag
    const isMfg = policy.is_manufactured !== undefined && policy.is_manufactured !== null
      ? Boolean(policy.is_manufactured)
      : Boolean(product.is_manufactured);

    let defaultSourcing = isMfg ? "manufacture" : "buy_intercompany";
    if (product.item_type && !["finished_good", "fg", "sub_assembly", "sa"].includes(String(product.item_type).toLowerCase())) {
      defaultSourcing = "buy_external";
    }
    const sourcingMode = policy.sourcing_mode || product.sourcing_mode || defaultSourcing;

    return {
      id: product.id,
      sku: product.sku || product.item_code || "",
      item_code: product.item_code || "",
      item_name: product.item_name || "",
      brand: product.brand || "ABSSTEM",
      item_type: product.item_type || "finished_good",
      uom: product.uom || "NOS",
      hsn_no: product.hsn_no || "",
      category_id: product.category_id || (categories[0]?.id || ""),
      group_id: product.group_id || (groups[0]?.id || ""),
      list_price: product.list_price || 0,
      standard_cost: product.standard_cost || 0,
      selling_price: product.selling_price || product.list_price || 0,
      gst_pct: product.gst_pct || 18,
      min_safety_stock: product.min_safety_stock || 0,
      reorder_quantity: product.reorder_quantity || 0,
      preferred_vendor_id: policy.preferred_vendor_id || product.preferred_vendor_id || "",
      description: product.description || "",
      technical_notes: product.technical_notes || "",
      serial_no_required: Boolean(product.serial_no_required),
      is_manufactured: sourcingMode === "manufacture" ? true : isMfg,
      mfg_job_prefix: mfgPrefix,
      sourcing_mode: sourcingMode,
      is_active: product.is_active !== false,
      family_key: product.family_key || "",
      module_role: product.module_role || "",
      variant_key: product.variant_key || "",
      specEntries: Object.entries(specs).map(([key, value]) => ({ key, value })),
    };
  }
  return {
    sku: "",
    item_code: "",
    item_name: "",
    brand: "ABSSTEM",
    item_type: "finished_good",
    uom: "NOS",
    hsn_no: "8405",
    category_id: categories[0]?.id || "",
    group_id: groups[0]?.id || "",
    list_price: 0,
    standard_cost: 0,
    selling_price: 0,
    gst_pct: 18,
    min_safety_stock: 0,
    reorder_quantity: 0,
    preferred_vendor_id: "",
    description: "",
    technical_notes: "",
    serial_no_required: false,
    is_manufactured: true,
    mfg_job_prefix: "M",
    sourcing_mode: "manufacture",
    is_active: true,
    family_key: "",
    module_role: "",
    variant_key: "",
    specEntries: [
      { key: "Flow Rate", value: "" },
      { key: "Purity Spec", value: "93% ± 3%" },
      { key: "Operating Pressure", value: "4-6 Bar" },
    ],
  };
}

export default function ProductModal({
  isOpen,
  onClose,
  product,
  categories = [],
  groups = [],
  onSave,
  saving,
}) {
  const [activeModalTab, setActiveModalTab] = useState("general"); // 'general' | 'sourcing' | 'pricing_mrp' | 'specs'
  const [formData, setFormData] = useState(() => buildInitialFormData(product, categories, groups));

  useEffect(() => {
    if (isOpen) {
      setFormData(buildInitialFormData(product, categories, groups));
      setActiveModalTab("general");
    }
  }, [isOpen, product, categories, groups]);

  if (!isOpen) return null;

  function handleChange(field, value) {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "item_code" && !prev.id && (!prev.sku || prev.sku === prev.item_code)) {
        next.sku = value;
      }
      if (field === "sourcing_mode") {
        next.is_manufactured = value === "manufacture";
      }
      return next;
    });
  }

  function handleSpecChange(index, field, value) {
    setFormData((prev) => {
      const nextSpecs = [...prev.specEntries];
      nextSpecs[index] = { ...nextSpecs[index], [field]: value };
      return { ...prev, specEntries: nextSpecs };
    });
  }

  function addSpecRow() {
    setFormData((prev) => ({
      ...prev,
      specEntries: [...prev.specEntries, { key: "", value: "" }],
    }));
  }

  function removeSpecRow(index) {
    setFormData((prev) => ({
      ...prev,
      specEntries: prev.specEntries.filter((_, i) => i !== index),
    }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    const specsObj = {};
    formData.specEntries.forEach((s) => {
      if (s.key && s.key.trim()) {
        specsObj[s.key.trim()] = s.value;
      }
    });

    const payload = {
      ...formData,
      specifications_json: specsObj,
    };
    onSave(payload);
  }

  return (
    <div className="pd-modal-overlay">
      <div className="pd-modal-card">
        <div className="pd-modal-header">
          <div>
            <h3 style={{ margin: 0 }}>
              {formData.id ? `Edit SKU: ${formData.sku || formData.item_code}` : "Create New Product SKU"}
            </h3>
            <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
              Comprehensive item definition, multi-company routing, and technical parameters
            </span>
          </div>
          <button type="button" className="pd-btn secondary" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modal Inner 4-Step Tab Switcher */}
        <div className="pd-tabs" style={{ padding: "8px 16px 0", background: "#f8fafc" }}>
          <button
            type="button"
            className={`pd-tab ${activeModalTab === "general" ? "active" : ""}`}
            onClick={() => setActiveModalTab("general")}
          >
            1. General Info
          </button>
          <button
            type="button"
            className={`pd-tab ${activeModalTab === "sourcing" ? "active" : ""}`}
            onClick={() => setActiveModalTab("sourcing")}
          >
            2. Multi-Company & Sourcing
          </button>
          <button
            type="button"
            className={`pd-tab ${activeModalTab === "pricing_mrp" ? "active" : ""}`}
            onClick={() => setActiveModalTab("pricing_mrp")}
          >
            3. Pricing & MRP
          </button>
          <button
            type="button"
            className={`pd-tab ${activeModalTab === "specs" ? "active" : ""}`}
            onClick={() => setActiveModalTab("specs")}
          >
            4. Technical Specs (JSON)
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div className="pd-modal-body">
            {/* STEP 1: GENERAL INFO */}
            {activeModalTab === "general" && (
              <div className="pd-form-grid">
                <div className="pd-form-group">
                  <label>SKU / Item Code *</label>
                  <input
                    type="text"
                    required
                    className="pd-input"
                    value={formData.item_code}
                    onChange={(e) => handleChange("item_code", e.target.value.toUpperCase())}
                    placeholder="e.g., MED-O2-GEN-50"
                    readOnly={Boolean(formData.id)}
                    disabled={Boolean(formData.id)}
                  />
                  {formData.id ? (
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Locked after create</div>
                  ) : null}
                </div>

                <div className="pd-form-group">
                  <label>Item Name / Model *</label>
                  <input
                    type="text"
                    required
                    className="pd-input"
                    value={formData.item_name}
                    onChange={(e) => handleChange("item_name", e.target.value)}
                    placeholder="e.g., Medical Oxygen Generator 50 Nm3/hr"
                  />
                </div>

                <div className="pd-form-group">
                  <label>Item Classification *</label>
                  <select
                    className="pd-select"
                    value={formData.item_type}
                    onChange={(e) => handleChange("item_type", e.target.value)}
                  >
                    <option value="finished_good">Finished Good (FG)</option>
                    <option value="sub_assembly">Sub-Assembly (SA)</option>
                    <option value="raw_material">Raw Material (RM)</option>
                    <option value="spare_part">Spare Part / Consumable</option>
                    <option value="consumable">General Consumable</option>
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Unit of Measure (UOM) *</label>
                  <select
                    className="pd-select"
                    value={formData.uom}
                    onChange={(e) => handleChange("uom", e.target.value)}
                  >
                    <option value="NOS">NOS (Numbers)</option>
                    <option value="SET">SET (Set of items)</option>
                    <option value="KGS">KGS (Kilograms)</option>
                    <option value="MTR">MTR (Meters)</option>
                    <option value="LTR">LTR (Liters)</option>
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Category *</label>
                  <select
                    className="pd-select"
                    value={formData.category_id}
                    onChange={(e) => handleChange("category_id", Number(e.target.value))}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.category_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Product Group *</label>
                  <select
                    className="pd-select"
                    value={formData.group_id}
                    onChange={(e) => handleChange("group_id", Number(e.target.value))}
                  >
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.group_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Family Key</label>
                  <select
                    className="pd-select"
                    value={formData.family_key || ""}
                    onChange={(e) => handleChange("family_key", e.target.value)}
                  >
                    <option value="">— None —</option>
                    <option value="NGEN">NGEN</option>
                    <option value="NGENX">NGENX</option>
                    <option value="MEDO">MEDO</option>
                    <option value="MEDO_C">MEDO_C</option>
                    <option value="IDOS">IDOS</option>
                    <option value="IDOS_C">IDOS_C</option>
                    <option value="SHIELD">SHIELD</option>
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Module Role</label>
                  <select
                    className="pd-select"
                    value={formData.module_role || ""}
                    onChange={(e) => handleChange("module_role", e.target.value)}
                  >
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
                </div>

                <div className="pd-form-group">
                  <label>Variant Key (nGEN)</label>
                  <select
                    className="pd-select"
                    value={formData.variant_key || ""}
                    onChange={(e) => handleChange("variant_key", e.target.value)}
                  >
                    <option value="">— None —</option>
                    <option value="HF">HF</option>
                    <option value="SH">SH</option>
                    <option value="UH">UH</option>
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>HSN / SAC Code</label>
                  <input
                    type="text"
                    className="pd-input"
                    value={formData.hsn_no}
                    onChange={(e) => handleChange("hsn_no", e.target.value)}
                    placeholder="e.g., 84051010"
                  />
                </div>

                <div className="pd-form-group">
                  <label>Brand / Make</label>
                  <input
                    type="text"
                    className="pd-input"
                    value={formData.brand}
                    onChange={(e) => handleChange("brand", e.target.value)}
                  />
                </div>

                <div className="pd-form-group full-width">
                  <label>Description</label>
                  <textarea
                    rows={2}
                    className="pd-textarea"
                    value={formData.description}
                    onChange={(e) => handleChange("description", e.target.value)}
                    placeholder="Standard industrial catalog specification..."
                  />
                </div>
              </div>
            )}

            {/* STEP 2: MULTI-COMPANY SOURCING */}
            {activeModalTab === "sourcing" && (
              <div className="pd-form-grid">
                <div className="pd-form-group">
                  <label>Sourcing Strategy</label>
                  <select
                    className="pd-select"
                    value={formData.sourcing_mode}
                    onChange={(e) => {
                      const mode = e.target.value;
                      setFormData((prev) => ({
                        ...prev,
                        sourcing_mode: mode,
                        is_manufactured: mode === "manufacture",
                      }));
                    }}
                  >
                    <option value="manufacture">Manufacture In-House (AT)</option>
                    <option value="buy_intercompany">Buy Intercompany (AI from AT)</option>
                    <option value="buy_external">Buy External Supply (Vendor)</option>
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Manufacturing Job ID Prefix</label>
                  <select
                    className="pd-select"
                    value={formData.mfg_job_prefix}
                    onChange={(e) => handleChange("mfg_job_prefix", e.target.value)}
                  >
                    <option value="N">N (Nitrogen Generator - nGen / nGenx)</option>
                    <option value="M">M (Medical Oxygen Equipment - MediO2)</option>
                    <option value="ID">ID (Industrial Oxygen Generator - Oxyplus)</option>
                  </select>
                </div>

                <div className="pd-form-group">
                  <label>Manufactured via Work Orders</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      id="mfg_fg"
                      checked={formData.is_manufactured}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setFormData((prev) => ({
                          ...prev,
                          is_manufactured: checked,
                          sourcing_mode: checked ? "manufacture" : prev.sourcing_mode === "manufacture" ? "buy_intercompany" : prev.sourcing_mode,
                        }));
                      }}
                    />
                    <label htmlFor="mfg_fg" style={{ textTransform: "none", cursor: "pointer", fontWeight: 500 }}>
                      Item is produced in shop floor kitting
                    </label>
                  </div>
                </div>

                <div className="pd-form-group">
                  <label>Serial Number Tracking</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      id="sn_req"
                      checked={formData.serial_no_required}
                      onChange={(e) => handleChange("serial_no_required", e.target.checked)}
                    />
                    <label htmlFor="sn_req" style={{ textTransform: "none", cursor: "pointer", fontWeight: 500 }}>
                      Require Serial No on Dispatch / GRN
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: PRICING & MRP */}
            {activeModalTab === "pricing_mrp" && (
              <div className="pd-form-grid">
                <div className="pd-form-group">
                  <label>Standard Cost (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="pd-input"
                    value={formData.standard_cost}
                    onChange={(e) => handleChange("standard_cost", parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className="pd-form-group">
                  <label>Selling / List Price (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="pd-input"
                    value={formData.selling_price}
                    onChange={(e) => handleChange("selling_price", parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className="pd-form-group">
                  <label>GST Rate (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    className="pd-input"
                    value={formData.gst_pct}
                    onChange={(e) => handleChange("gst_pct", parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className="pd-form-group">
                  <label>Active Status</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      id="is_active_check"
                      checked={formData.is_active}
                      onChange={(e) => handleChange("is_active", e.target.checked)}
                    />
                    <label htmlFor="is_active_check" style={{ textTransform: "none", cursor: "pointer", fontWeight: 500 }}>
                      SKU is active for quoting & manufacturing
                    </label>
                  </div>
                </div>

                <div className="pd-form-group">
                  <label>Min Safety Stock Threshold</label>
                  <input
                    type="number"
                    step="1"
                    className="pd-input"
                    value={formData.min_safety_stock}
                    onChange={(e) => handleChange("min_safety_stock", parseFloat(e.target.value) || 0)}
                  />
                </div>

                <div className="pd-form-group">
                  <label>Standard Reorder Quantity (EOQ)</label>
                  <input
                    type="number"
                    step="1"
                    className="pd-input"
                    value={formData.reorder_quantity}
                    onChange={(e) => handleChange("reorder_quantity", parseFloat(e.target.value) || 0)}
                  />
                </div>
              </div>
            )}

            {/* STEP 4: TECHNICAL SPECS */}
            {activeModalTab === "specs" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                    Configure technical properties (e.g., flow rate, pressure ratings, purity specs, dimensions)
                  </span>
                  <button type="button" className="pd-btn secondary" onClick={addSpecRow}>
                    + Add Attribute
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {formData.specEntries.map((spec, idx) => (
                    <div key={idx} className="pd-spec-row">
                      <input
                        type="text"
                        className="pd-input"
                        placeholder="Attribute Name (e.g. Capacity)"
                        value={spec.key}
                        onChange={(e) => handleSpecChange(idx, "key", e.target.value)}
                      />
                      <input
                        type="text"
                        className="pd-input"
                        placeholder="Specification Value (e.g. 100 Nm3/hr)"
                        value={spec.value}
                        onChange={(e) => handleSpecChange(idx, "value", e.target.value)}
                      />
                      <button
                        type="button"
                        className="pd-btn danger"
                        style={{ padding: "4px 8px" }}
                        onClick={() => removeSpecRow(idx)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="pd-form-group" style={{ marginTop: 8 }}>
                  <label>Technical Engineering Notes</label>
                  <textarea
                    rows={2}
                    className="pd-textarea"
                    value={formData.technical_notes}
                    onChange={(e) => handleChange("technical_notes", e.target.value)}
                    placeholder="Engineering guidelines or supplier cross-references..."
                  />
                </div>
              </div>
            )}
          </div>

          <div className="pd-modal-footer">
            <button type="button" className="pd-btn secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="pd-btn primary" disabled={saving}>
              {saving ? "Saving SKU..." : formData.id ? "Update Product Record" : "Create Product Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
