import { useEffect, useState } from "react";
import { asList, formatDate, statusTone, vendorRequest } from "./api";

function Status({ value }) { return <span className={`vp-chip ${statusTone(value)}`}>{String(value || "Pending").replaceAll("_", " ")}</span>; }

async function downloadReport(url, filename) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.detail || err?.error || "Download failed");
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
    alert(err?.message || "Failed to download PDF dossier");
  }
}

export default function RfqQuoteDesk({ onBack }) {
  const [tab, setTab] = useState("quotes");
  const [quotes, setQuotes] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  async function load() {
    setLoading(true); setError("");
    try {
      const [quotePayload, vendorPayload, documentPayload, tokenPayload] = await Promise.all([
        vendorRequest("/vendor-portal/admin/quotes"),
        vendorRequest("/vendor-portal/admin/vendors"),
        vendorRequest("/vendor-portal/admin/documents"),
        vendorRequest("/vendor-portal/admin/guest-tokens"),
      ]);
      setQuotes(asList(quotePayload, ["quotes", "items", "data"]));
      setVendors(asList(vendorPayload, ["vendors", "items", "data"]));
      setDocuments(asList(documentPayload, ["documents", "items", "data"]));
      setTokens(asList(tokenPayload, ["tokens", "guest_tokens", "items", "data"]));
    } catch (requestError) { setError(requestError.message || "The quote desk could not load its review queues."); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function verify(decision) {
    if (!selected) return;
    setActionBusy(true);
    try {
      const verificationStatus = decision === "approved" ? "internal_verified" : "rejected";
      await vendorRequest(`/vendor-portal/admin/quotes/${selected.id}/verification`, { method: "PATCH", body: { verification_status: verificationStatus } });
      setQuotes((items) => items.map((item) => item.id === selected.id ? { ...item, verification_status: verificationStatus, status: verificationStatus } : item));
      setSelected((current) => ({ ...current, verification_status: verificationStatus, status: verificationStatus }));
    } catch (requestError) { setError(requestError.message || `Could not ${decision} this response.`); }
    finally { setActionBusy(false); }
  }

  const pendingQuotes = quotes.filter((quote) => !/verified|rejected|approved|accepted/i.test(quote.verification_status || quote.status || ""));
  const pendingDocs = documents.filter((doc) => !/approved|verified/i.test(doc.verification_status || doc.status || ""));
  return <DeskFrame onBack={onBack}><div className="vp-page-head"><div><div className="vp-eyebrow">Internal procurement</div><h1 className="vp-page-title">RFQ quote desk</h1><p className="vp-page-copy">Compare supplier responses, verify guest submissions, and keep compliance decisions visible.</p></div><div className="vp-head-actions"><span className="vp-chip warning">{pendingQuotes.length} need review</span><button className="vp-button secondary" type="button" onClick={load}>Refresh desk</button></div></div>{error ? <div className="vp-notice danger" role="alert">{error}</div> : null}<div className="vp-metrics"><div className="vp-metric" style={{ "--metric-color": "var(--vp-blue)" }}><span>Quote responses</span><strong>{quotes.length}</strong></div><div className="vp-metric" style={{ "--metric-color": "var(--vp-amber)" }}><span>Awaiting verification</span><strong>{pendingQuotes.length}</strong></div><div className="vp-metric" style={{ "--metric-color": "var(--vp-teal)" }}><span>Registered vendors</span><strong>{vendors.length}</strong></div><div className="vp-metric" style={{ "--metric-color": "var(--vp-red)" }}><span>Guest links</span><strong>{tokens.length}</strong></div></div><div className="vp-panel"><div className="vp-desk-tabs"><button className={tab === "quotes" ? "active" : ""} type="button" onClick={() => setTab("quotes")}>Quote comparison <span>({quotes.length})</span></button><button className={tab === "vendors" ? "active" : ""} type="button" onClick={() => setTab("vendors")}>Vendors <span>({vendors.length})</span></button><button className={tab === "documents" ? "active" : ""} type="button" onClick={() => setTab("documents")}>Compliance review <span>({documents.length})</span></button><button className={tab === "tokens" ? "active" : ""} type="button" onClick={() => setTab("tokens")}>Guest tokens <span>({tokens.length})</span></button></div>{loading ? <div className="vp-state"><span className="vp-spinner" /><strong>Loading review queues</strong><p>Pulling quote, vendor, and verification records.</p></div> : tab === "quotes" ? <QuoteQueue quotes={quotes} onSelect={setSelected} /> : tab === "vendors" ? <GenericQueue rows={vendors} kind="vendor" /> : tab === "documents" ? <GenericQueue rows={documents} kind="document" /> : <GenericQueue rows={tokens} kind="token" />}</div>{selected ? <VerificationPanel quote={selected} busy={actionBusy} onClose={() => setSelected(null)} onDecision={verify} /> : null}</DeskFrame>;
}

function QuoteQueue({ quotes, onSelect }) {
  if (!quotes.length) return <div className="vp-state"><strong>No quote responses yet</strong><p>Submitted supplier responses will appear here for comparison and verification.</p></div>;
  const groups = Object.values(quotes.reduce((result, quote) => { const key = quote.rfq_id || quote.rfq?.id || quote.reference || quote.id; (result[key] ||= []).push(quote); return result; }, {}));
  return (
    <div className="vp-panel-body vp-grid">
      {groups.map((group, groupIndex) => (
        <section key={group[0].rfq_id || groupIndex}>
          <div className="vp-rfq-title">
            <div>
              <h2>{group[0].rfq_title || group[0].rfq?.title || group[0].rfq_number || group[0].reference || "RFQ comparison"}</h2>
              <p>{group.length} supplier response{group.length === 1 ? "" : "s"} · due {formatDate(group[0].due_date)}</p>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="vp-button secondary small"
                type="button"
                onClick={() => downloadReport(`/api/vendors/rfqs/${group[0].rfq_id || group[0].purchase_rfq_id}/comparison-pdf`, `RFQ-Comparison-${group[0].rfq_id || "summary"}.pdf`)}
              >
                Export PDF Comparison
              </button>
              <span className="vp-chip info">Compare quote totals</span>
            </div>
          </div>
          <div className="vp-compare">
            {group
              .sort((a, b) => Number(a.quote_total || a.total || a.grand_total || Infinity) - Number(b.quote_total || b.total || b.grand_total || Infinity))
              .map((quote, index) => (
                <button className={`vp-quote-card ${index === 0 ? "best" : ""}`} key={quote.id} type="button" onClick={() => onSelect(quote)}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <h3>{quote.vendor_name || quote.vendor?.name || quote.supplier_name || "Supplier response"}</h3>
                    {index === 0 ? <span className="vp-chip success">Lowest</span> : null}
                  </div>
                  <div className="vp-quote-total">₹ {Number(quote.quote_total || quote.total || quote.grand_total || 0).toLocaleString()}</div>
                  <div className="vp-kpi-line"><span>Delivery</span><strong>{quote.delivery_days != null ? `${quote.delivery_days} days` : quote.delivery_terms || quote.lead_time || "Not specified"}</strong></div>
                  <div className="vp-kpi-line"><span>Verification</span><Status value={quote.verification_status || quote.status} /></div>
                  <div style={{ marginTop: 12, color: "var(--vp-blue)", fontSize: 12, fontWeight: 800 }}>Open verification →</div>
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function GenericQueue({ rows, kind }) {
  if (!rows.length) return <div className="vp-state"><strong>No {kind} records</strong><p>There is nothing waiting in this queue right now.</p></div>;
  return (
    <div className="vp-table-wrap">
      <table className="vp-table">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>{kind}</th>
            <th style={{ textAlign: "left" }}>Reference / Contact</th>
            <th style={{ textAlign: "center", width: 120 }}>Status</th>
            <th style={{ textAlign: "left", width: 140 }}>Updated</th>
            {kind === "document" ? <th style={{ textAlign: "center", width: 140 }}>Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id || index}>
              <td>
                <span className="primary-cell">
                  {row.name || row.company_name || row.document_type || row.token || `${kind} ${row.id || index + 1}`}
                </span>
              </td>
              <td>
                <span className="sub-cell">
                  {row.email || row.vendor_name || row.file_name || row.reference || "—"}
                </span>
              </td>
              <td style={{ textAlign: "center" }}>
                <Status value={row.status || row.verification_status || (row.used ? "Used" : "Active")} />
              </td>
              <td>{formatDate(row.updated_at || row.created_at || row.expires_at)}</td>
              {kind === "document" ? (
                <td style={{ textAlign: "center" }}>
                  <a
                    className="vp-button secondary small"
                    href={`/api/vendor-portal/documents/${row.id}/view`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                  >
                    View Document
                  </a>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VerificationPanel({ quote, busy, onClose, onDecision }) {
  return (
    <section className="vp-panel" style={{ marginTop: 16 }}>
      <div className="vp-panel-head">
        <div>
          <div className="vp-eyebrow">Explicit verification control</div>
          <h2>Review {quote.vendor_name || quote.vendor?.name || "supplier response"}</h2>
          <p>{quote.reference || quote.rfq_title || quote.rfq_number || "Submitted quote"} · received {formatDate(quote.submitted_at || quote.created_at)}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {quote.vendor_id ? (
            <button
              className="vp-button secondary small"
              type="button"
              onClick={() => downloadReport(`/api/vendors/${quote.vendor_id}/compliance-report`, `Compliance-${quote.vendor_name || quote.vendor_id}.pdf`)}
            >
              Compliance Dossier PDF
            </button>
          ) : null}
          <button className="vp-button secondary small" type="button" onClick={onClose}>Close review</button>
        </div>
      </div>
      <div className="vp-panel-body vp-verify">
        <div className="vp-grid three">
          <div className="vp-kpi-line"><span>Total</span><strong>₹ {Number(quote.quote_total || quote.total || quote.grand_total || 0).toLocaleString()}</strong></div>
          <div className="vp-kpi-line"><span>Delivery</span><strong>{quote.delivery_days != null ? `${quote.delivery_days} days` : quote.delivery_terms || quote.lead_time || "Not specified"}</strong></div>
          <div className="vp-kpi-line"><span>Current state</span><Status value={quote.verification_status || quote.status} /></div>
        </div>
        <div className="vp-notice warning">Approving confirms that procurement has reviewed this guest response and its attached evidence. Reject only with a follow-up path recorded in the quote notes.</div>
        <div className="vp-verification-actions">
          <button className="vp-button danger" type="button" disabled={busy} onClick={() => onDecision("rejected")}>{busy ? "Saving…" : "Reject response"}</button>
          <button className="vp-button" type="button" disabled={busy} onClick={() => onDecision("approved")}>{busy ? "Saving…" : "Approve verification"}</button>
        </div>
      </div>
    </section>
  );
}

function DeskFrame({ children, onBack }) {
  return <div className="vp-frame"><header className="vp-topbar"><div className="vp-shell vp-topbar-inner"><button className="vp-brand" type="button" onClick={onBack} style={{ border: 0, background: "transparent", padding: 0 }}><span className="vp-brand-mark">AS</span><span className="vp-brand-copy"><strong>absstem / internal quote desk</strong><span>Procurement verification control</span></span></button><span className="vp-chip info">INTERNAL</span></div></header><main className="vp-main vp-shell">{children}</main></div>;
}
