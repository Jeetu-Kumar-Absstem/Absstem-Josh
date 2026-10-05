import { useEffect, useMemo, useRef, useState } from "react";
import AvlManagerModal from "../inventory/AvlManagerModal";
import {
  HeaderChip,
  PageHero,
  ValveLockToggle,
  toast,
} from "../shared/joshUi";

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

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatQtyCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 100) return n.toFixed(1);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(4);
}

function emptyLine() {
  return {
    component_product_id: null,
    component_specification_id: null,
    item_code: "",
    item_name: "",
    uom: "",
    qty_per: 1,
    remarks: "",
    spec_code: "",
    spec_name: "",
    spec_geometry: "",
    spec_material: "",
    spec_pressure_rating: "",
  };
}

function createDraft() {
  return {
    id: null,
    bom_code: "",
    finished_good_product_id: "",
    revision_no: 1,
    is_active: true,
    lifecycle_state: "Draft",
    remarks: "",
    is_inherited: false,
    inherited_from_company_code: "",
    intercompany_source_company_name: "",
    lines: [emptyLine()],
  };
}

function normalizeBomToDraft(bom, lines) {
  return {
    id: bom?.id || null,
    bom_code: bom?.bom_code || "",
    finished_good_product_id: bom?.finished_good_product_id ? String(bom.finished_good_product_id) : "",
    revision_no: bom?.revision_no || 1,
    is_active: bom?.is_active !== false,
    lifecycle_state: bom?.lifecycle_state || "Draft",
    remarks: bom?.remarks || "",
    is_inherited: Boolean(bom?.is_inherited),
    inherited_from_company_code: bom?.inherited_from_company_code || bom?.bom_company_code || "",
    intercompany_source_company_name: bom?.intercompany_source_company_name || "",
    lines: Array.isArray(lines) && lines.length
      ? lines.map((line) => ({
          component_product_id: line.component_product_id,
          component_specification_id: line.component_specification_id || null,
          item_code: line.item_code || "",
          item_name: line.item_name || "",
          uom: line.uom || "",
          qty_per: line.qty_per,
          remarks: line.remarks || "",
          spec_code: line.spec_code || "",
          spec_name: line.spec_name || "",
          spec_geometry: line.spec_geometry || "",
          spec_material: line.spec_material || "",
          spec_pressure_rating: line.spec_pressure_rating || "",
        }))
      : [emptyLine()],
  };
}

function canApproveBom(me) {
  if (!me) return false;
  if (me.group_name === "SuperAdmin") return true;
  const roleKey = String(me.role_key || "").toLowerCase();
  if (roleKey === "super_admin" || roleKey === "engineering_approver") return true;
  return Boolean(me?.screens?.manufacturing_boms?.can_approve || me?.permissions?.screens?.manufacturing_boms?.can_approve);
}

export default function ManufacturingBoms({ me = null, launch = null, onConsumeLaunch = null } = {}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [finishedGoods, setFinishedGoods] = useState([]);
  const [readinessItems, setReadinessItems] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [draft, setDraft] = useState(createDraft());
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupItems, setLookupItems] = useState([]);
  const [fgSearch, setFgSearch] = useState("");
  const [readinessFilter, setReadinessFilter] = useState("all");
  const [specOptions, setSpecOptions] = useState([]);
  const [avlSpecId, setAvlSpecId] = useState(null);
  const fileInputRef = useRef(null);

  const isLocked = String(draft.lifecycle_state || "") === "Locked/Active";
  const approver = canApproveBom(me);
  const isInherited = Boolean(draft.is_inherited);
  const fieldsLocked = isLocked || isInherited;

  const selectedFg = useMemo(
    () => finishedGoods.find((item) => String(item.id) === String(draft.finished_good_product_id)) || null,
    [finishedGoods, draft.finished_good_product_id]
  );
  const selectedReadiness = useMemo(
    () => readinessItems.find((item) => String(item.id) === String(draft.finished_good_product_id)) || null,
    [readinessItems, draft.finished_good_product_id]
  );
  const validLines = useMemo(
    () => draft.lines.filter((line) => Number(line.component_product_id) > 0),
    [draft.lines]
  );
  const totalQtyPer = useMemo(
    () => validLines.reduce((sum, line) => sum + qty(line.qty_per), 0),
    [validLines]
  );
  const editorReady = Boolean(selectedFg || draft.finished_good_product_id);

  useEffect(() => {
    refresh().catch(() => {});
    apiFetch("/inventory/specs")
      .then((data) => setSpecOptions(Array.isArray(data?.specifications) ? data.specifications : []))
      .catch(() => setSpecOptions([]));
  }, []);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await refresh();
        if (cancelled) return;
        if (launch.readiness_status) {
          setReadinessFilter(String(launch.readiness_status));
        } else if (launch.focus === "setup_gaps" || launch.focus === "fg_setup_gaps") {
          setReadinessFilter("setup_gaps");
        } else if (launch.focus === "bom_gaps") {
          setReadinessFilter("bom_gaps");
        }
        if (launch.bom_id) {
          const bomData = await apiFetch(`/manufacturing-boms/${Number(launch.bom_id)}`);
          if (cancelled) return;
          setDraft(normalizeBomToDraft(bomData?.bom, bomData?.lines));
          setNotice("Opened BOM from deep link.");
        } else if (launch.finished_good_product_id) {
          const fgId = String(launch.finished_good_product_id);
          const match =
            (data?.readiness || []).find((item) => String(item.id) === fgId) ||
            (data?.finishedGoods || []).find((item) => String(item.id) === fgId) ||
            null;
          if (match) {
            selectFgCard(match);
          } else {
            setDraft((prev) => ({
              ...prev,
              finished_good_product_id: fgId,
              bom_code: prev.bom_code || launch.finished_good_item_code || "",
            }));
            setNotice(`Loaded FG #${fgId} into BOM editor.`);
          }
        }
      } catch {
      } finally {
        if (typeof onConsumeLaunch === "function") onConsumeLaunch();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch]);

  useEffect(() => {
    const q = String(lookupQuery || "").trim();
    if (q.length < 2) {
      setLookupItems([]);
      setLookupLoading(false);
      return undefined;
    }
    let active = true;
    setLookupLoading(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/manufacturing-boms/product-lookup?q=${encodeURIComponent(q)}`);
        if (!active) return;
        setLookupItems(Array.isArray(data?.products) ? data.products : []);
      } catch (e) {
        if (!active) return;
        setError(e?.data?.error || "Failed to search components.");
      } finally {
        if (active) setLookupLoading(false);
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [lookupQuery]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [bootstrapData, listData] = await Promise.all([
        apiFetch("/manufacturing-boms/bootstrap"),
        apiFetch("/manufacturing-boms"),
      ]);
      const nextFinishedGoods = Array.isArray(bootstrapData?.finished_goods) ? bootstrapData.finished_goods : [];
      const nextReadiness = Array.isArray(bootstrapData?.readiness) ? bootstrapData.readiness : [];
      const nextItems = Array.isArray(listData?.boms) ? listData.boms : [];
      setFinishedGoods(nextFinishedGoods);
      setReadinessItems(nextReadiness);
      setDashboard(bootstrapData?.dashboard || null);
      setItems(nextItems);
      return { finishedGoods: nextFinishedGoods, readiness: nextReadiness, boms: nextItems };
    } catch (e) {
      setError(e?.data?.error || "Failed to load BOMs.");
      throw e;
    } finally {
      setLoading(false);
    }
  }

  async function loadList() {
    const data = await apiFetch("/manufacturing-boms");
    setItems(Array.isArray(data?.boms) ? data.boms : []);
    return data;
  }

  function resetDraft() {
    setDraft(createDraft());
    setLookupItems([]);
    setLookupQuery("");
    setError("");
    setNotice("");
  }

  async function openBom(id) {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/manufacturing-boms/${id}`);
      setDraft(normalizeBomToDraft(data?.bom, data?.lines));
      setNotice("");
    } catch (e) {
      setError(e?.data?.error || "Failed to load BOM.");
    } finally {
      setLoading(false);
    }
  }

  async function selectFgCard(row) {
    setError("");
    setNotice("");
    // If FG has an existing active BOM (local or inherited), load it directly
    if (row.latest_active_bom_id) {
      try {
        await openBom(row.latest_active_bom_id);
        if (row.is_inherited) {
          setNotice(`Viewing active BOM inherited from ${row.bom_company_code || "AT"} master.`);
        } else {
          setNotice(`Loaded active BOM for ${row.item_code}.`);
        }
        return;
      } catch (err) {
        console.warn("Failed to load active BOM, falling back to new draft", err);
      }
    }

    // Otherwise create draft for this FG
    setDraft({
      ...createDraft(),
      finished_good_product_id: String(row.id),
      bom_code: row.item_code || "",
      is_inherited: Boolean(row.is_inherited),
      inherited_from_company_code: row.bom_company_code || "",
      intercompany_source_company_name: row.intercompany_source_company_name || "",
    });
    setNotice(`Ready to draft BOM for ${row.item_code}.`);
  }

  function addComponent(product) {
    if (!product?.id) return;
    setDraft((prev) => {
      if (prev.lines.some((line) => Number(line.component_product_id) === Number(product.id))) return prev;
      return {
        ...prev,
        lines: [
          ...prev.lines.filter((line) => line.component_product_id),
          {
            component_product_id: product.id,
            component_specification_id: null,
            item_code: product.item_code || "",
            item_name: product.item_name || "",
            uom: product.uom || "",
            qty_per: 1,
            remarks: "",
            spec_code: "",
            spec_name: "",
            spec_geometry: "",
            spec_material: "",
            spec_pressure_rating: "",
          },
        ],
      };
    });
  }

  function updateLine(index, patch) {
    setDraft((prev) => ({
      ...prev,
      lines: prev.lines.map((line, idx) => (idx === index ? { ...line, ...patch } : line)),
    }));
  }

  function removeLine(index) {
    setDraft((prev) => ({
      ...prev,
      lines: prev.lines.filter((_, idx) => idx !== index).length
        ? prev.lines.filter((_, idx) => idx !== index)
        : [emptyLine()],
    }));
  }

  const readinessStats = useMemo(() => {
    const total = readinessItems.length;
    const ready = readinessItems.filter((item) => item.ready_for_job).length;
    const missingBom = readinessItems.filter((item) => ["missing_active_bom", "empty_bom"].includes(item.readiness_status)).length;
    const inherited = readinessItems.filter((item) => item.is_inherited || item.sourcing_mode === "buy_intercompany").length;
    return { total, ready, missingBom, inherited };
  }, [readinessItems]);

  const filteredCatalogItems = useMemo(() => {
    let list = readinessItems;
    if (readinessFilter === "ready") {
      list = list.filter((item) => item.ready_for_job);
    } else if (readinessFilter === "bom_gaps") {
      list = list.filter((item) => ["missing_active_bom", "empty_bom"].includes(String(item.readiness_status || "")));
    } else if (readinessFilter === "inherited") {
      list = list.filter((item) => item.is_inherited || item.sourcing_mode === "buy_intercompany");
    }

    const q = fgSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (item) =>
        (item.item_code && item.item_code.toLowerCase().includes(q)) ||
        (item.item_name && item.item_name.toLowerCase().includes(q)) ||
        (item.mfg_job_prefix && item.mfg_job_prefix.toLowerCase().includes(q))
    );
  }, [readinessItems, readinessFilter, fgSearch]);

  async function reviseAsCopy() {
    if (!draft.id) {
      setError("Save the BOM first, then create a new revision.");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/manufacturing-boms/${draft.id}/revise`, {
        method: "POST",
        body: JSON.stringify({ deactivate_prior: true }),
      });
      setDraft(normalizeBomToDraft(data?.bom, data?.lines));
      await refresh();
      setNotice(`Created revision ${data?.bom?.revision_no || ""} from prior BOM. Prior revisions deactivated.`);
    } catch (e) {
      setError(e?.data?.error || "Failed to create BOM revision.");
    } finally {
      setSaving(false);
    }
  }

  async function importCsvFile(file) {
    if (!file) return;
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const csv = await file.text();
      const data = await apiFetch("/manufacturing-boms/import", {
        method: "POST",
        body: JSON.stringify({ csv }),
      });
      await refresh();
      const created = Number(data?.created_count || 0);
      const updated = Number(data?.updated_count || 0);
      const errors = Number(data?.error_count || 0);
      setNotice(`Import complete: ${created} created, ${updated} updated${errors ? `, ${errors} row issues` : ""}.`);
      if (errors && Array.isArray(data?.errors) && data.errors[0]) {
        setError(`First import issue: ${data.errors[0].error}${data.errors[0].item_code ? ` (${data.errors[0].item_code})` : ""}`);
      }
    } catch (e) {
      setError(e?.data?.error || "Failed to import BOM CSV.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        bom_code: draft.bom_code || null,
        finished_good_product_id: draft.finished_good_product_id ? Number(draft.finished_good_product_id) : null,
        revision_no: Number(draft.revision_no) || 1,
        is_active: Boolean(draft.is_active),
        remarks: draft.remarks || null,
        lines: draft.lines
          .filter((line) => Number(line.component_product_id) > 0)
          .map((line) => ({
            component_product_id: Number(line.component_product_id),
            component_specification_id: line.component_specification_id
              ? Number(line.component_specification_id)
              : null,
            qty_per: qty(line.qty_per),
            remarks: line.remarks || null,
          })),
      };

      const data = draft.id
        ? await apiFetch(`/manufacturing-boms/${draft.id}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiFetch("/manufacturing-boms", { method: "POST", body: JSON.stringify(payload) });

      setDraft(normalizeBomToDraft(data?.bom, data?.lines));
      await refresh();
      setNotice(draft.id ? "BOM updated successfully." : "BOM created successfully.");
      toast(draft.id ? "BOM updated." : "BOM created.", "success");
    } catch (e) {
      const code = e?.data?.error || "";
      if (code === "PRODUCT_NOT_MARKED_MANUFACTURED") setError("Select a finished good that is marked as Manufactured FG in Product Master.");
      else if (code === "PRODUCT_MFG_PREFIX_MISSING") setError("Selected finished good is missing manufacturing prefix in Product Master.");
      else if (code === "PRODUCT_INTERCOMPANY_SUPPLIED") setError("This finished good is supplied from the intercompany source company.");
      else if (code === "BOM_LINES_REQUIRED") setError("Add at least one component line.");
      else if (code === "DUPLICATE_BOM_CODE") setError("This BOM code already exists.");
      else if (code === "BOM_LOCKED") {
        setError(e?.data?.detail || "This master BOM is Locked/Active. Clone a Draft revision before editing.");
        toast(e?.data?.detail || "BOM locked — revise to clone a Draft.", "error");
      } else if (code === "SERVICE_ONLY_COMPONENT_FORBIDDEN") {
        setError(e?.data?.detail || "Active - Service Only items cannot be used on a production BOM (Racmet freeze).");
        toast("Service-only SKU blocked on production BOM.", "error");
      } else setError(code || "Failed to save BOM.");
    } finally {
      setSaving(false);
    }
  }

  async function approveMasterBom() {
    if (!draft.id || !approver) return;
    setApproving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/inventory/bom/${draft.id}/approve`, { method: "POST" });
      setDraft(normalizeBomToDraft(data?.bom, data?.lines));
      await refresh();
      setNotice("Master BOM Locked/Active — shop floor must adhere to this revision.");
      toast("BOM approved and locked", "success");
    } catch (e) {
      const msg = e?.data?.detail || e?.data?.error || "Approval failed.";
      setError(msg);
      toast(msg, "error");
    } finally {
      setApproving(false);
    }
  }

  async function onValveChange(nextLocked) {
    if (!nextLocked) {
      toast("Unlock is not direct — use Revise to clone a Draft from this locked master.", "info");
      return;
    }
    if (!draft.id) {
      toast("Save the BOM draft before locking.", "warning");
      return;
    }
    if (isLocked) return;
    await approveMasterBom();
  }

  async function downloadTemplate() {
    setError("");
    setNotice("");
    try {
      const res = await fetch("/manufacturing-boms/import/template", { credentials: "include" });
      if (!res.ok) {
        setError("Failed to download template.");
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "BOM_Template.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setNotice("CSV template downloaded.");
    } catch {
      setError("Failed to download template.");
    }
  }

  return (
    <div style={{ maxWidth: "100%", display: "grid", gap: 12, paddingBottom: 32 }}>
      {/* Macro Top Summary */}
      <PageHero
        eyebrow="Precision Gas Systems & Assembly Recipes"
        title="Manufacturing BOM & Recipe Master"
        description="Search Finished Goods catalog, build component recipes, and maintain AVL specifications across entities."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="pd-btn-secondary" onClick={resetDraft} style={{ padding: "6px 12px", fontSize: 13 }}>
              + New BOM
            </button>
            {draft.id && !isInherited ? (
              <button type="button" className="pd-btn-secondary" onClick={() => reviseAsCopy().catch(() => {})} disabled={saving} style={{ padding: "6px 12px", fontSize: 13 }}>
                Revise (Clone)
              </button>
            ) : null}
            <button type="button" className="pd-btn-secondary" onClick={() => downloadTemplate().catch(() => {})} style={{ padding: "6px 12px", fontSize: 13 }}>
              CSV Template
            </button>
            <button type="button" className="pd-btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={importing} style={{ padding: "6px 12px", fontSize: 13 }}>
              {importing ? "Importing…" : "Import CSV"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => importCsvFile(e.target.files?.[0]).catch(() => {})}
            />
            <button type="button" className="pd-btn-secondary" onClick={() => refresh().catch(() => {})} disabled={loading} style={{ padding: "6px 12px", fontSize: 13 }}>
              {loading ? "..." : "Refresh"}
            </button>
          </div>
        }
        stats={[
          { label: "FG Candidates", value: readinessStats.total, tone: "#143d7a" },
          { label: "Ready Now", value: readinessStats.ready, tone: "#0a7a35" },
          { label: "BOM Gaps", value: readinessStats.missingBom, tone: "#8b5a00" },
          { label: "Inherited (AT)", value: readinessStats.inherited, tone: "#2563eb" },
        ]}
      />

      {error ? (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600 }}>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600 }}>
          {notice}
        </div>
      ) : null}

      {/* MASTER-DETAIL SIDE-BY-SIDE WORKSPACE (Optimized for 14-inch screens) */}
      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        
        {/* LEFT SIDEBAR RAIL: SEARCHABLE FG CATALOG (320px) */}
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            maxHeight: "calc(100vh - 180px)",
            position: "sticky",
            top: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: "#1e293b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              FG Catalog
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", background: "#f1f5f9", padding: "2px 6px", borderRadius: 6 }}>
              {filteredCatalogItems.length} items
            </div>
          </div>

          {/* Search Input */}
          <input
            type="text"
            value={fgSearch}
            onChange={(e) => setFgSearch(e.target.value)}
            placeholder="Search SKU code / name..."
            style={{
              width: "100%",
              padding: "6px 10px",
              fontSize: 12,
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              background: "#f8fafc",
            }}
          />

          {/* Filter Pills */}
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {[
              { key: "all", label: "All" },
              { key: "ready", label: "Ready" },
              { key: "bom_gaps", label: "Gaps" },
              { key: "inherited", label: "Inherited" },
            ].map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setReadinessFilter(f.key)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  padding: "3px 8px",
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 12,
                  background: readinessFilter === f.key ? "#2563eb" : "#f1f5f9",
                  color: readinessFilter === f.key ? "#ffffff" : "#475569",
                  border: "1px solid",
                  borderColor: readinessFilter === f.key ? "#1d4ed8" : "#e2e8f0",
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Scrollable FG Item List */}
          <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, paddingRight: 2, flex: 1 }}>
            {filteredCatalogItems.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", fontSize: 12, color: "#94a3b8" }}>
                No finished goods found.
              </div>
            ) : (
              filteredCatalogItems.map((row) => {
                const isSelected = String(draft.finished_good_product_id) === String(row.id);
                const hasInherited = Boolean(row.is_inherited || row.sourcing_mode === "buy_intercompany");
                const isReady = Boolean(row.ready_for_job);

                let statusBadgeBg = "#fef3c7";
                let statusBadgeColor = "#92400e";
                let statusBadgeText = "BOM Gap";

                if (hasInherited && row.active_bom_count > 0) {
                  statusBadgeBg = "#dbeafe";
                  statusBadgeColor = "#1e40af";
                  statusBadgeText = `Inherited ${row.bom_company_code || "AT"}`;
                } else if (isReady) {
                  statusBadgeBg = "#dcfce7";
                  statusBadgeColor = "#166534";
                  statusBadgeText = "Ready";
                }

                return (
                  <div
                    key={row.id}
                    onClick={() => selectFgCard(row)}
                    style={{
                      cursor: "pointer",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid",
                      borderColor: isSelected ? "#3b82f6" : "#e2e8f0",
                      background: isSelected ? "#eff6ff" : "#ffffff",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: isSelected ? "#1d4ed8" : "#0f172a", lineHeight: 1.2 }}>
                        {row.item_code}
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: statusBadgeBg,
                          color: statusBadgeColor,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {statusBadgeText}
                      </span>
                    </div>

                    <div style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.item_name}
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                      <span>Prefix: {row.mfg_job_prefix || "—"}</span>
                      <span>{row.active_bom_count > 0 ? `Active BOM (${row.latest_active_line_count || 0} lines)` : "No Active BOM"}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHT MAIN CANVAS: ACTIVE RECIPE COMPONENT BUILDER */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          
          {/* Intercompany Status Banner */}
          {isInherited ? (
            <div
              style={{
                background: "linear-gradient(90deg, #eff6ff 0%, #f0f9ff 100%)",
                border: "1px solid #bfdbfe",
                borderRadius: 10,
                padding: "10px 14px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>ℹ️</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#1e40af" }}>
                    Inherited from {draft.intercompany_source_company_name || `Absstem (${draft.inherited_from_company_code || "AT"})`} Master BOM
                  </div>
                  <div style={{ fontSize: 11, color: "#3b82f6" }}>
                    Live for Shop-Floor Kitting & Issuance in Absstem Industrial (AI). Direct recipe changes are managed at source authoring entity.
                  </div>
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 8px",
                  borderRadius: 6,
                  background: "#dbeafe",
                  color: "#1e40af",
                  border: "1px solid #93c5fd",
                }}
              >
                Locked/Active Master
              </span>
            </div>
          ) : null}

          {/* Header & Governance Card */}
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b" }}>
                  Active Assembly Recipe
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", marginTop: 2 }}>
                  {selectedFg ? `${selectedFg.item_code} — ${selectedFg.item_name}` : "Select a Finished Good to View or Build Recipe"}
                </div>
                {selectedFg ? (
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                    UOM: <strong style={{ color: "#334155" }}>{selectedFg.uom || "NOS"}</strong> • Sourcing Mode: <strong style={{ color: "#334155" }}>{selectedFg.sourcing_mode || "manufacture"}</strong> • Job Prefix: <strong style={{ color: "#334155" }}>{selectedFg.mfg_job_prefix || "—"}</strong>
                  </div>
                ) : null}
              </div>

              {/* Governance & Valve Lock */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <HeaderChip
                  label={draft.lifecycle_state || "Draft"}
                  tone={isLocked ? "#0a7a35" : draft.lifecycle_state === "Pending Review" ? "#8b5a00" : "#234a8f"}
                  background={isLocked ? "#effcf3" : draft.lifecycle_state === "Pending Review" ? "#fff6e8" : "#eef4ff"}
                />
                {!isInherited && (
                  <ValveLockToggle
                    locked={isLocked}
                    disabled={!draft.id || approving || (!approver && !isLocked)}
                    onChange={onValveChange}
                    lockedHint="Locked master"
                    unlockedHint={approver ? "Turn to Lock" : "Approver required"}
                  />
                )}
              </div>
            </div>

            {/* BOM Metadata Inputs */}
            <div style={{ display: "grid", gridTemplateColumns: "180px 100px 120px 1fr", gap: 10, alignItems: "end", background: "#f8fafc", padding: 10, borderRadius: 8, border: "1px solid #e2e8f0" }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 3 }}>
                  BOM Code
                </label>
                <input
                  disabled={fieldsLocked}
                  value={draft.bom_code}
                  onChange={(e) => setDraft((prev) => ({ ...prev, bom_code: e.target.value }))}
                  placeholder="Auto if blank"
                  style={{ width: "100%", height: 32, padding: "0 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 3 }}>
                  Revision No
                </label>
                <input
                  disabled={fieldsLocked}
                  type="number"
                  min="1"
                  value={draft.revision_no}
                  onChange={(e) => setDraft((prev) => ({ ...prev, revision_no: e.target.value }))}
                  style={{ width: "100%", height: 32, padding: "0 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>

              <div style={{ paddingBottom: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#334155", cursor: "pointer" }}>
                  <input
                    disabled={fieldsLocked}
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(e) => setDraft((prev) => ({ ...prev, is_active: e.target.checked }))}
                  />
                  Active BOM
                </label>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#475569", marginBottom: 3 }}>
                  Remarks / Engineering Notes
                </label>
                <input
                  disabled={fieldsLocked}
                  value={draft.remarks}
                  onChange={(e) => setDraft((prev) => ({ ...prev, remarks: e.target.value }))}
                  placeholder="Optional assembly notes..."
                  style={{ width: "100%", height: 32, padding: "0 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
              </div>
            </div>
          </div>

          {/* Component Search & Live Component Table */}
          <div style={{ display: "grid", gridTemplateColumns: fieldsLocked ? "1fr" : "300px minmax(0, 1fr)", gap: 12, alignItems: "start" }}>
            
            {/* Component Search Dropdown (Hidden if Locked/Inherited to maximize table real estate) */}
            {!fieldsLocked && (
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 12,
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13, color: "#1e293b" }}>
                  + Add Components
                </div>
                <div style={{ fontSize: 11, color: "#64748b" }}>
                  Search RM and bought-out parts:
                </div>
                <input
                  value={lookupQuery}
                  onChange={(e) => setLookupQuery(e.target.value)}
                  placeholder="Type SKU or part name..."
                  style={{ width: "100%", height: 32, padding: "0 8px", fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1" }}
                />
                <div style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {lookupLoading && <div style={{ fontSize: 11, color: "#64748b" }}>Searching parts…</div>}
                  {!lookupLoading && lookupQuery.trim().length >= 2 && lookupItems.length === 0 && (
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>No matching parts found.</div>
                  )}
                  {lookupItems.map((item) => {
                    const alreadyAdded = validLines.some((l) => Number(l.component_product_id) === Number(item.id));
                    return (
                      <div
                        key={item.id}
                        onClick={() => !alreadyAdded && addComponent(item)}
                        style={{
                          padding: "6px 8px",
                          borderRadius: 6,
                          border: "1px solid #e2e8f0",
                          background: alreadyAdded ? "#f8fafc" : "#ffffff",
                          cursor: alreadyAdded ? "default" : "pointer",
                          opacity: alreadyAdded ? 0.6 : 1,
                        }}
                      >
                        <div style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{item.item_code}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>{item.item_name}</div>
                        <div style={{ fontSize: 10, color: "#94a3b8", display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                          <span>UOM: {item.uom || "—"}</span>
                          <span>{alreadyAdded ? "Added" : `Stock: ${formatQtyCompact(item.stock_qty)}`}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* High-Density Component Table */}
            <div
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: "#1e293b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Recipe Components ({validLines.length} lines)
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#2563eb", background: "#eff6ff", padding: "3px 8px", borderRadius: 6 }}>
                  Total Unit Qty: {formatQtyCompact(totalQtyPer)}
                </div>
              </div>

              {validLines.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", border: "1px dashed #cbd5e1", borderRadius: 8, color: "#94a3b8", fontSize: 13 }}>
                  No recipe lines added yet. Search parts on the left rail to add to this BOM.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#475569" }}>
                        <th style={{ padding: "6px 8px", width: 35, textAlign: "center" }}>#</th>
                        <th style={{ padding: "6px 8px", textAlign: "left" }}>Component Item & Specification</th>
                        <th style={{ padding: "6px 8px", width: 70, textAlign: "center" }}>UOM</th>
                        <th style={{ padding: "6px 8px", width: 110, textAlign: "right" }}>Qty / Unit</th>
                        <th style={{ padding: "6px 8px", textAlign: "left" }}>Remarks</th>
                        {!fieldsLocked && <th style={{ padding: "6px 8px", width: 50, textAlign: "center" }}>Del</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {draft.lines.map((line, index) =>
                        Number(line.component_product_id) > 0 ? (
                          <tr key={index} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ padding: "6px 8px", color: "#94a3b8", fontWeight: 700, textAlign: "center" }}>{index + 1}</td>
                            <td style={{ padding: "6px 8px" }}>
                              <div style={{ fontWeight: 700, color: "#1e293b" }}>{line.item_code}</div>
                              <div style={{ fontSize: 11, color: "#64748b" }}>{line.item_name}</div>
                              
                              {/* Spec selector & AVL badge */}
                              {!fieldsLocked ? (
                                <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center" }}>
                                  <select
                                    value={line.component_specification_id ? String(line.component_specification_id) : ""}
                                    onChange={(e) => {
                                      const sid = e.target.value ? Number(e.target.value) : null;
                                      const match = specOptions.find((s) => Number(s.id) === Number(sid));
                                      updateLine(index, {
                                        component_specification_id: sid,
                                        spec_code: match?.spec_code || "",
                                        spec_name: match?.spec_name || "",
                                        spec_geometry: match?.geometry || "",
                                        spec_material: match?.material || "",
                                        spec_pressure_rating: match?.pressure_rating || "",
                                      });
                                    }}
                                    style={{ fontSize: 11, padding: "2px 4px", borderRadius: 4, border: "1px solid #cbd5e1", maxWidth: 220 }}
                                  >
                                    <option value="">Generic Spec (Optional)...</option>
                                    {specOptions.map((s) => (
                                      <option key={s.id} value={String(s.id)}>
                                        {s.spec_code} · {s.spec_name}
                                      </option>
                                    ))}
                                  </select>
                                  {line.component_specification_id ? (
                                    <button
                                      type="button"
                                      onClick={() => setAvlSpecId(Number(line.component_specification_id))}
                                      style={{
                                        all: "unset",
                                        cursor: "pointer",
                                        fontSize: 10,
                                        fontWeight: 700,
                                        padding: "1px 6px",
                                        borderRadius: 4,
                                        background: "#dbeafe",
                                        color: "#1e40af",
                                      }}
                                    >
                                      AVL
                                    </button>
                                  ) : null}
                                </div>
                              ) : (
                                line.spec_code ? (
                                  <div style={{ fontSize: 11, color: "#2563eb", marginTop: 2, display: "flex", gap: 6, alignItems: "center" }}>
                                    <span>Spec: <strong>{line.spec_code}</strong> ({line.spec_name})</span>
                                    {line.component_specification_id ? (
                                      <button
                                        type="button"
                                        onClick={() => setAvlSpecId(Number(line.component_specification_id))}
                                        style={{
                                          all: "unset",
                                          cursor: "pointer",
                                          fontSize: 10,
                                          fontWeight: 700,
                                          padding: "1px 5px",
                                          borderRadius: 4,
                                          background: "#eff6ff",
                                          color: "#1e40af",
                                          border: "1px solid #bfdbfe",
                                        }}
                                      >
                                        View AVL
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null
                              )}
                            </td>
                            <td style={{ padding: "6px 8px", color: "#475569", textAlign: "center" }}>{line.uom || "—"}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace" }}>
                              {fieldsLocked ? (
                                <strong style={{ color: "#0f172a" }}>{line.qty_per}</strong>
                              ) : (
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={line.qty_per ?? ""}
                                  onChange={(e) => updateLine(index, { qty_per: e.target.value })}
                                  style={{ width: 80, padding: "3px 6px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 12, textAlign: "right", fontFamily: "monospace" }}
                                />
                              )}
                            </td>
                            <td style={{ padding: "6px 8px" }}>
                              {fieldsLocked ? (
                                <span style={{ color: "#64748b", fontSize: 11 }}>{line.remarks || "—"}</span>
                              ) : (
                                <input
                                  value={line.remarks || ""}
                                  onChange={(e) => updateLine(index, { remarks: e.target.value })}
                                  placeholder="Notes..."
                                  style={{ width: "100%", height: 26, padding: "0 6px", fontSize: 11, borderRadius: 4, border: "1px solid #cbd5e1" }}
                                />
                              )}
                            </td>
                            {!fieldsLocked && (
                              <td style={{ padding: "6px 8px", textAlign: "center" }}>
                                <button
                                  type="button"
                                  onClick={() => removeLine(index)}
                                  style={{
                                    all: "unset",
                                    cursor: "pointer",
                                    color: "#ef4444",
                                    fontWeight: 700,
                                    fontSize: 14,
                                    padding: "2px 6px",
                                  }}
                                >
                                  ×
                                </button>
                              </td>
                            )}
                          </tr>
                        ) : null
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Bottom Action Bar */}
              {!fieldsLocked && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12, paddingTop: 10, borderTop: "1px solid #f1f5f9" }}>
                  <button type="button" className="pd-btn-secondary" onClick={resetDraft} style={{ padding: "6px 14px", fontSize: 13 }}>
                    Reset
                  </button>
                  <button
                    type="button"
                    className="pd-btn-primary"
                    onClick={save}
                    disabled={saving || !editorReady || validLines.length === 0}
                    style={{ padding: "6px 18px", fontSize: 13 }}
                  >
                    {saving ? "Saving…" : draft.id ? "Update BOM" : "Save Master BOM"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* AVL Spec Manager Modal */}
      {avlSpecId ? (
        <AvlManagerModal
          specificationId={avlSpecId}
          onClose={() => setAvlSpecId(null)}
          onChanged={() => {
            apiFetch("/inventory/specs")
              .then((data) => setSpecOptions(Array.isArray(data?.specifications) ? data.specifications : []))
              .catch(() => {});
          }}
        />
      ) : null}
    </div>
  );
}
