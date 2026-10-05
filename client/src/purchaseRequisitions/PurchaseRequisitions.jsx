import { useEffect, useMemo, useState } from "react";
import ApprovalHistoryDrawer from "../shared/ApprovalHistoryDrawer";
import { DeskCard, DeskChip, FieldLabel, MiniMetric, NoticeBanner, PageHero, getDeskStatusAppearance } from "../shared/joshUi";

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

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `INR ${n.toFixed(2)}`;
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

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function calcTotals(lines) {
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const qtyRequested = Number(line.qty_requested || 0);
    const unit = Number(line.estimated_unit_price || 0);
    const gst = Number(line.gst_pct || 0);
    if (!Number.isFinite(qtyRequested) || !Number.isFinite(unit) || !Number.isFinite(gst)) continue;
    const lineSubtotal = qtyRequested * unit;
    subtotal += lineSubtotal;
    taxTotal += lineSubtotal * (gst / 100);
  }
  subtotal = money(subtotal);
  taxTotal = money(taxTotal);
  return {
    subtotal,
    taxTotal,
    grandTotal: money(subtotal + taxTotal),
  };
}

function emptyLine() {
  return {
    product_id: null,
    item_code: "",
    item_name: "",
    line_description: "",
    hsn_no: "",
    uom: "",
    qty_requested: 1,
    estimated_unit_price: 0,
    gst_pct: 0,
    qty_ordered: 0,
    qty_pending: 1,
  };
}

function withDerivedLine(line) {
  const qtyRequested = Number(line?.qty_requested || 0);
  const qtyOrdered = Number(line?.qty_ordered || 0);
  return {
    ...line,
    qty_pending: Math.max(qtyRequested - qtyOrdered, 0),
  };
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function lineIdentityLabel(line) {
  return line.item_code || line.item_name || "Manual line";
}

function validateLineForSubmission(line, index) {
  const issues = [];
  if (!String(line.item_code || "").trim() && !String(line.item_name || "").trim()) {
    issues.push(`Line ${index + 1} needs an item code or item name.`);
  }
  if (!String(line.uom || "").trim()) {
    issues.push(`Line ${index + 1} needs a UOM.`);
  }
  if (Number(line.qty_requested || 0) <= 0) {
    issues.push(`Line ${index + 1} needs qty greater than 0.`);
  }
  return issues;
}

const fieldInputStyle = {
  height: 36,
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid #d8e0ec",
  background: "#ffffff",
};

const textAreaStyle = {
  width: "100%",
  padding: 10,
  borderRadius: 10,
  border: "1px solid #d8e0ec",
  background: "#ffffff",
  resize: "vertical",
};

function workflowButtonStyle(tone, active = true) {
  return {
    borderRadius: 12,
    border: `1px solid ${active ? tone.border : "#d8e0ec"}`,
    background: active ? tone.background : "#f8fafc",
    color: active ? tone.color : "#64748b",
    padding: "10px 12px",
    fontWeight: 700,
    cursor: active ? "pointer" : "not-allowed",
    opacity: active ? 1 : 0.7,
  };
}

function quickAddQtyValue(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

export default function PurchaseRequisitions({ openPurchaseRequisitionId, onNavigate }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createRequiredByDate, setCreateRequiredByDate] = useState("");
  const [createDepartment, setCreateDepartment] = useState("");
  const [createPurpose, setCreatePurpose] = useState("");

  async function loadBootstrap() {
    setBootstrapLoading(true);
    try {
      const data = await apiFetch("/purchase-requisitions/bootstrap");
      setDepartments(Array.isArray(data?.departments) ? data.departments : []);
    } catch (error) {
      setError(getApiErrorMessage(error, "Failed to load purchase requisition setup."));
    } finally {
      setBootstrapLoading(false);
    }
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/purchase-requisitions");
      setItems(Array.isArray(data?.purchase_requisitions) ? data.purchase_requisitions : []);
    } catch (error) {
      setError(getApiErrorMessage(error, "Failed to load purchase requisitions."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") loadList();
  }, [view.type]);

  useEffect(() => {
    loadBootstrap();
  }, []);

  useEffect(() => {
    const id = Number(openPurchaseRequisitionId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openPurchaseRequisitionId]);

  async function createRequisition() {
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/purchase-requisitions", {
        method: "POST",
        body: JSON.stringify({
          required_by_date: createRequiredByDate || null,
          department: createDepartment || null,
          purpose: createPurpose || null,
        }),
      });
      const requisitionId = data?.purchase_requisition?.id;
      if (requisitionId) {
        setView({ type: "detail", id: requisitionId });
      }
      setNotice("Purchase requisition created.");
      setCreateRequiredByDate("");
      setCreateDepartment("");
      setCreatePurpose("");
    } catch (error) {
      setError(getApiErrorMessage(error, "Failed to create purchase requisition."));
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return <PurchaseRequisitionDetail id={view.id} onBack={() => setView({ type: "list" })} onNavigate={onNavigate} departments={departments} />;
  }

  const draftCount = items.filter((row) => String(row.requisition_status || "").toLowerCase() === "draft").length;
  const submittedCount = items.filter((row) => String(row.requisition_status || "").toLowerCase() === "submitted").length;
  const approvedCount = items.filter((row) => String(row.requisition_status || "").toLowerCase() === "approved").length;

  return (
    <div style={{ maxWidth: 1240, display: "grid", gap: 16 }}>
      <PageHero
        eyebrow="Purchase Desk"
        title="Purchase requisitions reset around draft quality, clear submission, and faster PO handoff."
        description="Capture the basics before number creation, build clean lines, submit with confidence, and move approved demand directly into the PO desk."
        actions={
          <>
            <button onClick={loadList} disabled={loading}>
              Refresh
            </button>
          </>
        }
        stats={[
          { label: "All requisitions", value: items.length, tone: "#234a8f" },
          { label: "Draft", value: draftCount, tone: "#b45309" },
          { label: "Submitted", value: submittedCount, tone: "#7c3aed" },
          { label: "Approved", value: approvedCount, tone: "#0b7d45" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <DeskCard
        title="Raise Requisition"
        subtitle="Capture the minimum business context first so the draft starts cleaner and less number clutter accumulates."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
          <FieldLabel label="Department">
            <select value={createDepartment} onChange={(e) => setCreateDepartment(e.target.value)} style={fieldInputStyle} disabled={bootstrapLoading}>
              <option value="">Select department</option>
              {departments.map((department) => (
                <option key={department.department_key || department.department_name} value={department.department_name}>
                  {department.department_name}
                </option>
              ))}
            </select>
          </FieldLabel>
          <FieldLabel label="Required By">
            <input type="date" value={createRequiredByDate} onChange={(e) => setCreateRequiredByDate(e.target.value)} style={fieldInputStyle} />
          </FieldLabel>
          <FieldLabel label="Purpose">
            <input value={createPurpose} onChange={(e) => setCreatePurpose(e.target.value)} style={fieldInputStyle} placeholder="Why is this being raised?" />
          </FieldLabel>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginTop: 12 }}>
          <div style={{ flex: 1, fontSize: 13, opacity: 0.78, minWidth: 280 }}>
            Best sequence: capture request context, create draft, clean up lines, save once, submit for approval, then convert approved pending quantity into a PO.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <DeskChip label="Cleaner draft start" tone="#eef4ff" color="#234a8f" />
            <button onClick={createRequisition} disabled={creating}>
              {creating ? "Creating..." : "Create Draft"}
            </button>
          </div>
        </div>
      </DeskCard>

      <DeskCard title="Requisition Queue" subtitle="A cleaner queue to spot what still needs drafting, approval follow-up, or PO conversion.">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "190px 1.3fr 130px 130px 160px",
            gap: 8,
            paddingBottom: 10,
            fontSize: 12,
            opacity: 0.74,
            borderBottom: "1px solid #e5ebf2",
          }}
        >
          <div>Requisition</div>
          <div>Department / Purpose</div>
          <div>Date</div>
          <div>Status</div>
          <div>Estimated Total</div>
        </div>

        {loading ? (
          <div style={{ paddingTop: 14 }}>Loading…</div>
        ) : items.length ? (
          <div style={{ display: "grid" }}>
            {items.map((row) => {
              const tone = getDeskStatusAppearance(row.requisition_status, {
                warning: ["draft"],
                info: ["submitted"],
                success: ["approved", "closed"],
                danger: ["cancelled", "rejected"],
              });
              return (
                <button
                  key={row.id}
                  onClick={() => setView({ type: "detail", id: row.id })}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "grid",
                    gridTemplateColumns: "190px 1.3fr 130px 130px 160px",
                    gap: 8,
                    padding: "14px 0",
                    borderBottom: "1px solid #eef2f7",
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontWeight: 700 }}>
                    {row.requisition_number}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700 }}>{row.department || "Unassigned department"}</div>
                    <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>{row.purpose || "No purpose captured yet."}</div>
                  </div>
                  <div>{fmtDate(row.requisition_date)}</div>
                  <div>
                    <DeskChip label={String(row.requisition_status || "—").replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontWeight: 700 }}>{fmtMoney(row.estimated_total)}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ paddingTop: 14, opacity: 0.72 }}>No requisitions yet.</div>
        )}
      </DeskCard>
    </div>
  );
}

function PurchaseRequisitionDetail({ id, onBack, onNavigate, departments }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [approvalRemarks, setApprovalRemarks] = useState("");
  const [requisition, setRequisition] = useState(null);
  const [approvalPreview, setApprovalPreview] = useState(null);
  const [requisitionDate, setRequisitionDate] = useState("");
  const [requiredByDate, setRequiredByDate] = useState("");
  const [department, setDepartment] = useState("");
  const [purpose, setPurpose] = useState("");
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [quickAddQtyById, setQuickAddQtyById] = useState({});
  const [manualDrawerOpen, setManualDrawerOpen] = useState(false);
  const [manualEditIndex, setManualEditIndex] = useState(null);
  const [manualDraft, setManualDraft] = useState(emptyLine());

  const totals = useMemo(() => calcTotals(lines), [lines]);
  const addedLinesLabel =
    lines.length === 1 ? "1 line added" : `${lines.length} lines added`;
  const currentStatus = String(requisition?.requisition_status || "draft").toLowerCase();
  const canEditLines = currentStatus === "draft";

  function applyDetail(detail) {
    const header = detail?.purchase_requisition || null;
    setRequisition(header);
    setApprovalPreview(detail?.approval_preview || null);
    setLines(Array.isArray(detail?.lines) ? detail.lines.map((line) => withDerivedLine({ ...line })) : []);
    setRequisitionDate(toIsoDate(header?.requisition_date));
    setRequiredByDate(toIsoDate(header?.required_by_date));
    setDepartment(header?.department || "");
    setPurpose(header?.purpose || "");
    setRemarks(header?.remarks || "");
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setNotice("");
    apiFetch(`/purchase-requisitions/${id}`)
      .then((detail) => {
        if (!active) return;
        applyDetail(detail);
      })
      .catch((error) => {
        if (!active) return;
        setError(getApiErrorMessage(error, "Failed to load purchase requisition."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!canEditLines) return undefined;
    const query = searchTerm.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }

    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      apiFetch(`/purchase-requisitions/product-lookup?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (!active) return;
          setSearchResults(Array.isArray(data?.products) ? data.products : []);
        })
        .catch((error) => {
          if (!active) return;
          setError(getApiErrorMessage(error, "Product lookup failed."));
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 280);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [searchTerm, canEditLines]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const detail = await apiFetch(`/purchase-requisitions/${id}`);
      applyDetail(detail);
    } catch (error) {
      setError(getApiErrorMessage(error, "Failed to refresh purchase requisition."));
    } finally {
      setLoading(false);
    }
  }

  const orderedQty = money(lines.reduce((sum, line) => sum + Number(line.qty_ordered || 0), 0));
  const pendingQtyValue = money(lines.reduce((sum, line) => sum + Number(line.qty_pending ?? line.qty_requested ?? 0), 0));
  const pendingQty = pendingQtyValue.toFixed(2);
  const orderedQtyText = orderedQty.toFixed(2);
  const headerTone = getDeskStatusAppearance(currentStatus, {
    warning: ["draft"],
    info: ["submitted"],
    success: ["approved", "closed"],
    danger: ["cancelled", "rejected"],
  });

  async function save(targetStatus = null) {
    const nextStatus = String(targetStatus || currentStatus || "draft").toLowerCase();
    const lineIssues = nextStatus === "submitted" ? lines.flatMap((line, index) => validateLineForSubmission(line, index)) : [];

    if (nextStatus === "submitted") {
      if (!String(department || "").trim()) {
        setError("Department is required before submission.");
        return;
      }
      if (!String(purpose || "").trim()) {
        setError("Purpose is required before submission.");
        return;
      }
      if (!lines.length) {
        setError("Add at least one requisition line before submission.");
        return;
      }
      if (lineIssues.length) {
        setError(lineIssues[0]);
        return;
      }
    }

    if (targetStatus === "draft" && currentStatus === "submitted" && !String(approvalRemarks || "").trim()) {
      setError("Remarks are required when sending a submitted requisition back to draft.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = {
        requisition_status: nextStatus,
        requisition_date: requisitionDate || undefined,
        required_by_date: requiredByDate || null,
        department: department || null,
        purpose: purpose || null,
        remarks: remarks || null,
        approval_remarks: approvalRemarks || null,
      };

      if (canEditLines) {
        payload.lines = lines.map((line) => ({
          product_id: line.product_id || null,
          item_code: line.item_code || null,
          item_name: line.item_name || null,
          line_description: line.line_description || null,
          hsn_no: line.hsn_no || null,
          uom: line.uom || null,
          qty_requested: Number(line.qty_requested || 0),
          estimated_unit_price: Number(line.estimated_unit_price || 0),
          gst_pct: Number(line.gst_pct || 0),
        }));
      }

      const data = await apiFetch(`/purchase-requisitions/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      applyDetail(data);
      setApprovalRemarks("");
      setNotice(
        nextStatus === currentStatus
          ? "Purchase requisition saved."
          : nextStatus === "submitted"
            ? "Purchase requisition submitted for approval."
            : nextStatus === "draft"
              ? "Purchase requisition sent back to draft."
              : nextStatus === "approved"
                ? "Purchase requisition approved."
                : nextStatus === "closed"
                  ? "Purchase requisition closed."
                  : "Purchase requisition updated."
      );
    } catch (error) {
      if (error?.data?.error === "REQUISITION_NOT_EDITABLE") setError("Only draft requisitions can be edited.");
      else if (error?.data?.error === "REQUISITION_LINES_ALREADY_ORDERED") setError("Some requisition lines are already linked to purchase orders, so lines can no longer be edited.");
      else if (error?.data?.error === "INVALID_QTY") setError("Qty requested must be greater than 0.");
      else if (error?.data?.error === "INVALID_PRICE") setError("Check estimated price and GST %.");
      else if (error?.data?.error === "NEEDS_SUBMISSION") setError("Submit this requisition before trying to approve it.");
      else if (error?.data?.error === "INVALID_TRANSITION") setError("That workflow transition is not allowed from the current requisition state.");
      else setError(getApiErrorMessage(error, "Failed to save purchase requisition."));
    } finally {
      setSaving(false);
    }
  }

  function updateLine(index, patch) {
    setLines((prev) => prev.map((line, lineIndex) => (lineIndex === index ? withDerivedLine({ ...line, ...patch }) : line)));
  }

  function removeLine(index) {
    setLines((prev) => prev.filter((_, lineIndex) => lineIndex !== index));
  }

  function openManualDrawer(index = null) {
    if (typeof index === "number" && lines[index]) {
      setManualDraft({ ...lines[index] });
      setManualEditIndex(index);
    } else {
      setManualDraft(emptyLine());
      setManualEditIndex(null);
    }
    setManualDrawerOpen(true);
  }

  function closeManualDrawer() {
    setManualDrawerOpen(false);
    setManualEditIndex(null);
    setManualDraft(emptyLine());
  }

  function saveManualLine() {
    const issues = validateLineForSubmission(manualDraft, manualEditIndex ?? lines.length);
    if (issues.length) {
      setError(issues[0]);
      return;
    }
    if (manualEditIndex === null) {
      setLines((prev) => [...prev, withDerivedLine({ ...manualDraft })]);
      setNotice("Manual line added.");
    } else {
      setLines((prev) => prev.map((line, index) => (index === manualEditIndex ? withDerivedLine({ ...manualDraft }) : line)));
      setNotice("Manual line updated.");
    }
    setError("");
    closeManualDrawer();
  }

  async function searchProducts(queryOverride = null) {
    const query = String(queryOverride ?? searchTerm).trim();
    if (!query) return;
    setSearching(true);
    setError("");
    try {
      const data = await apiFetch(`/purchase-requisitions/product-lookup?q=${encodeURIComponent(query)}`);
      setSearchResults(Array.isArray(data?.products) ? data.products : []);
    } catch (error) {
      setError(getApiErrorMessage(error, "Product lookup failed."));
    } finally {
      setSearching(false);
    }
  }

  function addProduct(product, requestedQty = 1) {
    const unit = Number(product?.last_purchase_price ?? product?.list_price ?? 0);
    const qtyToAdd = quickAddQtyValue(requestedQty);
    setLines((prev) => {
      const existingIndex = prev.findIndex((line) => Number(line.product_id || 0) === Number(product.id || 0));
      if (existingIndex >= 0) {
        return prev.map((line, index) => {
          if (index !== existingIndex) return line;
          return withDerivedLine({
            ...line,
            qty_requested: Number(line.qty_requested || 0) + qtyToAdd,
          });
        });
      }
      return [
        ...prev,
        withDerivedLine({
          ...emptyLine(),
          product_id: product.id,
          item_code: product.item_code || "",
          item_name: product.item_name || "",
          line_description: product.item_name || "",
          uom: product.uom || "",
          hsn_no: product.hsn_no || "",
          gst_pct: Number(product.gst_pct || 0),
          estimated_unit_price: Number.isFinite(unit) ? unit : 0,
          qty_requested: qtyToAdd,
        }),
      ];
    });
    setQuickAddQtyById((prev) => ({ ...prev, [product.id]: "1" }));
    setNotice(`${product.item_name || product.item_code || "Item"} added to requisition.`);
  }

  function openPurchaseOrderDesk() {
    if (typeof onNavigate !== "function") return;
    onNavigate("purchase_orders", {
      resetQuote: true,
      purchaseOrdersLaunch: {
        create_mode: "from_requisition",
        requisition_id: id,
        procurement_bucket: "pr_not_ordered",
      },
    });
  }

  function openVendorQuotesDesk(mode = "rfq") {
    if (typeof onNavigate !== "function") return;
    onNavigate("vendor_quotes", {
      resetQuote: true,
      vendorQuotesLaunch: {
        requisition_id: id,
        mode,
      },
    });
  }

  if (loading) return <div>Loading purchase requisition…</div>;
  if (!requisition) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Purchase requisition not found."}</div>
      </div>
    );
  }

  const canSubmit = canEditLines;
  const canApprove = currentStatus === "submitted" && Boolean(approvalPreview?.can_current_user_approve);
  const canSendBack = currentStatus === "submitted" && Boolean(approvalPreview?.can_current_user_approve);
  const canClose = currentStatus === "approved" && Boolean(approvalPreview?.can_manage_post_approval);
  const canCreatePo = ["approved", "closed"].includes(currentStatus) && pendingQtyValue > 0;

  return (
    <div style={{ maxWidth: 1320, display: "grid", gap: 16 }}>
      <PageHero
        eyebrow="Purchase Requisition"
        title={requisition.requisition_number}
        description="Clean the request, complete the lines, submit through explicit workflow actions, and move approved demand straight into the PO desk."
        actions={
          <>
            <button onClick={onBack}>Back</button>
            <button onClick={() => setHistoryOpen(true)}>History / Remarks</button>
            <button onClick={refresh} disabled={loading || saving}>
              Refresh
            </button>
            {canEditLines ? (
              <button onClick={() => save()} disabled={saving}>
                {saving ? "Saving..." : "Save Draft"}
              </button>
            ) : null}
            {canCreatePo ? (
              <>
                <button onClick={() => openVendorQuotesDesk("rfq")} disabled={saving}>
                  Vendor Quotes / RFQ
                </button>
                <button onClick={openPurchaseOrderDesk} disabled={saving}>
                  Create PO From This PR
                </button>
              </>
            ) : null}
          </>
        }
        stats={[
          { label: "Status", value: String(currentStatus || "draft").replace(/_/g, " "), tone: headerTone.color },
          { label: "Lines", value: lines.length, tone: "#234a8f" },
          { label: "Pending Qty", value: pendingQty, tone: "#b45309" },
          { label: "Estimated Total", value: fmtMoney(totals.grandTotal), tone: "#0b7d45" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.05fr) minmax(320px, 0.95fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Requisition Snapshot" subtitle="Keep the header complete before moving the document forward.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <FieldLabel label="Requisition Date">
              <input type="date" value={requisitionDate} onChange={(e) => setRequisitionDate(e.target.value)} disabled={!canEditLines} style={fieldInputStyle} />
            </FieldLabel>
            <FieldLabel label="Required By">
              <input type="date" value={requiredByDate} onChange={(e) => setRequiredByDate(e.target.value)} disabled={!canEditLines} style={fieldInputStyle} />
            </FieldLabel>
            <FieldLabel label="Department">
              <select value={department} onChange={(e) => setDepartment(e.target.value)} disabled={!canEditLines} style={fieldInputStyle}>
                <option value="">Select department</option>
                {departments.map((item) => (
                  <option key={item.department_key || item.department_name} value={item.department_name}>
                    {item.department_name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="Workflow Stage">
              <div style={{ ...fieldInputStyle, display: "flex", alignItems: "center" }}>
                <DeskChip label={String(currentStatus || "draft").replace(/_/g, " ")} tone={headerTone.tone} color={headerTone.color} />
              </div>
            </FieldLabel>
          </div>
          <FieldLabel label="Purpose" style={{ marginTop: 12 }}>
            <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} disabled={!canEditLines} rows={2} style={textAreaStyle} />
          </FieldLabel>
          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={!canEditLines} rows={3} style={textAreaStyle} />
          </FieldLabel>
        </DeskCard>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Workflow Actions" subtitle="Draft, submit, approve, and send-back now read like explicit business actions instead of a generic status edit.">
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => save()} disabled={!canEditLines || saving} style={workflowButtonStyle({ border: "#cbd5e1", background: "#ffffff", color: "#334155" }, canEditLines && !saving)}>
                  Save Draft
                </button>
                <button type="button" onClick={() => save("submitted")} disabled={!canSubmit || saving} style={workflowButtonStyle({ border: "#c4b5fd", background: "#f5f3ff", color: "#6d28d9" }, canSubmit && !saving)}>
                  Submit For Approval
                </button>
                <button type="button" onClick={() => save("approved")} disabled={!canApprove || saving} style={workflowButtonStyle({ border: "#bbf7d0", background: "#f0fdf4", color: "#15803d" }, canApprove && !saving)}>
                  Approve
                </button>
                <button type="button" onClick={() => save("draft")} disabled={!canSendBack || saving} style={workflowButtonStyle({ border: "#fed7aa", background: "#fff7ed", color: "#b45309" }, canSendBack && !saving)}>
                  Send Back To Draft
                </button>
                <button type="button" onClick={() => save("closed")} disabled={!canClose || saving} style={workflowButtonStyle({ border: "#cbd5f5", background: "#eef2ff", color: "#4338ca" }, canClose && !saving)}>
                  Mark Closed
                </button>
              </div>
              <FieldLabel label="Approval / Send-Back Remarks">
                <textarea
                  value={approvalRemarks}
                  onChange={(e) => setApprovalRemarks(e.target.value)}
                  rows={3}
                  style={textAreaStyle}
                  placeholder={canSendBack ? "Required if you send this back to draft." : "Optional remarks recorded with submit, approve, or close actions."}
                />
              </FieldLabel>
            </div>
          </DeskCard>

          <DeskCard title="Approval State" subtitle="Make the approval path visible to both the requester and the approver.">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              <MiniMetric label="Current Level" value={`${Number(approvalPreview?.current_level || 0)}`} />
              <MiniMetric label="Required Level" value={`${Number(approvalPreview?.required_level || 0)}`} />
              <MiniMetric label="Next Level" value={approvalPreview?.next_level ? `L${approvalPreview.next_level}` : "—"} />
              <MiniMetric label="Next Approver" value={approvalPreview?.next_approver || "—"} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <DeskChip label={canEditLines ? "Draft editing open" : "Header is now read-only"} tone={canEditLines ? "#eef4ff" : "#f5f6fa"} color={canEditLines ? "#234a8f" : "#5d6782"} />
              {canCreatePo ? <DeskChip label="Ready for PO conversion" tone="#effcf3" color="#0b7d45" /> : null}
              {currentStatus === "submitted" && !canApprove ? <DeskChip label="Waiting on approver" tone="#f5f3ff" color="#6d28d9" /> : null}
            </div>
          </DeskCard>

          <DeskCard title="Totals & Conversion" subtitle="Use pending quantity as the conversion signal instead of desk-hopping manually.">
            <div style={{ display: "grid", gap: 10 }}>
              <MiniMetric label="Estimated Subtotal" value={fmtMoney(totals.subtotal)} />
              <MiniMetric label="Estimated GST" value={fmtMoney(totals.taxTotal)} />
              <MiniMetric label="Estimated Total" value={fmtMoney(totals.grandTotal)} />
              <MiniMetric label="Pending Qty" value={pendingQty} />
              <MiniMetric label="Ordered Qty" value={orderedQtyText} />
            </div>
            <div style={{ fontSize: 12, opacity: 0.74, marginTop: 12, lineHeight: 1.7 }}>
              Approved pending quantity should move directly into the purchase order desk from here rather than forcing the user to remember the next desk manually.
            </div>
            {canCreatePo ? (
              <button type="button" onClick={openPurchaseOrderDesk} style={{ marginTop: 12 }}>
                Open PO Desk With This Requisition
              </button>
            ) : null}
          </DeskCard>
        </div>
      </div>

      <DeskCard title="Add Items" subtitle="Live-search the catalog on the left and keep the added PR lines visible on the right so item entry does not turn into a scroll chase.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 16, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Type item code or name"
                style={{ ...fieldInputStyle, flex: 1, minWidth: 260 }}
                disabled={!canEditLines}
                onKeyDown={(e) => {
                  if (e.key === "Enter") searchProducts(e.currentTarget.value);
                }}
              />
              <button type="button" onClick={() => openManualDrawer()} disabled={!canEditLines}>
                Add Manual Line
              </button>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <DeskChip label="Live search after 2 chars" tone="#eef4ff" color="#234a8f" />
              <DeskChip label="Catalog picks merge by item" tone="#eef4ff" color="#234a8f" />
              <DeskChip label="Manual lines use drawer" tone="#fff6e8" color="#8b5a00" />
            </div>

            <div style={{ fontSize: 12, opacity: 0.72 }}>
              {searchTerm.trim().length < 2
                ? "Start typing at least 2 characters to search the catalog."
                : searching
                  ? "Searching catalog..."
                  : searchResults.length
                    ? `${searchResults.length} catalog matches ready to add.`
                    : "No catalog items match the current search."}
            </div>

            <div
              style={{
                display: "grid",
                gap: 8,
                maxHeight: 560,
                overflowY: "auto",
                paddingRight: 4,
                border: "1px solid #e5ebf2",
                borderRadius: 16,
                background: "#fafcff",
                padding: 10,
              }}
            >
              {searchResults.length ? (
                searchResults.map((product) => {
                  const quickQty = quickAddQtyById[product.id] || "1";
                  return (
                    <div
                      key={product.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1.5fr) 84px 116px",
                        gap: 8,
                        alignItems: "center",
                        border: "1px solid #e7ebf3",
                        borderRadius: 12,
                        padding: 10,
                        background: "#ffffff",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{product.item_code}</div>
                        <div style={{ fontSize: 13, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{product.item_name}</div>
                        <div style={{ fontSize: 12, opacity: 0.72, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          UOM {product.uom || "—"} • GST {Number(product.gst_pct || 0)}% • {fmtMoney(product.last_purchase_price ?? product.list_price ?? 0)}
                        </div>
                      </div>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={quickQty}
                        disabled={!canEditLines}
                        onChange={(e) => setQuickAddQtyById((prev) => ({ ...prev, [product.id]: e.target.value }))}
                        style={fieldInputStyle}
                      />
                      <button type="button" onClick={() => addProduct(product, quickQty)} disabled={!canEditLines}>
                        Add
                      </button>
                    </div>
                  );
                })
              ) : (
                <div style={{ padding: 12, opacity: 0.72, fontSize: 12 }}>
                  {searchTerm.trim().length < 2
                    ? "Type a product name or item code and the list will update automatically."
                    : "No results to show for this search yet."}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            <div
              style={{
                display: "grid",
                gap: 10,
                padding: 12,
                border: "1px solid #dfe7f3",
                borderRadius: 16,
                background: "#f8fbff",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>Added To PR</div>
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>Keep the staging table visible while you continue searching.</div>
                </div>
                <DeskChip label={addedLinesLabel} tone="#effcf3" color="#0b7d45" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                <MiniMetric label="Lines" value={lines.length} />
                <MiniMetric label="Pending Qty" value={pendingQty} />
                <MiniMetric label="Estimated Total" value={fmtMoney(totals.grandTotal)} />
              </div>
            </div>

            {lines.length ? (
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  maxHeight: 620,
                  overflowY: "auto",
                  paddingRight: 4,
                }}
              >
                {lines.map((line, index) => {
                  const lineAmount = money(Number(line.qty_requested || 0) * Number(line.estimated_unit_price || 0));
                  const lineIssues = currentStatus === "draft" ? validateLineForSubmission(line, index) : [];
                  return (
                    <div
                      key={`${line.id || "new"}-${index}`}
                      style={{
                        border: "1px solid #e7ebf3",
                        borderRadius: 14,
                        padding: 12,
                        background: "#ffffff",
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <strong>{lineIdentityLabel(line)}</strong>
                            <DeskChip label={line.product_id ? "Catalog" : "Manual"} tone={line.product_id ? "#eef4ff" : "#fff6e8"} color={line.product_id ? "#234a8f" : "#8b5a00"} />
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
                            {line.line_description || "No description"} • HSN {line.hsn_no || "—"} • Ordered {money(line.qty_ordered || 0).toFixed(2)} • Pending {money(line.qty_pending ?? line.qty_requested ?? 0).toFixed(2)}
                          </div>
                          {lineIssues.length ? <div style={{ fontSize: 12, color: "#b45309", marginTop: 4 }}>{lineIssues[0]}</div> : null}
                        </div>
                        <div style={{ fontWeight: 800 }}>{fmtMoney(lineAmount)}</div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(98px, 1fr))", gap: 8 }}>
                        <FieldLabel label="Qty">
                          <input
                            type="number"
                            value={line.qty_requested ?? ""}
                            disabled={!canEditLines}
                            min="0"
                            step="0.01"
                            onChange={(e) => updateLine(index, { qty_requested: e.target.value })}
                            style={fieldInputStyle}
                          />
                        </FieldLabel>
                        <FieldLabel label="UOM">
                          <input
                            value={line.uom || ""}
                            disabled={!canEditLines}
                            onChange={(e) => updateLine(index, { uom: e.target.value })}
                            style={fieldInputStyle}
                          />
                        </FieldLabel>
                        <FieldLabel label="GST %">
                          <input
                            type="number"
                            value={line.gst_pct ?? ""}
                            disabled={!canEditLines}
                            min="0"
                            max="100"
                            step="0.01"
                            onChange={(e) => updateLine(index, { gst_pct: e.target.value })}
                            style={fieldInputStyle}
                          />
                        </FieldLabel>
                        <FieldLabel label="Unit Price">
                          <input
                            type="number"
                            value={line.estimated_unit_price ?? ""}
                            disabled={!canEditLines}
                            min="0"
                            step="0.01"
                            onChange={(e) => updateLine(index, { estimated_unit_price: e.target.value })}
                            style={fieldInputStyle}
                          />
                        </FieldLabel>
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {!line.product_id && canEditLines ? (
                          <button type="button" onClick={() => openManualDrawer(index)}>
                            Edit Details
                          </button>
                        ) : null}
                        {canEditLines ? (
                          <button type="button" onClick={() => removeLine(index)}>
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 12, opacity: 0.72, border: "1px dashed #d9e2ef", borderRadius: 14, background: "#fafcff" }}>
                No lines yet. Start typing on the left and the added items will stay visible here.
              </div>
            )}
          </div>
        </div>
      </DeskCard>

      <ApprovalHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docType="purchase_requisition"
        docId={id}
        remarks={approvalRemarks}
        onRemarksChange={setApprovalRemarks}
      />

      {manualDrawerOpen ? (
        <>
          <div
            onClick={closeManualDrawer}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeManualDrawer();
            }}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15, 23, 42, 0.28)",
              zIndex: 70,
            }}
          />
          <aside
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              height: "100vh",
              width: 520,
              maxWidth: "92vw",
              background: "#f8faff",
              borderLeft: "1px solid #dfe6f2",
              zIndex: 71,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ padding: 16, borderBottom: "1px solid #e2e8f3", display: "flex", gap: 12, alignItems: "center", background: "#ffffff" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>Manual Line</div>
                <div style={{ fontWeight: 800, marginTop: 4, fontSize: 18 }}>
                  {manualEditIndex === null ? "Add manual requisition line" : `Edit line ${manualEditIndex + 1}`}
                </div>
              </div>
              <button type="button" onClick={closeManualDrawer}>
                Close
              </button>
            </div>

            <div style={{ padding: 16, overflow: "auto", display: "grid", gap: 12 }}>
              <FieldLabel label="Item Code">
                <input value={manualDraft.item_code || ""} onChange={(e) => setManualDraft((prev) => ({ ...prev, item_code: e.target.value }))} style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="Item Name">
                <input value={manualDraft.item_name || ""} onChange={(e) => setManualDraft((prev) => ({ ...prev, item_name: e.target.value }))} style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="UOM">
                <input value={manualDraft.uom || ""} onChange={(e) => setManualDraft((prev) => ({ ...prev, uom: e.target.value }))} style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="HSN">
                <input value={manualDraft.hsn_no || ""} onChange={(e) => setManualDraft((prev) => ({ ...prev, hsn_no: e.target.value }))} style={fieldInputStyle} />
              </FieldLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
                <FieldLabel label="Qty">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={manualDraft.qty_requested ?? ""}
                    onChange={(e) => setManualDraft((prev) => ({ ...prev, qty_requested: e.target.value }))}
                    style={fieldInputStyle}
                  />
                </FieldLabel>
                <FieldLabel label="GST %">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={manualDraft.gst_pct ?? ""}
                    onChange={(e) => setManualDraft((prev) => ({ ...prev, gst_pct: e.target.value }))}
                    style={fieldInputStyle}
                  />
                </FieldLabel>
                <FieldLabel label="Unit Price">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={manualDraft.estimated_unit_price ?? ""}
                    onChange={(e) => setManualDraft((prev) => ({ ...prev, estimated_unit_price: e.target.value }))}
                    style={fieldInputStyle}
                  />
                </FieldLabel>
              </div>
              <FieldLabel label="Line Description">
                <textarea
                  value={manualDraft.line_description || ""}
                  onChange={(e) => setManualDraft((prev) => ({ ...prev, line_description: e.target.value }))}
                  rows={4}
                  style={textAreaStyle}
                />
              </FieldLabel>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <DeskChip
                  label={`Line total ${fmtMoney(money(Number(manualDraft.qty_requested || 0) * Number(manualDraft.estimated_unit_price || 0)))}`}
                  tone="#eefcf3"
                  color="#0b7d45"
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={closeManualDrawer}>
                    Cancel
                  </button>
                  <button type="button" onClick={saveManualLine}>
                    {manualEditIndex === null ? "Add Line" : "Update Line"}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
