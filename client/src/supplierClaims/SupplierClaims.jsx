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

function buildReceiptForm(lines, current = {}) {
  const pendingLines = Array.isArray(lines) ? lines.filter((line) => num(line.qty_pending) > 0) : [];
  const selectedExists = pendingLines.some((line) => String(line.id) === String(current.line_id || ""));
  return {
    line_id: selectedExists ? String(current.line_id || "") : pendingLines[0] ? String(pendingLines[0].id) : "",
    qty_received: current.qty_received || "",
    receipt_date: current.receipt_date || todayIsoDate(),
    reference_no: current.reference_no || "",
    remarks: current.remarks || "",
    serial_text: current.serial_text || "",
  };
}

export default function SupplierClaims({ openSupplierClaimId = null, onOpenQualityControl, onConsumeOpenSupplierClaim = null }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [items, setItems] = useState([]);
  const [bootstrap, setBootstrap] = useState({ claimable_quality_controls: [] });
  const [createQcId, setCreateQcId] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadBootstrap() {
    const data = await apiFetch("/supplier-claims/bootstrap");
    setBootstrap({
      claimable_quality_controls: Array.isArray(data?.claimable_quality_controls) ? data.claimable_quality_controls : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/supplier-claims");
      setItems(Array.isArray(data?.supplier_claims) ? data.supplier_claims : []);
    } catch (_e) {
      setError("Failed to load supplier claims.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (openSupplierClaimId) {
      setView({ type: "detail", id: openSupplierClaimId });
      onConsumeOpenSupplierClaim?.();
      return;
    }
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
    }
  }, [view.type, openSupplierClaimId, onConsumeOpenSupplierClaim]);

  async function createFromQc() {
    const qcId = Number(createQcId);
    if (!Number.isFinite(qcId) || qcId <= 0) {
      setError("Select a closed QC with pending supplier replacement first.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/supplier-claims/from-quality-control/${qcId}`, { method: "POST" });
      const id = data?.supplier_claim?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Supplier claim created from quality control.");
    } catch (e) {
      if (e?.data?.error === "QC_NOT_CLOSED") setError("Close the quality control before creating a supplier claim.");
      else if (e?.data?.error === "NO_PENDING_CLAIMABLE_REPLACEMENTS") setError("No supplier replacement actions are pending claim creation for this QC.");
      else setError("Failed to create supplier claim.");
    } finally {
      setCreating(false);
    }
  }

  if (view.type === "detail") {
    return (
      <SupplierClaimDetail
        id={view.id}
        onBack={() => setView({ type: "list" })}
        onOpenQualityControl={onOpenQualityControl}
      />
    );
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>Supplier Claims / Replacement Receipt</h2>
        <button onClick={loadList} disabled={loading}>
          Refresh
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Create Claim From Closed QC</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            Quality Control
            <select value={createQcId} onChange={(e) => setCreateQcId(e.target.value)} style={{ height: 36 }}>
              <option value="">Select QC with pending replacement</option>
              {bootstrap.claimable_quality_controls.map((row) => (
                <option key={row.id} value={String(row.id)}>
                  {row.qc_number} • {row.grn_number} • {row.vendor_name} • Qty {num(row.qty_claimable).toFixed(4)}
                </option>
              ))}
            </select>
          </label>
          <button onClick={createFromQc} disabled={creating}>
            {creating ? "Creating..." : "Create Claim"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {loading ? (
          <div>Loading supplier claims…</div>
        ) : items.length ? (
          items.map((row) => (
            <button
              key={row.id}
              onClick={() => setView({ type: "detail", id: row.id })}
              style={{
                all: "unset",
                cursor: "pointer",
                border: "1px solid #e5e5e5",
                borderRadius: 10,
                padding: 14,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700 }}>{row.claim_number}</div>
                <div style={{ textTransform: "capitalize" }}>{row.claim_status}</div>
              </div>
              <div style={{ fontSize: 13, opacity: 0.78 }}>
                {row.vendor_name} • QC {row.qc_number} • GRN {row.grn_number}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: 10, fontSize: 13 }}>
                <Metric label="Claimed" value={num(row.total_claimed_qty).toFixed(4)} />
                <Metric label="Received" value={num(row.total_received_qty).toFixed(4)} />
                <Metric label="Pending" value={num(row.total_pending_qty).toFixed(4)} />
              </div>
            </button>
          ))
        ) : (
          <div style={{ opacity: 0.72 }}>No supplier claims yet.</div>
        )}
      </div>
    </div>
  );
}

function SupplierClaimDetail({ id, onBack, onOpenQualityControl }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recordingReceipt, setRecordingReceipt] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [header, setHeader] = useState(null);
  const [lines, setLines] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [claimStatus, setClaimStatus] = useState("open");
  const [claimDate, setClaimDate] = useState("");
  const [remarks, setRemarks] = useState("");
  const [receiptForm, setReceiptForm] = useState(() => buildReceiptForm([]));

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/supplier-claims/${id}`);
      const claim = data?.supplier_claim || null;
      const nextLines = Array.isArray(data?.lines) ? data.lines : [];
      setHeader(claim);
      setLines(nextLines);
      setReceipts(Array.isArray(data?.receipts) ? data.receipts : []);
      setClaimStatus(claim?.claim_status || "open");
      setClaimDate(toIsoDate(claim?.claim_date));
      setRemarks(claim?.remarks || "");
      setReceiptForm((prev) => buildReceiptForm(nextLines, prev));
    } catch (_e) {
      setError("Failed to load supplier claim.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, [id]);

  const pendingLines = useMemo(() => lines.filter((line) => num(line.qty_pending) > 0), [lines]);
  const selectedReceiptLine = useMemo(
    () => pendingLines.find((line) => String(line.id) === String(receiptForm.line_id || "")) || null,
    [pendingLines, receiptForm.line_id]
  );

  function setReceiptField(field, value) {
    setReceiptForm((prev) => ({ ...prev, [field]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/supplier-claims/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          claim_status: claimStatus,
          claim_date: claimDate || null,
          remarks: remarks || null,
        }),
      });
      const claim = data?.supplier_claim || header;
      const nextLines = Array.isArray(data?.lines) ? data.lines : lines;
      setHeader(claim);
      setLines(nextLines);
      setReceipts(Array.isArray(data?.receipts) ? data.receipts : receipts);
      setClaimStatus(claim?.claim_status || claimStatus);
      setClaimDate(toIsoDate(claim?.claim_date));
      setRemarks(claim?.remarks || "");
      setReceiptForm((prev) => buildReceiptForm(nextLines, prev));
      setNotice("Supplier claim saved.");
    } catch (e) {
      if (e?.data?.error === "CLAIM_PENDING_RECEIPT") setError("Pending replacement qty still exists, so the claim cannot be closed yet.");
      else setError("Failed to save supplier claim.");
    } finally {
      setSaving(false);
    }
  }

  async function recordReceipt() {
    if (!receiptForm.line_id) {
      setError("Select a pending claim line first.");
      return;
    }
    if (num(receiptForm.qty_received) <= 0) {
      setError("Enter a valid replacement receipt quantity.");
      return;
    }

    const serials = String(receiptForm.serial_text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

    setRecordingReceipt(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/supplier-claims/${id}/receipts`, {
        method: "POST",
        body: JSON.stringify({
          line_id: Number(receiptForm.line_id),
          qty_received: num(receiptForm.qty_received),
          receipt_date: receiptForm.receipt_date || null,
          reference_no: receiptForm.reference_no || null,
          remarks: receiptForm.remarks || null,
          serials,
        }),
      });
      const claim = data?.supplier_claim || header;
      const nextLines = Array.isArray(data?.lines) ? data.lines : lines;
      setHeader(claim);
      setLines(nextLines);
      setReceipts(Array.isArray(data?.receipts) ? data.receipts : receipts);
      setClaimStatus(claim?.claim_status || claimStatus);
      setReceiptForm(buildReceiptForm(nextLines));
      setNotice(data?.receipt_number ? `Replacement receipt ${data.receipt_number} recorded.` : "Replacement receipt recorded.");
    } catch (e) {
      if (e?.data?.error === "RECEIPT_EXCEEDS_PENDING") setError("Replacement receipt qty cannot exceed pending claim qty.");
      else if (e?.data?.error === "SERIAL_COUNT_MISMATCH") setError("Serial-controlled lines require one serial number for each received unit.");
      else if (e?.data?.error === "SERIAL_QTY_NOT_INTEGER") setError("Serial-controlled lines require an integer receipt qty.");
      else if (e?.data?.error === "DUPLICATE_SERIALS") setError("Duplicate serial numbers are not allowed.");
      else if (e?.data?.error === "CLAIM_CLOSED") setError("This supplier claim is already closed.");
      else if (e?.data?.error === "CLAIM_CANCELLED") setError("Cancelled supplier claims cannot receive replacement receipts.");
      else setError("Failed to record replacement receipt.");
    } finally {
      setRecordingReceipt(false);
    }
  }

  if (loading) return <div>Loading supplier claim…</div>;
  if (!header) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Supplier claim not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1220 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack}>Back</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{header.claim_number}</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {header.vendor_name} • QC {header.qc_number} • GRN {header.grn_number}
          </div>
        </div>
        {onOpenQualityControl ? (
          <button onClick={() => onOpenQualityControl(header.quality_control_id)}>Open QC</button>
        ) : null}
        <button onClick={refresh} disabled={loading}>
          Refresh
        </button>
        <button onClick={save} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Claim Snapshot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Claim Date
              <input type="date" value={claimDate} onChange={(e) => setClaimDate(e.target.value)} style={{ height: 34 }} />
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
              Status
              <select value={claimStatus} onChange={(e) => setClaimStatus(e.target.value)} style={{ height: 36 }}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.9 }}>
            <div>Vendor: {header.vendor_name}</div>
            <div>Quality Control: {header.qc_number}</div>
            <div>GRN: {header.grn_number}</div>
            <div>Created By: {header.created_by_name || "—"}</div>
          </div>
          <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
            Remarks
            <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3} style={{ padding: 10 }} />
          </label>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Replacement Summary</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10 }}>
            <Metric label="Claimed" value={num(header.total_claimed_qty).toFixed(4)} />
            <Metric label="Received" value={num(header.total_received_qty).toFixed(4)} />
            <Metric label="Pending" value={num(header.total_pending_qty).toFixed(4)} />
          </div>
          <div style={{ marginTop: 12, fontSize: 13 }}>
            Replacement receipts recorded: {receipts.length}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Record Replacement Receipt</div>
          {pendingLines.length && header.claim_status !== "cancelled" ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Claim Line
                  <select value={receiptForm.line_id} onChange={(e) => setReceiptField("line_id", e.target.value)} style={{ height: 36 }}>
                    {pendingLines.map((line) => (
                      <option key={line.id} value={String(line.id)}>
                        L{line.line_no} • {line.item_code || line.item_name || "Item"} • Pending {num(line.qty_pending).toFixed(4)}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Qty Received
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={receiptForm.qty_received}
                    onChange={(e) => setReceiptField("qty_received", e.target.value)}
                    style={{ height: 34, padding: "0 8px" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Receipt Date
                  <input type="date" value={receiptForm.receipt_date} onChange={(e) => setReceiptField("receipt_date", e.target.value)} style={{ height: 34 }} />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
                  Reference No
                  <input value={receiptForm.reference_no} onChange={(e) => setReceiptField("reference_no", e.target.value)} style={{ height: 34, padding: "0 8px" }} />
                </label>
              </div>
              <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                Remarks
                <textarea value={receiptForm.remarks} onChange={(e) => setReceiptField("remarks", e.target.value)} rows={3} style={{ padding: 10 }} />
              </label>
              {selectedReceiptLine?.serial_no_required ? (
                <label style={{ display: "grid", gap: 6, fontSize: 12, marginTop: 12 }}>
                  Serial Numbers
                  <textarea
                    value={receiptForm.serial_text}
                    onChange={(e) => setReceiptField("serial_text", e.target.value)}
                    rows={4}
                    placeholder="One serial number per line"
                    style={{ padding: 10 }}
                  />
                </label>
              ) : null}
              <button onClick={recordReceipt} disabled={recordingReceipt} style={{ marginTop: 12 }}>
                {recordingReceipt ? "Recording..." : "Record Replacement Receipt"}
              </button>
            </>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>
              {header.claim_status === "cancelled"
                ? "Cancelled claims cannot receive replacement receipts."
                : "No pending replacement qty remains on this claim."}
            </div>
          )}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Replacement Receipt History</div>
          {receipts.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {receipts.map((receipt) => (
                <div key={receipt.id} style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
                    <strong>{receipt.receipt_number}</strong>
                    <span>Line {receipt.line_no}</span>
                    <span>Qty {num(receipt.qty_received).toFixed(4)}</span>
                    <span>{fmtDate(receipt.receipt_date)}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.82 }}>
                    {(receipt.item_code || receipt.item_name || "Item")}{receipt.reference_no ? ` • Ref ${receipt.reference_no}` : ""}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>
                    By {receipt.created_by_name || "Unknown"} • Logged {fmtDateTime(receipt.created_at)}
                  </div>
                  {receipt.serials?.length ? (
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.82 }}>
                      Serials: {receipt.serials.join(", ")}
                    </div>
                  ) : null}
                  {receipt.remarks ? <div style={{ marginTop: 6, fontSize: 13 }}>{receipt.remarks}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.72 }}>No replacement receipts recorded yet.</div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div style={{ fontWeight: 700 }}>Claim Lines</div>
        {lines.length ? (
          lines.map((line) => (
            <div key={line.id} style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700 }}>
                  L{line.line_no} • {line.item_code || line.item_name || "Item"}
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>
                  Source replacement action: {fmtDate(line.source_action_date)}
                </div>
              </div>
              <div style={{ fontSize: 13, opacity: 0.78, marginTop: 6 }}>
                {line.item_name || line.line_description || "—"}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
                <Metric label="Claimed" value={num(line.qty_claimed).toFixed(4)} />
                <Metric label="Received" value={num(line.qty_received).toFixed(4)} />
                <Metric label="Pending" value={num(line.qty_pending).toFixed(4)} />
              </div>
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.78 }}>
                {line.source_reference_no ? `Ref ${line.source_reference_no}` : "No source ref"}
                {line.source_expected_date ? ` • Expected ${fmtDate(line.source_expected_date)}` : ""}
                {line.serial_no_required ? " • Serial controlled" : ""}
              </div>
              {line.hold_reason ? <div style={{ marginTop: 6, fontSize: 13 }}>Hold Reason: {line.hold_reason}</div> : null}
              {line.remarks ? <div style={{ marginTop: 6, fontSize: 13 }}>Claim Note: {line.remarks}</div> : null}
            </div>
          ))
        ) : (
          <div style={{ opacity: 0.72 }}>No claim lines found.</div>
        )}
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
