import { useEffect, useMemo, useState } from "react";
import ConfirmDraftCard from "../components/ConfirmDraftCard";
import { buildVendorQuoteExtractDraft } from "../shared/aiDrafts";
import { DeskCard, DeskChip, EmptyState, FieldLabel, NoticeBanner, PageHero, getDeskStatusAppearance, toast, useSubmitLock } from "../shared/joshUi";

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

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `INR ${n.toFixed(2)}`;
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString();
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

async function downloadPdf(url, filename) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      throw new Error(errJson?.detail || errJson?.error || "Failed to download PDF report");
    }
    const blob = await res.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(objectUrl);
  } catch (err) {
    alert(err?.message || "Could not generate PDF");
  }
}

function mapVendorQuoteError(error, fallback) {
  const code = error?.data?.error;
  if (code === "COMPANY_CONTEXT_MISMATCH") return "Company context mismatch — switch company and retry.";
  if (code === "PO_ALREADY_CREATED") return "A purchase order already exists for this quote.";
  if (code === "REQUISITION_NEEDS_APPROVAL") return "Requisition must be approved before creating a PO.";
  if (code === "NO_QUOTE_LINES") return "Quote has no lines to convert into a PO.";
  if (code === "QUOTE_CANCELLED") return "This quote is cancelled.";
  if (code === "FORBIDDEN") return "You do not have permission for this action.";
  return getApiErrorMessage(error, fallback);
}

const fieldInputStyle = {
  height: 36,
  padding: "0 10px",
  borderRadius: 10,
  border: "1px solid #d8e0ec",
  background: "#ffffff",
  width: "100%",
};

const MODE_TABS = [
  { key: "rfq", label: "1. Send RFQ" },
  { key: "receive", label: "2. Receive quote" },
  { key: "compare", label: "3. Compare → PO" },
];

export default function VendorQuotes({ launch = null, onConsumeLaunch = null, onNavigate = null }) {
  const { busy, isBusy, runLocked } = useSubmitLock();
  const [bootstrap, setBootstrap] = useState({ vendors: [], requisitions: [], mail_configured: false });
  const [requisitionId, setRequisitionId] = useState("");
  const [mode, setMode] = useState("rfq");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [compare, setCompare] = useState(null);
  const [rfqDetail, setRfqDetail] = useState(null);
  const sendingRfq = isBusy("rfq-create");
  const receivingQuote = isBusy("receive");
  const selectingWinner = isBusy("select-winner");
  const creatingPo = isBusy("create-po");
  const saving = busy;

  // Send RFQ form
  const [selectedVendorIds, setSelectedVendorIds] = useState([]);
  const [rfqDueDate, setRfqDueDate] = useState("");
  const [rfqRemarks, setRfqRemarks] = useState("");
  const [sendEmail, setSendEmail] = useState(true);

  // Receive form
  const [receiveInviteId, setReceiveInviteId] = useState("");
  const [receiveVendorId, setReceiveVendorId] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [creditDays, setCreditDays] = useState("");
  const [deliveryDays, setDeliveryDays] = useState("");
  const [complianceOk, setComplianceOk] = useState(true);
  const [complianceNotes, setComplianceNotes] = useState("");
  const [receiveRemarks, setReceiveRemarks] = useState("");
  const [lineEdits, setLineEdits] = useState([]);
  const [extractFile, setExtractFile] = useState(null);
  const [extractPaste, setExtractPaste] = useState("");
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractDraft, setExtractDraft] = useState(null);
  const [createPoAfterExtract, setCreatePoAfterExtract] = useState(true);

  async function loadBootstrap() {
    const data = await apiFetch("/vendor-quotes/bootstrap");
    setBootstrap({
      vendors: Array.isArray(data?.vendors) ? data.vendors : [],
      requisitions: Array.isArray(data?.requisitions) ? data.requisitions : [],
      mail_configured: Boolean(data?.mail_configured),
    });
  }

  async function loadCompare(id) {
    if (!id) {
      setCompare(null);
      setRfqDetail(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/vendor-quotes/compare/${id}`);
      setCompare(data);
      const openRfq = Array.isArray(data?.rfqs) ? data.rfqs.find((r) => r.rfq_status === "sent") || data.rfqs[0] : null;
      if (openRfq?.id) {
        const rfqData = await apiFetch(`/vendor-quotes/rfqs/${openRfq.id}`);
        setRfqDetail(rfqData?.rfq || null);
      } else {
        setRfqDetail(null);
      }
      const pendingLines = (data?.lines || []).filter((line) => Number(line.qty_pending || 0) > 0.0001);
      setLineEdits(
        pendingLines.map((line) => ({
          purchase_requisition_line_id: line.id,
          item_code: line.item_code,
          item_name: line.item_name,
          uom: line.uom,
          qty: Number(line.qty_pending || 0),
          unit_price: Number(line.estimated_unit_price || 0),
          freight_per_unit: 0,
          gst_pct: Number(line.gst_pct || 0),
        }))
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load compare desk."));
      setCompare(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBootstrap().catch(() => setError("Failed to load vendors / requisitions."));
  }, []);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    if (launch.requisition_id) setRequisitionId(String(launch.requisition_id));
    if (typeof launch.mode === "string" && MODE_TABS.some((t) => t.key === launch.mode)) setMode(launch.mode);
    onConsumeLaunch?.();
  }, [launch]);

  useEffect(() => {
    if (!requisitionId) {
      setCompare(null);
      setRfqDetail(null);
      return;
    }
    loadCompare(requisitionId);
  }, [requisitionId]);

  const selectedRequisition = useMemo(
    () => bootstrap.requisitions.find((r) => String(r.id) === String(requisitionId)) || compare?.requisition || null,
    [bootstrap.requisitions, requisitionId, compare]
  );

  const pendingInvites = useMemo(() => {
    const vendors = rfqDetail?.vendors || [];
    return vendors.filter((v) => v.invite_status === "invited" && !v.vendor_quote_id);
  }, [rfqDetail]);

  function toggleVendor(id) {
    setSelectedVendorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function sendRfq() {
    if (!requisitionId) return setError("Select a purchase requisition first.");
    if (!selectedVendorIds.length) return setError("Select at least one vendor.");
    await runLocked("rfq-create", async () => {
      setError("");
      setNotice("");
      try {
        const data = await apiFetch("/vendor-quotes/rfqs", {
          method: "POST",
          body: JSON.stringify({
            purchase_requisition_id: Number(requisitionId),
            vendor_ids: selectedVendorIds.map(Number),
            due_date: rfqDueDate || null,
            remarks: rfqRemarks || null,
            send_email: sendEmail,
          }),
        });
        const emailed = (data?.email?.results || []).filter((r) => r.ok).length;
        const failed = (data?.email?.results || []).filter((r) => !r.ok).length;
        const msg =
          `RFQ ${data?.rfq?.rfq_number || ""} sent to ${selectedVendorIds.length} vendor(s).` +
          (sendEmail ? ` Email ok: ${emailed}, skipped/failed: ${failed}.` : " Email not requested — use Print RFQ.") +
          " Capture replies manually under Receive quote.";
        setNotice(msg);
        toast(msg, "success");
        setSelectedVendorIds([]);
        setRfqDetail(data?.rfq || null);
        await loadCompare(requisitionId);
        setMode("receive");
      } catch (e) {
        const message = mapVendorQuoteError(e, "Failed to send RFQ.");
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function extractVendorQuotePdf() {
    if (!requisitionId) return setError("Select a purchase requisition first.");
    if (!receiveInviteId && !receiveVendorId) {
      return setError("Pick an RFQ invite or vendor before extracting the quote PDF.");
    }
    if (!extractFile && !extractPaste.trim()) {
      return setError("Upload a vendor quote PDF (or paste quote text) to extract.");
    }

    setExtractBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("purchase_requisition_id", String(requisitionId));
      if (receiveInviteId) form.append("purchase_rfq_vendor_id", String(receiveInviteId));
      if (receiveVendorId) form.append("vendor_id", String(receiveVendorId));
      form.append("create_po_after", createPoAfterExtract ? "true" : "false");
      if (extractFile) form.append("file", extractFile);
      if (extractPaste.trim()) form.append("text", extractPaste.trim());

      const res = await fetch("/extraction/vendor-quote-pdf", {
        credentials: "include",
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const err = new Error("Extract failed");
        err.status = res.status;
        err.data = data;
        throw err;
      }

      const vendorLabel =
        pendingInvites.find((v) => String(v.id) === String(receiveInviteId))?.vendor_name ||
        bootstrap.vendors.find((v) => String(v.id) === String(receiveVendorId))?.company_name ||
        "";
      const draft = buildVendorQuoteExtractDraft({
        extraction: data.extraction,
        context: data.context || {},
        vendorLabel,
      });
      if (!draft) {
        setError("Extraction returned no usable draft.");
        return;
      }
      // Prefill manual form too so the operator can see the numbers.
      const fields = data.extraction?.fields || {};
      if (fields.payment_terms) setPaymentTerms(String(fields.payment_terms));
      if (fields.credit_days != null) setCreditDays(String(fields.credit_days));
      if (fields.delivery_days != null) setDeliveryDays(String(fields.delivery_days));
      if (fields.compliance_notes) setComplianceNotes(String(fields.compliance_notes));
      if (Array.isArray(fields.lines) && fields.lines.length) {
        setLineEdits((prev) =>
          prev.map((row) => {
            const hit = fields.lines.find((l) => Number(l.purchase_requisition_line_id) === Number(row.purchase_requisition_line_id));
            if (!hit) return row;
            return {
              ...row,
              qty: hit.qty != null ? String(hit.qty) : row.qty,
              unit_price: hit.unit_price != null ? String(hit.unit_price) : row.unit_price,
              freight_per_unit: hit.freight_per_unit != null ? String(hit.freight_per_unit) : row.freight_per_unit,
            };
          })
        );
      }
      setExtractDraft(draft);
      setNotice(
        data.extraction?.used_slm
          ? "Extract used heuristics + mock SLM. Review the confirm card before saving."
          : "Extract used heuristics only. Review the confirm card before saving."
      );
    } catch (e) {
      setError(mapVendorQuoteError(e, "Failed to extract vendor quote."));
    } finally {
      setExtractBusy(false);
    }
  }

  async function confirmExtractDraft(data, working) {
    setExtractDraft(null);
    const quoteId = data?.vendor_quote?.id;
    const msg = `Quote ${data?.vendor_quote?.quote_number || ""} captured from extract.`;
    setNotice(msg);
    toast(msg, "success");
    setExtractFile(null);
    setExtractPaste("");
    await loadCompare(requisitionId);
    setMode("compare");

    if (working?.payload?.create_po_after && quoteId) {
      try {
        await apiFetch(`/vendor-quotes/${quoteId}/select-winner`, { method: "POST", body: "{}" }).catch(() => null);
        const poData = await apiFetch(`/vendor-quotes/${quoteId}/create-po`, { method: "POST", body: "{}" });
        const poId = poData?.purchase_order?.id;
        const poNumber = poData?.purchase_order?.po_number;
        const poMsg = `Draft PO ${poNumber || ""} created from extracted quote.`;
        setNotice(poMsg);
        toast(poMsg, "success");
        await loadCompare(requisitionId);
        if (poId && typeof onNavigate === "function") {
          onNavigate("purchase_orders", {
            resetQuote: true,
            openPurchaseOrderId: poId,
          });
        }
      } catch (e) {
        const message = mapVendorQuoteError(e, "Quote saved, but draft PO could not be created yet.");
        setError(message);
        toast(message, "error");
      }
    }
  }

  async function receiveQuote() {
    if (!requisitionId) return setError("Select a purchase requisition first.");
    const payload = {
      payment_terms: paymentTerms || null,
      credit_days: creditDays === "" ? null : Number(creditDays),
      delivery_days: deliveryDays === "" ? null : Number(deliveryDays),
      compliance_ok: complianceOk,
      compliance_notes: complianceNotes || null,
      remarks: receiveRemarks || null,
      lines: lineEdits.map((line) => ({
        purchase_requisition_line_id: line.purchase_requisition_line_id,
        qty: Number(line.qty || 0),
        unit_price: Number(line.unit_price || 0),
        freight_per_unit: Number(line.freight_per_unit || 0),
        gst_pct: Number(line.gst_pct || 0),
      })),
    };
    if (receiveInviteId) {
      payload.purchase_rfq_vendor_id = Number(receiveInviteId);
    } else {
      if (!receiveVendorId) return setError("Pick an RFQ invite or a vendor.");
      payload.purchase_requisition_id = Number(requisitionId);
      payload.vendor_id = Number(receiveVendorId);
    }

    await runLocked("receive", async () => {
      setError("");
      setNotice("");
      try {
        const data = await apiFetch("/vendor-quotes/receive", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const msg = `Quote ${data?.vendor_quote?.quote_number || ""} captured (manual entry). Ready to compare.`;
        setNotice(msg);
        toast(msg, "success");
        setReceiveInviteId("");
        setReceiveVendorId("");
        setPaymentTerms("");
        setCreditDays("");
        setDeliveryDays("");
        setComplianceOk(true);
        setComplianceNotes("");
        setReceiveRemarks("");
        await loadCompare(requisitionId);
        setMode("compare");
      } catch (e) {
        const message = mapVendorQuoteError(e, "Failed to capture quote.");
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function selectWinner(quoteId) {
    await runLocked("select-winner", async () => {
      setError("");
      try {
        await apiFetch(`/vendor-quotes/${quoteId}/select-winner`, { method: "POST", body: "{}" });
        const msg = "Winner selected.";
        setNotice(msg);
        toast(msg, "success");
        await loadCompare(requisitionId);
      } catch (e) {
        const message = mapVendorQuoteError(e, "Failed to select winner.");
        setError(message);
        toast(message, "error");
      }
    });
  }

  async function createPo(quoteId) {
    await runLocked("create-po", async () => {
      setError("");
      try {
        const data = await apiFetch(`/vendor-quotes/${quoteId}/create-po`, { method: "POST", body: "{}" });
        const poId = data?.purchase_order?.id;
        const poNumber = data?.purchase_order?.po_number;
        const msg = `Draft PO ${poNumber || ""} created from winning quote.`;
        setNotice(msg);
        toast(msg, "success");
        await loadCompare(requisitionId);
        if (poId && typeof onNavigate === "function") {
          onNavigate("purchase_orders", {
            resetQuote: true,
            openPurchaseOrderId: poId,
          });
        }
      } catch (e) {
        const message = mapVendorQuoteError(e, "Failed to create PO. Need Purchase Orders create right.");
        setError(message);
        toast(message, "error");
      }
    });
  }

  const quotes = Array.isArray(compare?.quotes) ? compare.quotes : [];
  const headerTone = getDeskStatusAppearance(selectedRequisition?.requisition_status || "draft");

  return (
    <div style={{ maxWidth: 1240, display: "grid", gap: 16 }}>
      <PageHero
        eyebrow="Procurement"
        title="Vendor Quotes / RFQ"
        description="PR-linked desk: send RFQ to vendors, capture replies manually, compare a few decision fields, then create the PO."
        actions={
          <>
            <button type="button" onClick={() => loadBootstrap().then(() => loadCompare(requisitionId))} disabled={loading || saving}>
              Refresh
            </button>
            {typeof onNavigate === "function" ? (
              <button type="button" onClick={() => onNavigate("purchase_requisitions", { resetQuote: true })}>
                Open PRs
              </button>
            ) : null}
          </>
        }
        stats={[
          { label: "PR", value: selectedRequisition?.requisition_number || "—", tone: headerTone.color },
          { label: "Quotes", value: quotes.length, tone: "#234a8f" },
          { label: "RFQs", value: compare?.rfqs?.length || 0, tone: "#0b7d45" },
          { label: "Mail", value: bootstrap.mail_configured ? "SMTP ready" : "Print / manual", tone: "#b45309" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />
      <NoticeBanner
        tone="info"
        message="Upload a vendor quote PDF (or paste text) to extract commercials → Confirm card → receive (+ optional draft PO). Manual entry remains available."
      />

      {extractDraft ? (
        <ConfirmDraftCard
          draft={extractDraft}
          onCancel={() => setExtractDraft(null)}
          onConfirmed={confirmExtractDraft}
          onError={(e) => {
            const message = mapVendorQuoteError(e, "Failed to confirm extracted quote.");
            setError(message);
            toast(message, "error");
          }}
        />
      ) : null}

      <DeskCard title="Purchase requisition" subtitle="Work against one approved PR with pending quantity.">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(220px, 0.6fr)", gap: 12, alignItems: "end" }}>
          <FieldLabel label="Approved PR with pending qty">
            <select value={requisitionId} onChange={(e) => setRequisitionId(e.target.value)} style={fieldInputStyle}>
              <option value="">Select requisition…</option>
              {bootstrap.requisitions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.requisition_number} · {r.pending_lines} lines · qty {Number(r.pending_qty || 0)}
                  {r.department ? ` · ${r.department}` : ""}
                </option>
              ))}
            </select>
          </FieldLabel>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {MODE_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setMode(tab.key)}
                style={{
                  borderRadius: 12,
                  border: `1px solid ${mode === tab.key ? "#234a8f" : "#d8e0ec"}`,
                  background: mode === tab.key ? "#eef4ff" : "#fff",
                  color: mode === tab.key ? "#234a8f" : "#475569",
                  padding: "10px 12px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </DeskCard>

      {!requisitionId ? (
        <DeskCard title="Start here" subtitle="Pick a PR to send RFQs and capture quotes.">
          <EmptyState title="No requisition selected" body="Choose an approved PR with pending quantity to begin the RFQ → quote → PO flow." />
        </DeskCard>
      ) : null}

      {requisitionId && mode === "rfq" ? (
        <DeskCard
          title="Send RFQ"
          subtitle="Invite vendors against this PR. Emails go out when SMTP is configured; otherwise print the RFQ sheet."
          actions={rfqDetail ? <DeskChip label={rfqDetail.rfq_number} tone="#eef4ff" color="#234a8f" /> : null}
        >
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <FieldLabel label="Quote due date">
                <input type="date" value={rfqDueDate} onChange={(e) => setRfqDueDate(e.target.value)} style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="Send email if SMTP ready">
                <label style={{ display: "flex", alignItems: "center", gap: 8, height: 36 }}>
                  <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
                  {bootstrap.mail_configured ? "Email vendors (contact_email)" : "SMTP not configured — print instead"}
                </label>
              </FieldLabel>
            </div>
            <FieldLabel label="Remarks to vendors">
              <textarea
                value={rfqRemarks}
                onChange={(e) => setRfqRemarks(e.target.value)}
                rows={2}
                style={{ ...fieldInputStyle, height: "auto", padding: 10 }}
              />
            </FieldLabel>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Vendors</div>
              <div style={{ display: "grid", gap: 6, maxHeight: 280, overflow: "auto", border: "1px solid #e2e8f0", borderRadius: 12, padding: 10 }}>
                {bootstrap.vendors.map((v) => {
                  const checked = selectedVendorIds.includes(v.id);
                  return (
                    <label key={v.id} style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleVendor(v.id)} />
                      <span style={{ flex: 1 }}>
                        <strong>{v.company_name}</strong>
                        {v.vendor_code ? ` · ${v.vendor_code}` : ""}
                      </span>
                      <span style={{ color: "#64748b", fontSize: 13 }}>{v.contact_email || "no email"}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={sendRfq} disabled={saving || !selectedVendorIds.length}>
                {sendingRfq ? "Sending…" : "Send RFQ"}
              </button>
              {rfqDetail?.id ? (
                <a href={`/vendor-quotes/rfqs/${rfqDetail.id}/print`} target="_blank" rel="noreferrer">
                  <button type="button">Print / open RFQ sheet</button>
                </a>
              ) : null}
            </div>
            {rfqDetail ? (
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  Latest RFQ {rfqDetail.rfq_number} · {rfqDetail.vendors?.length || 0} vendors · due {fmtDate(rfqDetail.due_date)}
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {(rfqDetail.vendors || []).map((v) => (
                    <div key={v.id} style={{ display: "flex", gap: 10, fontSize: 13 }}>
                      <DeskChip
                        label={String(v.invite_status || "").toUpperCase()}
                        tone={v.invite_status === "responded" ? "#ecfdf5" : "#f8fafc"}
                        color={v.invite_status === "responded" ? "#047857" : "#475569"}
                      />
                      <span style={{ flex: 1 }}>{v.vendor_name}</span>
                      <span style={{ color: "#64748b" }}>{v.email_sent_at ? `emailed ${fmtDate(v.email_sent_at)}` : v.email_error || "not emailed"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </DeskCard>
      ) : null}

      {requisitionId && mode === "receive" ? (
        <DeskCard title="Receive quote" subtitle="Extract from PDF/text with confirm, or enter the vendor reply manually.">
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ padding: 12, borderRadius: 14, border: "1px solid #d7e3f4", background: "#f8fbff", display: "grid", gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Extract from vendor quote PDF</div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10 }}>
                <FieldLabel label="PDF / text file">
                  <input
                    type="file"
                    accept=".pdf,.txt,application/pdf,text/plain"
                    onChange={(e) => setExtractFile(e.target.files?.[0] || null)}
                  />
                </FieldLabel>
                <FieldLabel label="Or paste quote text">
                  <textarea
                    rows={3}
                    value={extractPaste}
                    onChange={(e) => setExtractPaste(e.target.value)}
                    placeholder="Paste vendor quotation text if PDF text extract is weak…"
                    style={{ ...fieldInputStyle, height: "auto", padding: 10 }}
                  />
                </FieldLabel>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={createPoAfterExtract}
                  onChange={(e) => setCreatePoAfterExtract(e.target.checked)}
                />
                After confirm, also create draft PO from this quote
              </label>
              <div>
                <button type="button" onClick={extractVendorQuotePdf} disabled={extractBusy || Boolean(extractDraft) || saving}>
                  {extractBusy ? "Extracting…" : "Extract → draft confirm card"}
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <FieldLabel label="From RFQ invite (preferred)">
                <select
                  value={receiveInviteId}
                  onChange={(e) => {
                    setReceiveInviteId(e.target.value);
                    if (e.target.value) setReceiveVendorId("");
                  }}
                  style={fieldInputStyle}
                >
                  <option value="">Manual vendor (no invite)…</option>
                  {pendingInvites.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.vendor_name} · invited {fmtDate(v.invited_at)}
                    </option>
                  ))}
                </select>
              </FieldLabel>
              <FieldLabel label="Or vendor without RFQ">
                <select
                  value={receiveVendorId}
                  disabled={Boolean(receiveInviteId)}
                  onChange={(e) => setReceiveVendorId(e.target.value)}
                  style={fieldInputStyle}
                >
                  <option value="">Select vendor…</option>
                  {bootstrap.vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.company_name}
                    </option>
                  ))}
                </select>
              </FieldLabel>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
              <FieldLabel label="Payment / credit terms">
                <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. 45 days" style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="Credit days">
                <input type="number" min="0" value={creditDays} onChange={(e) => setCreditDays(e.target.value)} style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="Delivery days">
                <input type="number" min="0" value={deliveryDays} onChange={(e) => setDeliveryDays(e.target.value)} style={fieldInputStyle} />
              </FieldLabel>
              <FieldLabel label="Compliance OK">
                <label style={{ display: "flex", alignItems: "center", gap: 8, height: 36 }}>
                  <input type="checkbox" checked={complianceOk} onChange={(e) => setComplianceOk(e.target.checked)} />
                  Spec / docs OK
                </label>
              </FieldLabel>
            </div>
            <FieldLabel label="Compliance / commercial notes">
              <input value={complianceNotes} onChange={(e) => setComplianceNotes(e.target.value)} style={fieldInputStyle} />
            </FieldLabel>
            <FieldLabel label="Internal remarks">
              <input value={receiveRemarks} onChange={(e) => setReceiveRemarks(e.target.value)} style={fieldInputStyle} />
            </FieldLabel>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ padding: 8, textAlign: "left" }}>Item</th>
                    <th style={{ padding: 8, textAlign: "right", width: 100 }}>Qty</th>
                    <th style={{ padding: 8, textAlign: "right", width: 120 }}>Unit Price</th>
                    <th style={{ padding: 8, textAlign: "right", width: 120 }}>Freight / Unit</th>
                    <th style={{ padding: 8, textAlign: "right", width: 120 }}>Effective</th>
                  </tr>
                </thead>
                <tbody>
                  {lineEdits.map((line, idx) => {
                    const effective = Number(line.unit_price || 0) + Number(line.freight_per_unit || 0);
                    return (
                      <tr key={line.purchase_requisition_line_id} style={{ borderTop: "1px solid #e2e8f0" }}>
                        <td style={{ padding: 8 }}>
                          <div style={{ fontWeight: 600 }}>{line.item_name || line.item_code || "Line"}</div>
                          <div style={{ color: "#64748b" }}>
                            {line.item_code} · {line.uom || "—"}
                          </div>
                        </td>
                        <td style={{ padding: 8, width: 100, textAlign: "right" }}>
                          <input
                            type="number"
                            value={line.qty}
                            onChange={(e) =>
                              setLineEdits((prev) => prev.map((row, i) => (i === idx ? { ...row, qty: e.target.value } : row)))
                            }
                            style={{ ...fieldInputStyle, textAlign: "right", fontFamily: "monospace" }}
                          />
                        </td>
                        <td style={{ padding: 8, width: 120, textAlign: "right" }}>
                          <input
                            type="number"
                            value={line.unit_price}
                            onChange={(e) =>
                              setLineEdits((prev) => prev.map((row, i) => (i === idx ? { ...row, unit_price: e.target.value } : row)))
                            }
                            style={{ ...fieldInputStyle, textAlign: "right", fontFamily: "monospace" }}
                          />
                        </td>
                        <td style={{ padding: 8, width: 120, textAlign: "right" }}>
                          <input
                            type="number"
                            value={line.freight_per_unit}
                            onChange={(e) =>
                              setLineEdits((prev) =>
                                prev.map((row, i) => (i === idx ? { ...row, freight_per_unit: e.target.value } : row))
                              )
                            }
                            style={{ ...fieldInputStyle, textAlign: "right", fontFamily: "monospace" }}
                          />
                        </td>
                        <td style={{ padding: 8, textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>{fmtMoney(effective)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <button type="button" onClick={receiveQuote} disabled={saving}>
              {receivingQuote ? "Saving…" : "Save received quote"}
            </button>
          </div>
        </DeskCard>
      ) : null}

      {requisitionId && mode === "compare" ? (
        <DeskCard
          title="Compare & create PO"
          subtitle="Side-by-side decision fields only — not a full rate matrix."
          actions={
            quotes.length ? (
              <button
                type="button"
                onClick={() => {
                  const rfqId = quotes[0]?.purchase_rfq_id || quotes[0]?.rfq_id || rfqDetail?.id;
                  if (rfqId) {
                    downloadPdf(`/api/vendors/rfqs/${rfqId}/comparison-pdf`, `RFQ-Comparison-${rfqId}.pdf`);
                  } else {
                    alert("No RFQ ID linked to these quotes to generate comparison PDF.");
                  }
                }}
              >
                Export RFQ Comparison PDF
              </button>
            ) : null
          }
        >
          {loading ? <div>Loading…</div> : null}
          {!loading && !quotes.length ? (
            <EmptyState
              title="No quotes captured yet"
              body="Receive at least one vendor reply first, then compare and create the PO."
            />
          ) : null}
          {quotes.length ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ padding: 10, textAlign: "left" }}>Vendor</th>
                    <th style={{ padding: 10, textAlign: "right", width: 140 }}>Effective Total</th>
                    <th style={{ padding: 10, textAlign: "left", width: 160 }}>Payment / Credit</th>
                    <th style={{ padding: 10, textAlign: "right", width: 110 }}>Delivery Days</th>
                    <th style={{ padding: 10, textAlign: "center", width: 130 }}>Compliance</th>
                    <th style={{ padding: 10, textAlign: "center", width: 180 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map((q) => {
                    const tone = q.is_winner ? "#ecfdf5" : "#fff";
                    return (
                      <tr key={q.id} style={{ borderTop: "1px solid #e2e8f0", background: tone }}>
                        <td style={{ padding: 10 }}>
                          <div style={{ fontWeight: 700 }}>{q.vendor_name}</div>
                          <div style={{ color: "#64748b" }}>
                            {q.quote_number}
                            {q.rfq_number ? ` · ${q.rfq_number}` : ""}
                            {q.is_winner ? " · WINNER" : ""}
                          </div>
                        </td>
                        <td style={{ padding: 10, textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>{fmtMoney(q.effective_total)}</td>
                        <td style={{ padding: 10 }}>
                          {q.payment_terms || "—"}
                          {q.credit_days != null ? ` (${q.credit_days}d)` : ""}
                        </td>
                        <td style={{ padding: 10, textAlign: "right", fontFamily: "monospace" }}>{q.delivery_days != null ? `${q.delivery_days}d` : "—"}</td>
                        <td style={{ padding: 10, textAlign: "center" }}>
                          <span style={{ fontWeight: 600, color: q.compliance_ok ? "#16a34a" : "#dc2626" }}>
                            {q.compliance_ok ? "✓ OK" : "⚠ Flagged"}
                          </span>
                          {q.compliance_notes ? <div style={{ fontSize: 11, color: "#64748b" }}>{q.compliance_notes}</div> : null}
                        </td>
                        <td style={{ padding: 10, textAlign: "center" }}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                            <button
                              type="button"
                              style={{ background: "#f1f5f9", color: "#334155" }}
                              onClick={() => downloadPdf(`/api/vendors/${q.vendor_id}/compliance-report`, `Compliance-${q.vendor_name || q.vendor_id}.pdf`)}
                              title="Download statutory compliance and AVL approval PDF dossier"
                            >
                              Compliance PDF
                            </button>
                            {!q.purchase_order_id ? (
                              <>
                                <button type="button" disabled={saving} onClick={() => selectWinner(q.id)}>
                                  {selectingWinner ? "Selecting…" : "Select"}
                                </button>
                                <button type="button" disabled={saving} onClick={() => createPo(q.id)}>
                                  {creatingPo ? "Creating…" : "Create PO"}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  typeof onNavigate === "function" &&
                                  onNavigate("purchase_orders", { resetQuote: true, openPurchaseOrderId: q.purchase_order_id })
                                }
                              >
                                Open {q.po_number || "PO"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {quotes.length ? (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Line effective prices</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 640 }}>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th style={{ padding: 8, textAlign: "left" }}>PR Line</th>
                      {quotes.map((q) => (
                        <th key={q.id} style={{ padding: 8, textAlign: "right" }}>
                          {q.vendor_name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(compare?.lines || [])
                      .filter((line) => Number(line.qty_pending || 0) > 0.0001 || quotes.some((q) => (q.lines || []).some((l) => Number(l.purchase_requisition_line_id) === Number(line.id))))
                      .map((line) => (
                        <tr key={line.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                          <td style={{ padding: 8 }}>
                            {line.item_code || line.item_name}
                            <div style={{ color: "#64748b" }}>qty {Number(line.qty_pending || line.qty_requested || 0)}</div>
                          </td>
                          {quotes.map((q) => {
                            const ql = (q.lines || []).find((l) => Number(l.purchase_requisition_line_id) === Number(line.id));
                            return (
                              <td key={`${q.id}-${line.id}`} style={{ padding: 8, textAlign: "right", fontFamily: "monospace" }}>
                                {ql ? fmtMoney(ql.effective_unit_price) : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </DeskCard>
      ) : null}
    </div>
  );
}
