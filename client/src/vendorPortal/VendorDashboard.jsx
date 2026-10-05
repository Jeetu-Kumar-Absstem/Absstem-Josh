import { useEffect, useMemo, useState } from "react";
import { asList, daysUntil, formatDate, getVendorToken, setVendorToken, statusTone, vendorRequest } from "./api";

function Status({ value }) {
  return <span className={`vp-chip ${statusTone(value)}`}>{String(value || "Pending").replaceAll("_", " ")}</span>;
}

function LoadingState() {
  return <div className="vp-state"><span className="vp-spinner" aria-label="Loading" /><strong>Syncing supplier workspace</strong><p>Pulling RFQs and compliance records from Josh.</p></div>;
}

function ErrorState({ message, retry }) {
  return <div className="vp-state"><strong>Workspace unavailable</strong><p>{message}</p><button className="vp-button secondary small" type="button" onClick={retry}>Try again</button></div>;
}

export default function VendorDashboard({ onLogout }) {
  const [user, setUser] = useState(null);
  const [rfqs, setRfqs] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [quote, setQuote] = useState({ lines: [], delivery_days: "", notes: "" });
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteMessage, setQuoteMessage] = useState("");
  const [upload, setUpload] = useState({ file: null, document_type: "GST_CERTIFICATE", expiry_date: "" });
  const [uploadBusy, setUploadBusy] = useState(false);

  async function load() {
    setLoading(true); setError("");
    try {
      const [mePayload, rfqPayload, documentPayload] = await Promise.all([
        vendorRequest("/vendor-portal/auth/me", { registered: true }),
        vendorRequest("/vendor-portal/rfqs", { registered: true }),
        vendorRequest("/vendor-portal/documents", { registered: true }),
      ]);
      setUser(mePayload?.user || mePayload?.vendor_user || mePayload);
      setRfqs(asList(rfqPayload, ["rfqs", "items", "data"]));
      setDocuments(asList(documentPayload, ["documents", "items", "data"]));
    } catch (requestError) {
      if (requestError.status === 401 || requestError.status === 403) {
        setVendorToken("");
        onLogout();
      } else setError(requestError.message || "The portal could not load your current records.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!getVendorToken()) {
      onLogout();
      return undefined;
    }
    load();
    const timer = window.setInterval(load, 300000);
    return () => window.clearInterval(timer);
  }, []);

  async function openRfq(rfq) {
    setSelected(rfq);
    setQuoteMessage("");
    try {
      const payload = await vendorRequest(`/vendor-portal/rfqs/${rfq.id}`, { registered: true });
      const detail = payload?.rfq || payload;
      const lines = (detail?.lines || []).map((line) => ({
        ...line,
        price: "",
        freight: "",
        quantity: line.qty_requested || 1,
      }));
      setSelected(detail);
      setQuote({ lines, delivery_days: "", notes: "" });
    } catch (requestError) {
      setQuoteMessage(requestError.message || "Unable to load the requested RFQ.");
    }
  }

  function updateLine(index, key, value) {
    setQuote((current) => ({ ...current, lines: current.lines.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line) }));
  }

  async function submitQuote(event) {
    event.preventDefault(); setQuoteBusy(true); setQuoteMessage("");
    try {
      await vendorRequest(`/vendor-portal/rfqs/${selected.id}/quote`, {
        method: "POST",
        registered: true,
        body: {
          delivery_days: Number(quote.delivery_days),
          remarks: quote.notes,
          lines: quote.lines.map((line) => ({
            purchase_requisition_line_id: Number(line.id),
            qty: Number(line.quantity),
            unit_price: Number(line.price),
            freight_per_unit: Number(line.freight || 0),
          })),
        },
      });
      setQuoteMessage("Quote submitted. Procurement can now review your response.");
      setRfqs((items) => items.map((item) => item.id === selected.id ? { ...item, submission_status: "Submitted", status: "Submitted" } : item));
    } catch (requestError) { setQuoteMessage(requestError.message || "Quote submission failed."); }
    finally { setQuoteBusy(false); }
  }

  async function uploadDocument(event) {
    event.preventDefault();
    if (!upload.file) return;
    setUploadBusy(true);
    try {
      const body = new FormData();
      body.append("file", upload.file);
      body.append("document_type", upload.document_type);
      body.append("expiry_date", upload.expiry_date);
      await vendorRequest("/vendor-portal/documents", { method: "POST", registered: true, body });
      setUpload({ file: null, document_type: "GST_CERTIFICATE", expiry_date: "" });
      await load();
    } catch (requestError) { setError(requestError.message || "Document upload failed."); }
    finally { setUploadBusy(false); }
  }

  const pendingDocs = useMemo(() => documents.filter((doc) => !/approved|verified/i.test(doc.verification_status || doc.status || "")), [documents]);
  if (loading) return <DashboardFrame onLogout={onLogout} user={user}><LoadingState /></DashboardFrame>;
  if (error && !rfqs.length && !documents.length) return <DashboardFrame onLogout={onLogout} user={user}><ErrorState message={error} retry={load} /></DashboardFrame>;

  return (
    <DashboardFrame onLogout={onLogout} user={user}>
      {error ? <div className="vp-notice danger" role="alert">{error}</div> : null}
      <div className="vp-page-head">
        <div><div className="vp-eyebrow">Supplier control room</div><h1 className="vp-page-title">Good to see you, {user?.contact_name || user?.name || "supplier"}.</h1><p className="vp-page-copy">Keep responses moving and statutory records ready for verification.</p></div>
        <div className="vp-head-actions"><span className="vp-chip success">Portal active</span><button className="vp-button secondary" type="button" onClick={load}>Refresh records</button></div>
      </div>
      <div className="vp-metrics">
        <div className="vp-metric" style={{ "--metric-color": "var(--vp-blue)" }}><span>Open RFQs</span><strong>{rfqs.filter((rfq) => !/closed|expired/i.test(rfq.status || "")).length}</strong></div>
        <div className="vp-metric" style={{ "--metric-color": "var(--vp-amber)" }}><span>Awaiting response</span><strong>{rfqs.filter((rfq) => !/submitted|accepted|closed/i.test(rfq.submission_status || rfq.status || "")).length}</strong></div>
        <div className="vp-metric" style={{ "--metric-color": "var(--vp-teal)" }}><span>Documents on file</span><strong>{documents.length}</strong></div>
        <div className="vp-metric" style={{ "--metric-color": pendingDocs.length ? "var(--vp-red)" : "var(--vp-teal)" }}><span>Needs attention</span><strong>{pendingDocs.length}</strong></div>
      </div>
      <div className="vp-grid two">
        <section className="vp-panel">
          <div className="vp-panel-head"><div><h2>Active requests for quotation</h2><p>Review line items and submit pricing before the due date.</p></div><span className="vp-mono vp-top-meta">{rfqs.length} records</span></div>
          {rfqs.length ? (
            <div className="vp-table-wrap">
              <table className="vp-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Request</th>
                    <th style={{ textAlign: "left", width: 120 }}>Due</th>
                    <th style={{ textAlign: "center", width: 120 }}>Submission</th>
                    <th style={{ textAlign: "center", width: 120 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rfqs.map((rfq) => {
                    const days = daysUntil(rfq.due_date || rfq.response_due_at);
                    return (
                      <tr key={rfq.id}>
                        <td>
                          <span className="primary-cell">{rfq.title || rfq.reference || `RFQ-${rfq.id}`}</span>
                          <span className="sub-cell vp-mono">{rfq.reference || rfq.rfq_number || "Procurement request"}</span>
                        </td>
                        <td>
                          <strong>{formatDate(rfq.due_date || rfq.response_due_at)}</strong>
                          {days !== null ? (
                            <span className="sub-cell">{days < 0 ? `${Math.abs(days)} days overdue` : `${days} days left`}</span>
                          ) : null}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <Status value={rfq.submission_status || rfq.status} />
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <button className="vp-button small" type="button" onClick={() => openRfq(rfq)}>
                            {/submitted/i.test(rfq.submission_status || "") ? "Review response" : "Respond"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="vp-state">
              <strong>No active RFQs</strong>
              <p>New requests will appear here when procurement invites your vendor account.</p>
            </div>
          )}
        </section>
        <section className="vp-panel">
          <div className="vp-panel-head"><div><h2>Statutory compliance locker</h2><p>Keep expiry dates visible and documents current.</p></div></div>
          <div className="vp-panel-body">
            {pendingDocs.length ? <div className="vp-notice warning">A document needs review or renewal before the next award can be released.</div> : null}
            <div className="vp-doc-list" style={{ marginTop: pendingDocs.length ? 13 : 0 }}>
              {documents.length ? (
                documents.map((doc) => {
                  const days = daysUntil(doc.expiry_date || doc.expires_at);
                  const tone = days !== null && days < 0 ? "danger" : days !== null && days < 30 ? "warning" : statusTone(doc.status || "verified");
                  return (
                    <div className="vp-doc-row" key={doc.id || `${doc.document_type}-${doc.expiry_date}`}>
                      <div>
                        <strong>{doc.document_type || doc.type || "Compliance document"}</strong>
                        <span>
                          {doc.file_name || doc.filename || "Uploaded file"} · expires {formatDate(doc.expiry_date || doc.expires_at)}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {doc.id && (
                          <button
                            className="vp-button secondary small"
                            type="button"
                            onClick={async () => {
                              try {
                                const res = await fetch(`/api/vendor-portal/documents/${doc.id}/view`, {
                                  headers: { Authorization: `Bearer ${getVendorToken()}` },
                                });
                                if (!res.ok) throw new Error("Could not load document");
                                const blob = await res.blob();
                                const url = window.URL.createObjectURL(blob);
                                window.open(url, "_blank");
                              } catch (err) {
                                alert(err.message || "Failed to open document preview");
                              }
                            }}
                          >
                            View
                          </button>
                        )}
                        <span className={`vp-chip ${tone}`}>
                          {days !== null && days < 0 ? "Expired" : days !== null && days < 30 ? `${days}d left` : doc.status || "On file"}
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="vp-state">
                  <strong>Locker is empty</strong>
                  <p>Upload GST, PAN, bank, and other statutory records below.</p>
                </div>
              )}
            </div>
            <form className="vp-form" style={{ marginTop: 18 }} onSubmit={uploadDocument}><div className="vp-upload"><div className="vp-eyebrow">Add statutory file</div><div className="vp-form-grid"><div className="vp-field"><label htmlFor="document-type">Document type</label><select id="document-type" value={upload.document_type} onChange={(event) => setUpload({ ...upload, document_type: event.target.value })}><option value="GST_CERTIFICATE">GST certificate</option><option value="PAN_CARD">PAN card</option><option value="MSME">MSME</option><option value="ISO">ISO</option><option value="BANK_PROOF">Bank proof</option><option value="OTHER">Other statutory document</option></select></div><div className="vp-field"><label htmlFor="document-expiry">Expiry date</label><input id="document-expiry" type="date" required value={upload.expiry_date} onChange={(event) => setUpload({ ...upload, expiry_date: event.target.value })} /></div></div><input type="file" required accept=".pdf,.png,.jpg,.jpeg" onChange={(event) => setUpload({ ...upload, file: event.target.files?.[0] || null })} /></div><button className="vp-button secondary" type="submit" disabled={uploadBusy}>{uploadBusy ? "Uploading…" : "Upload to compliance locker"}</button></form>
          </div>
        </section>
      </div>
      {selected ? <div className="vp-panel" style={{ marginTop: 16 }}><div className="vp-panel-head"><div><div className="vp-eyebrow">Response workspace</div><h2>{selected.title || selected.reference || selected.rfq_number || `RFQ-${selected.id}`}</h2><p>Enter a unit price, freight, and confirmed quantity for every requested line.</p></div><button className="vp-button secondary small" type="button" onClick={() => setSelected(null)}>Close response</button></div><form className="vp-panel-body vp-form" onSubmit={submitQuote}><div>{quote.lines.length ? quote.lines.map((line, index) => <div className="vp-line-editor" key={line.id || index}><div><strong>{line.description || line.line_description || line.item_name || line.name || "Requested item"}</strong><small>Requested {line.qty_requested || line.quantity || 1} {line.uom || line.unit || "units"}</small></div><div className="vp-field"><label htmlFor={`qty-${index}`}>Qty</label><input id={`qty-${index}`} type="number" min="1" value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} /></div><div className="vp-field"><label htmlFor={`price-${index}`}>Unit price</label><input id={`price-${index}`} type="number" min="0" step="0.01" required value={line.price} onChange={(event) => updateLine(index, "price", event.target.value)} /></div><div className="vp-field"><label htmlFor={`freight-${index}`}>Freight</label><input id={`freight-${index}`} type="number" min="0" step="0.01" value={line.freight} onChange={(event) => updateLine(index, "freight", event.target.value)} /></div></div>) : <div className="vp-state"><strong>Line details are not available</strong><p>This request has no line items to price. Contact procurement if this looks unexpected.</p></div>}</div><div className="vp-form-grid"><div className="vp-field"><label htmlFor="delivery-days">Delivery lead time (days)</label><input id="delivery-days" type="number" min="0" required value={quote.delivery_days} onChange={(event) => setQuote({ ...quote, delivery_days: event.target.value })} placeholder="e.g. 28" /></div><div className="vp-field"><label htmlFor="quote-notes">Notes to procurement</label><input id="quote-notes" value={quote.notes} onChange={(event) => setQuote({ ...quote, notes: event.target.value })} placeholder="Optional commercial notes" /></div></div>{quoteMessage ? <div className={`vp-notice ${/failed|could not/i.test(quoteMessage) ? "danger" : "success"}`}>{quoteMessage}</div> : null}<button className="vp-button" type="submit" disabled={quoteBusy || !quote.lines.length}>{quoteBusy ? "Submitting response…" : "Submit quote response"}</button></form></div> : null}
    </DashboardFrame>
  );
}

function DashboardFrame({ children, onLogout, user }) {
  return <div className="vp-frame"><header className="vp-topbar"><div className="vp-shell vp-topbar-inner"><div className="vp-brand"><span className="vp-brand-mark">AS</span><span className="vp-brand-copy"><strong>absstem / vendor portal</strong><span>Supplier operations & compliance</span></span></div><div className="vp-top-actions"><span className="vp-top-meta">{user?.email || "Registered vendor"}</span><button className="vp-button secondary small" type="button" onClick={onLogout}>Sign out</button></div></div></header><main className="vp-main vp-shell">{children}</main></div>;
}
