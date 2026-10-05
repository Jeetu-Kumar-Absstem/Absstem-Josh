import { useEffect, useMemo, useState } from "react";
import { daysUntil, formatDate, vendorRequest } from "./api";

export default function GuestRfqView({ token, onBack }) {
  const [rfq, setRfq] = useState(null);
  const [tokenExpiry, setTokenExpiry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const [lines, setLines] = useState([]);
  const [deliveryDays, setDeliveryDays] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");

  async function load() {
    setLoading(true); setError(""); setExpired(false);
    try {
      const payload = await vendorRequest(`/vendor-portal/guest/${encodeURIComponent(token)}`);
      const value = payload?.rfq || payload?.request || payload?.data || payload;
      setRfq(value);
      setTokenExpiry(payload?.guest?.token_expires_at || null);
      const sourceLines = value?.lines || value?.items || value?.rfq_lines || [];
      setLines(sourceLines.map((line) => ({ ...line, quantity: line.qty_requested || line.requested_quantity || line.quantity || 1, price: "", freight: "" })));
      setDeliveryDays("");
    } catch (requestError) {
      setExpired(requestError.status === 410 || requestError.status === 404 || /expired|used|invalid/i.test(requestError.message || ""));
      setError(requestError.message || "This guest link could not be opened.");
    } finally { setLoading(false); }
  }
  useEffect(() => { if (token) load(); else { setLoading(false); setError("This guest link is missing its access token."); } }, [token]);

  function updateLine(index, key, value) { setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, [key]: value } : line)); }
  function addFiles(event) { setFiles((current) => [...current, ...Array.from(event.target.files || []).map((file) => ({ file, document_type: "OTHER", expiry_date: "" }))]); }
  function updateFile(index, key, value) { setFiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item)); }
  function removeFile(index) { setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index)); }

  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const body = new FormData();
      body.append("lines", JSON.stringify(lines.map((line) => ({
        purchase_requisition_line_id: Number(line.id),
        qty: Number(line.quantity),
        unit_price: Number(line.price),
        freight_per_unit: Number(line.freight || 0),
      }))));
      body.append("delivery_days", String(Number(deliveryDays)));
      body.append("remarks", notes);
      body.append("documents_metadata", JSON.stringify(files.map((item) => ({
        document_type: item.document_type,
        expiry_date: item.expiry_date,
      }))));
      files.forEach((item) => body.append("documents", item.file));
      await vendorRequest(`/vendor-portal/guest/${encodeURIComponent(token)}/quote`, { method: "POST", body });
      setSubmitted(true);
    } catch (requestError) { setMessage(requestError.message || "We could not submit this guest response."); }
    finally { setBusy(false); }
  }

  const dueDays = useMemo(() => daysUntil(tokenExpiry || rfq?.expires_at || rfq?.expires_on || rfq?.due_date), [rfq, tokenExpiry]);
  if (loading) return <GuestFrame onBack={onBack}><div className="vp-token-panel"><div className="vp-state"><span className="vp-spinner" /><strong>Opening secure RFQ link</strong><p>Verifying the one-time invitation.</p></div></div></GuestFrame>;
  if (error && !rfq) return <GuestFrame onBack={onBack}><div className="vp-token-panel"><section className="vp-panel vp-token-card"><div className="vp-panel-body"><div className={`vp-token-mark ${expired ? "danger" : ""}`}>{expired ? "!" : "RFQ"}</div><div className="vp-eyebrow">{expired ? "Link unavailable" : "Cannot open request"}</div><h1 className="vp-page-title">{expired ? "This invitation has closed." : "RFQ link unavailable."}</h1><p className="vp-page-copy">{error} Guest links are single-use and time-bound. Ask procurement for a fresh invitation if needed.</p><button className="vp-button secondary" style={{ marginTop: 22 }} onClick={onBack} type="button">Return to portal</button></div></section></div></GuestFrame>;
  if (submitted) return <GuestFrame onBack={onBack}><div className="vp-token-panel"><section className="vp-panel vp-token-card"><div className="vp-panel-body"><div className="vp-token-mark">✓</div><div className="vp-eyebrow">Response received</div><h1 className="vp-page-title">Quote submitted.</h1><p className="vp-page-copy">Your response was sent to the absstem procurement desk. This single-use link is now closed.</p><div className="vp-notice success" style={{ marginTop: 22 }}>Keep your commercial reference for follow-up: <strong>{rfq?.reference || rfq?.rfq_number || `RFQ-${rfq?.id || "guest"}`}</strong>.</div><button className="vp-button secondary" style={{ marginTop: 22 }} onClick={onBack} type="button">Return to portal</button></div></section></div></GuestFrame>;

  return <GuestFrame onBack={onBack}><div className="vp-page-head"><div><div className="vp-eyebrow">Single-use supplier invitation</div><h1 className="vp-page-title">{rfq?.title || rfq?.reference || rfq?.rfq_number || "Request for quotation"}</h1><p className="vp-page-copy">{rfq?.description || "Review the requested lines, provide your commercial response, and attach current statutory records if requested."}</p></div><div className="vp-head-actions"><span className={`vp-chip ${dueDays !== null && dueDays < 0 ? "danger" : dueDays !== null && dueDays < 3 ? "warning" : "info"}`}>{dueDays !== null && dueDays < 0 ? "Expired" : dueDays !== null ? `${dueDays} days remaining` : "Time-bound link"}</span></div></div><div className="vp-notice warning"><strong>Guest access</strong><span>This link can be used once. Submit only when every line and required attachment is final. Expires {formatDate(rfq?.guest?.token_expires_at || rfq?.token_expires_at || rfq?.expires_at || rfq?.expires_on || rfq?.due_date)}.</span></div><form className="vp-rfq-layout" onSubmit={submit}><div><section className="vp-rfq-card"><div className="vp-rfq-title"><div><h2>Price each requested line</h2><p>Quantity, unit price, and freight are required for a comparable quote.</p></div><span className="vp-mono vp-top-meta">{lines.length} lines</span></div>{lines.length ? lines.map((line, index) => <div className="vp-line-editor" key={line.id || index}><div><strong>{line.description || line.line_description || line.item_name || line.name || "Requested item"}</strong><small>Requested {line.qty_requested || line.requested_quantity || line.quantity || 1} {line.uom || line.unit || "units"}</small></div><div className="vp-field"><label htmlFor={`guest-qty-${index}`}>Qty</label><input id={`guest-qty-${index}`} type="number" min="1" required value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} /></div><div className="vp-field"><label htmlFor={`guest-price-${index}`}>Unit price</label><input id={`guest-price-${index}`} type="number" min="0" step="0.01" required value={line.price} onChange={(event) => updateLine(index, "price", event.target.value)} /></div><div className="vp-field"><label htmlFor={`guest-freight-${index}`}>Freight</label><input id={`guest-freight-${index}`} type="number" min="0" step="0.01" required value={line.freight} onChange={(event) => updateLine(index, "freight", event.target.value)} /></div></div>) : <div className="vp-state"><strong>No line items supplied</strong><p>Contact procurement before submitting this invitation.</p></div>}</section><section className="vp-rfq-card"><div className="vp-rfq-title"><div><h2>Delivery and notes</h2><p>Make lead time and commercial exceptions explicit.</p></div></div><div className="vp-form-grid"><div className="vp-field"><label htmlFor="guest-delivery">Delivery lead time (days)</label><input id="guest-delivery" type="number" min="0" required value={deliveryDays} onChange={(event) => setDeliveryDays(event.target.value)} placeholder="e.g. 28" /></div><div className="vp-field"><label htmlFor="guest-notes">Notes to procurement</label><textarea id="guest-notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Validity, exclusions, or other commercial notes" /></div></div></section></div><aside><section className="vp-rfq-card"><div className="vp-rfq-title"><div><h2>Statutory attachments</h2><p>Multiple files accepted. Add type and expiry for each.</p></div></div><div className="vp-upload"><input type="file" multiple onChange={addFiles} /></div><div className="vp-file-list">{files.map((item, index) => <div key={`${item.file.name}-${index}`} className="vp-doc-row"><div><strong>{item.file.name}</strong><span>{Math.round(item.file.size / 1024)} KB</span></div><div className="vp-form"><div className="vp-field"><label htmlFor={`guest-doc-type-${index}`}>Type</label><select id={`guest-doc-type-${index}`} value={item.document_type} onChange={(event) => updateFile(index, "document_type", event.target.value)}><option value="GST_CERTIFICATE">GST certificate</option><option value="PAN_CARD">PAN card</option><option value="MSME">MSME</option><option value="ISO">ISO</option><option value="OTHER">Other statutory document</option></select></div><div className="vp-field"><label htmlFor={`guest-doc-expiry-${index}`}>Expiry</label><input id={`guest-doc-expiry-${index}`} type="date" required value={item.expiry_date} onChange={(event) => updateFile(index, "expiry_date", event.target.value)} /></div><button className="vp-button secondary small" type="button" onClick={() => removeFile(index)}>Remove file</button></div></div>)}</div></section>{message ? <div className="vp-notice danger" style={{ marginTop: 12 }}>{message}</div> : null}<button className="vp-button" style={{ width: "100%", marginTop: 12 }} type="submit" disabled={busy || !lines.length}>{busy ? "Sending final response…" : "Submit final quote"}</button><button className="vp-button secondary" style={{ width: "100%", marginTop: 8 }} type="button" onClick={onBack}>Cancel and return</button></aside></form></GuestFrame>;
}

function GuestFrame({ children, onBack }) {
  return <div className="vp-frame"><header className="vp-topbar"><div className="vp-shell vp-topbar-inner"><button className="vp-brand" type="button" onClick={onBack} style={{ border: 0, background: "transparent", padding: 0 }}><span className="vp-brand-mark">AS</span><span className="vp-brand-copy"><strong>absstem / guest RFQ</strong><span>Secure supplier response</span></span></button><span className="vp-top-meta vp-mono">INVITATION CONTROLLED</span></div></header><main className="vp-main vp-shell">{children}</main></div>;
}
