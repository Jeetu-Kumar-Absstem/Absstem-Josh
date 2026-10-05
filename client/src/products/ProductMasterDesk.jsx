import React, { useEffect, useMemo, useState } from "react";
import "./products.css";
import ProductModal from "./ProductModal";
import BulkExcelModal from "./components/BulkExcelModal";
import { SortTh, useSortedRows } from "../shared/tableSort";
import TypedConfirmModal from "../components/TypedConfirmModal";
import QuoteFamilyContentEditor from "./QuoteFamilyContentEditor";

const CLAN_EXCEPTION_TABS = [
  ["", "All open"],
  ["not_in_josh", "Not in Josh"],
  ["no_company_policy", "No company policy"],
  ["awaiting_tax", "Awaiting HSN/GST"],
  ["needs_review", "Needs review"],
];
const CLAN_EXCEPTION_LABEL = Object.fromEntries(CLAN_EXCEPTION_TABS.slice(1));
const CLAN_MAPPABLE = new Set(["not_in_josh", "no_company_policy"]);
const CLAN_EXCEPTION_TONE = {
  not_in_josh: { bg: "#fef2f2", color: "#991b1b" },
  no_company_policy: { bg: "#fff7ed", color: "#9a3412" },
  awaiting_tax: { bg: "#fefce8", color: "#854d0e" },
  needs_review: { bg: "#f1f5f9", color: "#475569" },
};

function formatCurrency(val) {
  const num = Number(val) || 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

const PRODUCT_SORT_SPEC = {
  sku: { type: "string", defaultDir: "asc" },
  item_name: { type: "string", defaultDir: "asc" },
  item_type: { type: "string", defaultDir: "asc" },
  uom: { type: "string", defaultDir: "asc" },
  hsn_no: { type: "string", defaultDir: "asc" },
  standard_cost: { type: "number", defaultDir: "desc" },
  selling_price: { type: "number", defaultDir: "desc" },
  min_safety_stock: { type: "number", defaultDir: "desc" },
  preferred_avl: { type: "string", defaultDir: "asc" },
};

function productSortValue(row, column) {
  if (column === "sku") return row.sku || row.item_code || "";
  if (column === "selling_price") return row.selling_price || row.list_price || 0;
  if (column === "preferred_avl") {
    return (
      row.preferred_vendor_name ||
      (row.sourcing_mode === "buy_intercompany"
        ? "Intercompany (AT)"
        : row.sourcing_mode === "manufacture" || row.is_manufactured
          ? "Internal Manufacturing"
          : "")
    );
  }
  return row[column];
}

export default function ProductMasterDesk({ launch = null, onConsumeLaunch = null }) {
  const [products, setProducts] = useState([]);
  const [stats, setStats] = useState({});
  const [categories, setCategories] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [activeTab, setActiveTab] = useState("all"); // 'all' | 'finished_good' | 'raw_material' | 'sub_assembly' | 'spare_part'

  // Modal States
  const [modalOpen, setModalOpen] = useState(false);
  const [bulkExcelOpen, setBulkExcelOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [saving, setSaving] = useState(false);
  const [clanCompany, setClanCompany] = useState("AI");
  const [clanGap, setClanGap] = useState(null);
  const [clanGapLoading, setClanGapLoading] = useState(false);
  const [clanGapError, setClanGapError] = useState("");
  const [clanType, setClanType] = useState("");
  const [clanSelected, setClanSelected] = useState([]);
  const [clanMapBusy, setClanMapBusy] = useState(false);
  const [clanMapNotice, setClanMapNotice] = useState("");
  const [clanMapAllOpen, setClanMapAllOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function loadClanGap(nextCompany = clanCompany, nextType = clanType) {
    setClanGapLoading(true);
    setClanGapError("");
    setClanSelected([]);
    try {
      const res = await fetch(
        `/products/clan-gap?company=${encodeURIComponent(nextCompany)}&active_only=true&limit=200${
          nextType ? `&type=${encodeURIComponent(nextType)}` : ""
        }`,
        { credentials: "include" }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setClanGap(null);
        setClanGapError(data?.detail || data?.error || "Clan gap snapshot unavailable.");
        return;
      }
      setClanGap(data);
    } catch (err) {
      setClanGap(null);
      setClanGapError(err?.message || "Failed to load Clan gap.");
    } finally {
      setClanGapLoading(false);
    }
  }

  async function loadData(qOverride) {
    const q = typeof qOverride === "string" ? qOverride : searchQuery;
    setLoading(true);
    setError(null);
    try {
      const [prodRes, catRes, grpRes] = await Promise.all([
        fetch(
          `/products?desk=true&q=${encodeURIComponent(q)}${
            filterType ? `&item_type=${encodeURIComponent(filterType)}` : ""
          }${filterCategory ? `&category_id=${encodeURIComponent(filterCategory)}` : ""}`,
          {
          credentials: "include",
        }
        ).then((r) => r.json()),
        fetch("/products/categories", { credentials: "include" }).then((r) => r.json()),
        fetch("/products/groups", { credentials: "include" }).then((r) => r.json()),
      ]);

      if (prodRes.ok) {
        setProducts(prodRes.products || []);
        setStats(prodRes.stats || {});
      } else {
        setError(prodRes.error || "Failed to load products");
      }

      if (catRes.ok) setCategories(catRes.categories || []);
      if (grpRes.ok) setGroups(grpRes.groups || []);
    } catch (err) {
      setError(err.message || "Network error loading product catalog");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (launch && typeof launch.q === "string" && launch.q.trim()) return;
    loadData();
  }, [filterType, filterCategory]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const q = typeof launch.q === "string" ? launch.q.trim() : "";
    if (q) {
      setActiveTab("all");
      setSearchQuery(q);
      loadData(q);
    }
    onConsumeLaunch?.();
  }, [launch]);

  useEffect(() => {
    loadClanGap(clanCompany, clanType);
  }, [clanCompany, clanType]);

  async function mapClanItems({ all = false, confirmPhrase = "" } = {}) {
    setClanMapBusy(true);
    setClanMapNotice("");
    setClanGapError("");
    try {
      const res = await fetch("/products/clan-gap/apply", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          all
            ? { company: clanCompany, all: true, confirm_phrase: confirmPhrase }
            : { company: clanCompany, item_codes: clanSelected }
        ),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setClanGapError(data?.detail || data?.error || "Clan mapping failed.");
        return;
      }
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      setClanMapNotice(
        `Created ${data.created_products} product${data.created_products === 1 ? "" : "s"} (inactive until HSN/GST are set) and added ${data.added_policies} ${clanCompany} polic${data.added_policies === 1 ? "y" : "ies"}${skipped ? ` · ${skipped} skipped` : ""}.`
      );
      setClanMapAllOpen(false);
      await loadClanGap(clanCompany, clanType);
      loadData();
    } catch (err) {
      setClanGapError(err?.message || "Clan mapping failed.");
    } finally {
      setClanMapBusy(false);
    }
  }

  const clanMappableRows = useMemo(
    () => (clanGap?.exceptions || []).filter((row) => CLAN_MAPPABLE.has(row.exception_type)),
    [clanGap]
  );

  function findInCatalog(itemCode) {
    setSearchQuery(itemCode);
    loadData(itemCode);
  }

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    loadData();
  };

  const filteredProducts = useMemo(() => {
    if (activeTab === "all") return products;
    return products.filter((p) => {
      const raw = String(p.item_type || "").toLowerCase();
      const normalized =
        raw === "fg" || raw === "finished_good"
          ? "finished_good"
          : raw === "sa" || raw === "sub_assembly"
            ? "sub_assembly"
            : raw === "rm" || raw === "raw_material"
              ? "raw_material"
              : raw === "spare" || raw === "spare_part" || raw === "consumable"
                ? "spare_part"
                : raw;
      return normalized === activeTab;
    });
  }, [products, activeTab]);
  const { sort, onSort, sorted: sortedProducts } = useSortedRows(
    filteredProducts,
    PRODUCT_SORT_SPEC,
    { column: "sku", dir: "asc" },
    { storageKey: "josh.productMaster.sort.v1", getValue: productSortValue, tieBreak: (row) => row.sku || row.item_code }
  );

  const handleCreateNew = () => {
    setSelectedProduct(null);
    setModalOpen(true);
  };

  const handleEditProduct = async (p) => {
    try {
      const res = await fetch(`/products/${p.id}`, { credentials: "include" });
      const data = await res.json();
      if (data.ok && data.product) {
        setSelectedProduct(data.product);
      } else {
        setSelectedProduct(p);
      }
    } catch {
      setSelectedProduct(p);
    }
    setModalOpen(true);
  };

  const handleDeleteProduct = (p) => setDeleteTarget(p);

  const confirmDeleteProduct = async (confirmPhrase) => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/products/${deleteTarget.id}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm_phrase: confirmPhrase }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.message || data.detail || data.error || "Cannot delete product");
        return;
      }
      setDeleteTarget(null);
      loadData();
    } catch (err) {
      alert("Error deleting product: " + err.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleSaveProduct = async (payload) => {
    setSaving(true);
    try {
      const isEdit = Boolean(payload.id);
      const url = isEdit ? `/products/${payload.id}` : "/products";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.message || data.error || "Failed to save product");
        return;
      }

      setModalOpen(false);
      loadData();
    } catch (err) {
      alert("Error saving product: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="product-desk">
      {/* Command Bar */}
      <header className="pd-command-bar">
        <div className="pd-title-group">
          <h1>Product Master & SKU Catalog</h1>
          <p>Industrial PSA Plant Models, Sub-Assemblies, Raw Materials & Spare Parts Catalog</p>
        </div>
        <div className="pd-actions-group">
          <button
            type="button"
            className="pd-btn secondary"
            onClick={() => setBulkExcelOpen(true)}
            style={{ fontWeight: 600 }}
          >
            📥 Bulk Excel Operations
          </button>
          <button type="button" className="pd-btn secondary" onClick={loadData}>
            ↻ Refresh Catalog
          </button>
          <button type="button" className="pd-btn primary" onClick={handleCreateNew}>
            + Create New SKU
          </button>
        </div>
      </header>

      {/* 4-Column KPI Summary Row */}
      <div className="pd-kpi-grid">
        <div className="pd-kpi-card">
          <span className="label">Total Managed SKUs</span>
          <span className="value">{stats.total_products || products.length}</span>
          <span className="subtext">{stats.active_products || 0} active in catalogue</span>
        </div>

        <div className="pd-kpi-card">
          <span className="label">PSA Systems (Finished Goods)</span>
          <span className="value">{stats.finished_goods_count || 0}</span>
          <span className="subtext">Engineered oxygen & nitrogen plants</span>
        </div>

        <div className="pd-kpi-card">
          <span className="label">Sub-Assemblies & Spares</span>
          <span className="value">{(stats.sub_assemblies_count || 0) + (stats.spare_parts_count || 0)}</span>
          <span className="subtext">{stats.sub_assemblies_count || 0} SAs • {stats.spare_parts_count || 0} spares</span>
        </div>

        <div className="pd-kpi-card">
          <span className="label">Raw Material Components</span>
          <span className="value">{stats.raw_materials_count || 0}</span>
          <span className="subtext">Linked to AVL & MRP II Shortage Engine</span>
        </div>
      </div>

      <div className="pd-panel" style={{ marginTop: 16, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.55, fontWeight: 700 }}>
              Clan → Josh reconciliation
            </div>
            <h2 style={{ margin: "6px 0 0", fontSize: 20 }}>Active Clan items not yet usable in Josh</h2>
            <p style={{ margin: "8px 0 0", fontSize: 13, opacity: 0.72, maxWidth: 720, lineHeight: 1.6 }}>
              Clan vs Product Master export checked against live products and this company's policies. Map missing items here;
              they stay inactive until HSN and GST % are filled in. Item codes stay locked after create.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={`pd-btn secondary ${clanCompany === "AI" ? "primary" : ""}`}
              onClick={() => setClanCompany("AI")}
            >
              AI
            </button>
            <button
              type="button"
              className={`pd-btn secondary ${clanCompany === "AT" ? "primary" : ""}`}
              onClick={() => setClanCompany("AT")}
            >
              AT
            </button>
            <button type="button" className="pd-btn secondary" onClick={() => loadClanGap(clanCompany)} disabled={clanGapLoading}>
              {clanGapLoading ? "Loading…" : "Refresh gap"}
            </button>
          </div>
        </div>

        {clanGapError ? (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: "#fff7f7", border: "1px solid #f2caca", color: "#8a1c1c", fontSize: 13 }}>
            {clanGapError}
          </div>
        ) : null}

        {clanGap?.ok ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              {CLAN_EXCEPTION_TABS.map(([key, label]) => {
                const count = key ? clanGap.counts?.[key] ?? 0 : CLAN_EXCEPTION_TABS.slice(1).reduce((sum, [k]) => sum + (clanGap.counts?.[k] || 0), 0);
                const active = clanType === key;
                return (
                  <button
                    key={key || "all"}
                    type="button"
                    onClick={() => setClanType(key)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 10,
                      border: `1px solid ${active ? "#1d4ed8" : "#e2e8f0"}`,
                      background: active ? "#eff6ff" : "#f8fafc",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {label} <span style={{ opacity: 0.7 }}>{count}</span>
                  </button>
                );
              })}
              <div style={{ padding: "8px 12px", fontSize: 12, opacity: 0.7 }}>
                Fully mapped: <strong>{clanGap.counts?.mapped ?? 0}</strong>
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
              Source: {clanGap.snapshot_file}
              {clanGap.snapshot_summary?.clan_file ? ` · Clan ${clanGap.snapshot_summary.clan_file}` : ""}
            </div>
            {clanMapNotice ? (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", fontSize: 13 }}>
                {clanMapNotice}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
              <button
                type="button"
                className="pd-btn primary"
                disabled={clanMapBusy || !clanSelected.length}
                onClick={() => mapClanItems()}
              >
                {clanMapBusy ? "Mapping…" : `Map selected (${clanSelected.length})`}
              </button>
              <button
                type="button"
                className="pd-btn secondary"
                disabled={clanMapBusy || !clanGap.mappable_count}
                onClick={() => setClanMapAllOpen(true)}
              >
                Map all open gaps ({clanGap.mappable_count || 0})
              </button>
              <span style={{ fontSize: 12, opacity: 0.65 }}>
                Showing {(clanGap.exceptions || []).length} of {clanGap.exceptions_total ?? 0}
              </span>
            </div>
            <div style={{ marginTop: 12, overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
              <table className="pd-table" style={{ width: "100%", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th align="left" style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all mappable rows"
                        checked={
                          clanMappableRows.length > 0 && clanMappableRows.every((row) => clanSelected.includes(row.item_code))
                        }
                        onChange={(e) => setClanSelected(e.target.checked ? clanMappableRows.map((row) => row.item_code) : [])}
                      />
                    </th>
                    <th align="left">Item code</th>
                    <th align="left">Name</th>
                    <th align="left">Category / Group</th>
                    <th align="left">Exception</th>
                    <th align="left">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(clanGap.exceptions || []).length ? (
                    clanGap.exceptions.map((row) => {
                      const mappable = CLAN_MAPPABLE.has(row.exception_type);
                      const tone = CLAN_EXCEPTION_TONE[row.exception_type] || CLAN_EXCEPTION_TONE.needs_review;
                      return (
                        <tr key={row.item_code}>
                          <td>
                            {mappable ? (
                              <input
                                type="checkbox"
                                aria-label={`Select ${row.item_code}`}
                                checked={clanSelected.includes(row.item_code)}
                                onChange={(e) =>
                                  setClanSelected((prev) =>
                                    e.target.checked ? [...prev, row.item_code] : prev.filter((code) => code !== row.item_code)
                                  )
                                }
                              />
                            ) : null}
                          </td>
                          <td style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>{row.item_code}</td>
                          <td>{row.item_name || "—"}</td>
                          <td>
                            {row.category || "—"}
                            <div style={{ fontSize: 11, opacity: 0.6 }}>{row.group || "—"}</div>
                          </td>
                          <td>
                            <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: tone.bg, color: tone.color }}>
                              {CLAN_EXCEPTION_LABEL[row.exception_type] || row.exception_type}
                            </span>
                            {row.reason ? <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{row.reason}</div> : null}
                          </td>
                          <td>
                            {row.product_id ? (
                              <button type="button" className="pd-btn secondary" onClick={() => findInCatalog(row.item_code)}>
                                Find in catalog
                              </button>
                            ) : row.exception_type === "needs_review" ? (
                              <span style={{ fontSize: 11, opacity: 0.7 }}>Fix in Clan export or create manually</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6} style={{ padding: 14, opacity: 0.7 }}>
                        No open Clan exceptions in this view for {clanGap.company_label}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{clanGap.import_hint}</div>
          </>
        ) : null}
      </div>

      {/* Main Panel */}
      <div className="pd-panel">
        {/* Navigation Tabs */}
        <div className="pd-tabs" style={{ padding: "10px 14px 0", background: "#ffffff" }}>
          <button
            type="button"
            className={`pd-tab ${activeTab === "all" ? "active" : ""}`}
            onClick={() => setActiveTab("all")}
          >
            All Products ({products.length})
          </button>
          <button
            type="button"
            className={`pd-tab ${activeTab === "finished_good" ? "active" : ""}`}
            onClick={() => setActiveTab("finished_good")}
          >
            Finished Goods (FGs)
          </button>
          <button
            type="button"
            className={`pd-tab ${activeTab === "sub_assembly" ? "active" : ""}`}
            onClick={() => setActiveTab("sub_assembly")}
          >
            Sub-Assemblies (SAs)
          </button>
          <button
            type="button"
            className={`pd-tab ${activeTab === "raw_material" ? "active" : ""}`}
            onClick={() => setActiveTab("raw_material")}
          >
            Raw Materials (RMs)
          </button>
          <button
            type="button"
            className={`pd-tab ${activeTab === "spare_part" ? "active" : ""}`}
            onClick={() => setActiveTab("spare_part")}
          >
            Spares & Consumables
          </button>
          <button
            type="button"
            className={`pd-tab ${activeTab === "quote_content" ? "active" : ""}`}
            onClick={() => setActiveTab("quote_content")}
          >
            Quote Write-ups
          </button>
        </div>

        {activeTab === "quote_content" ? (
          <QuoteFamilyContentEditor />
        ) : (
        <>
        {/* Filter and Search Bar */}
        <form className="pd-filter-bar" onSubmit={handleSearchSubmit}>
          <input
            type="text"
            className="pd-search-input"
            placeholder="Search SKU, name, HSN code, or make..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <select
            className="pd-select"
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
          >
            <option value="">All Categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.category_name}
              </option>
            ))}
          </select>

          <select
            className="pd-select"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="">All Item Types</option>
            <option value="finished_good">Finished Good</option>
            <option value="sub_assembly">Sub-Assembly</option>
            <option value="raw_material">Raw Material</option>
            <option value="spare_part">Spare Part</option>
          </select>

          <button type="submit" className="pd-btn secondary">
            Filter
          </button>
          {searchQuery && (
            <button
              type="button"
              className="pd-btn secondary"
              onClick={() => {
                setSearchQuery("");
                loadData();
              }}
            >
              Clear
            </button>
          )}
        </form>

        {/* Responsive Data Table */}
        <div className="pd-table-responsive">
          <table className="pd-table">
            <thead>
              <tr>
                <SortTh column="sku" label="SKU Code" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 140 }} />
                <SortTh column="item_name" label="Product Description & Model" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} />
                <SortTh column="item_type" label="Classification" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 120 }} />
                <SortTh column="uom" label="UOM" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 70 }} />
                <SortTh column="hsn_no" label="HSN Code" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 90 }} />
                <SortTh column="standard_cost" label="Standard Cost" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 110, textAlign: "right" }} align="right" />
                <SortTh column="selling_price" label="Selling Price" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 110, textAlign: "right" }} align="right" />
                <SortTh column="min_safety_stock" label="Safety Stock" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 90, textAlign: "right" }} align="right" />
                <SortTh column="preferred_avl" label="Preferred AVL" sort={sort} spec={PRODUCT_SORT_SPEC} onSort={onSort} style={{ width: 130 }} />
                <th style={{ width: 90, textAlign: "center" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: "24px", color: "#64748b" }}>
                    Loading product catalog...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: "24px", color: "#dc2626" }}>
                    {error}
                  </td>
                </tr>
              ) : sortedProducts.length === 0 ? (
                <tr>
                  <td colSpan={10} style={{ textAlign: "center", padding: "24px", color: "#64748b" }}>
                    No products found matching the criteria.
                  </td>
                </tr>
              ) : (
                sortedProducts.map((p) => {
                  const rawType = (p.item_type || "finished_good").toLowerCase();
                  const typeClass =
                    rawType === "fg" || rawType === "finished_good"
                      ? "finished_good"
                      : rawType === "rm" || rawType === "raw_material"
                      ? "raw_material"
                      : rawType === "sa" || rawType === "sub_assembly"
                      ? "sub_assembly"
                      : rawType === "spare" || rawType === "spare_part"
                      ? "spare_part"
                      : rawType;

                  const typeLabel =
                    typeClass === "finished_good"
                      ? "Finished Good"
                      : typeClass === "raw_material"
                      ? "Raw Material"
                      : typeClass === "sub_assembly"
                      ? "Sub-Assembly"
                      : typeClass === "spare_part"
                      ? "Spare Part"
                      : p.item_type || "Finished Good";

                  const sourcingDisplay =
                    p.preferred_vendor_name ||
                    (p.sourcing_mode === "buy_intercompany"
                      ? "Intercompany (AT)"
                      : p.sourcing_mode === "manufacture" || p.is_manufactured
                      ? "Internal Manufacturing"
                      : "—");

                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="pd-sku-badge">{p.sku || p.item_code}</span>
                      </td>
                      <td>
                        <strong style={{ display: "block", color: "#0f172a" }}>{p.item_name}</strong>
                        <small style={{ color: "#64748b" }}>
                          {p.category_name} {p.group_name ? `• ${p.group_name}` : ""}
                        </small>
                      </td>
                      <td>
                        <span className={`pd-chip ${typeClass}`}>
                          {typeLabel}
                        </span>
                      </td>
                      <td>{p.uom || "NOS"}</td>
                      <td>{p.hsn_no || "—"}</td>
                      <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                        {formatCurrency(p.standard_cost)}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                        {formatCurrency(p.selling_price || p.list_price)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {p.min_safety_stock ? `${p.min_safety_stock} ${p.uom || ""}` : "—"}
                      </td>
                      <td>
                        <small style={{ color: "#475569" }}>
                          {sourcingDisplay}
                        </small>
                      </td>
                      <td style={{ textAlign: "center" }}>
                        <div style={{ display: "flex", justifyContent: "center", gap: 4 }}>
                          <button
                            type="button"
                            className="pd-btn-action"
                            title="Edit Product"
                            onClick={() => handleEditProduct(p)}
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="pd-btn-action delete"
                            title="Delete Product"
                            onClick={() => handleDeleteProduct(p)}
                          >
                            🗑️
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        </>
        )}
      </div>

      {/* Product Creation / Edit Modal */}
      <ProductModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        product={selectedProduct}
        categories={categories}
        groups={groups}
        onSave={handleSaveProduct}
        saving={saving}
      />

      {/* Bulk Excel Operations Modal */}
      <BulkExcelModal
        isOpen={bulkExcelOpen}
        onClose={() => setBulkExcelOpen(false)}
        onImportSuccess={() => {
          loadData();
        }}
      />

      <TypedConfirmModal
        open={clanMapAllOpen}
        title={`Map all open Clan gaps for ${clanCompany}`}
        message={`Creates ${clanGap?.counts?.not_in_josh || 0} inactive products and adds ${clanCompany} policies for ${clanGap?.mappable_count || 0} items. Rows marked "Needs review" are skipped. Item codes cannot be changed afterwards.`}
        confirmPhrase={`MAP ${clanCompany}`}
        confirmLabel="Map all"
        busy={clanMapBusy}
        onCancel={() => setClanMapAllOpen(false)}
        onConfirm={(typed) => mapClanItems({ all: true, confirmPhrase: typed })}
      />
      <TypedConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete product permanently"
        message={`Removes ${deleteTarget?.item_code || deleteTarget?.sku || "this SKU"} and its company policies. Products used in BOMs, work orders, or transactions cannot be deleted — deactivate them instead.`}
        confirmPhrase={`DELETE ${String(deleteTarget?.item_code || deleteTarget?.sku || deleteTarget?.id || "").trim()}`}
        confirmLabel="Delete permanently"
        busy={deleteBusy}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteProduct}
      />
    </div>
  );
}
