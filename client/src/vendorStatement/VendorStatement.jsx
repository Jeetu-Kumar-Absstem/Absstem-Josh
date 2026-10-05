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

function fmtMoney(value, currencyCode) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${currencyCode ? `${currencyCode} ` : ""}${n.toFixed(2)}`;
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function bucketButtonStyle(active) {
  return {
    all: "unset",
    cursor: "pointer",
    border: `1px solid ${active ? "#cfe0ff" : "#e6ebf3"}`,
    background: active ? "#eef4ff" : "#ffffff",
    borderRadius: 18,
    padding: 14,
    display: "grid",
    gap: 6,
    boxShadow: active ? "0 10px 24px rgba(35, 74, 143, 0.10)" : "0 6px 18px rgba(26, 35, 53, 0.04)",
  };
}

function chipStyle(background, color) {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "4px 10px",
    borderRadius: 999,
    background,
    color,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  };
}

function metricCardStyle() {
  return {
    border: "1px solid #e7ebf3",
    borderRadius: 14,
    padding: 12,
    background: "#fafbff",
    display: "grid",
    gap: 4,
  };
}

function queueActionButtonStyle() {
  return {
    border: "1px solid #d4dbeb",
    background: "#ffffff",
    borderRadius: 10,
    padding: "8px 12px",
    cursor: "pointer",
  };
}

export default function VendorStatement({ launch, onConsumeLaunch, onOpenPurchaseInvoice, onOpenVendorPayments }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [vendors, setVendors] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [currencyId, setCurrencyId] = useState("");
  const [ageingVendors, setAgeingVendors] = useState([]);
  const [ageingInvoices, setAgeingInvoices] = useState([]);
  const [reconSummary, setReconSummary] = useState(null);
  const [reconRows, setReconRows] = useState([]);
  const [reconBucket, setReconBucket] = useState("overdue_no_action");
  const [reconQuery, setReconQuery] = useState("");
  const [reconLoading, setReconLoading] = useState(false);
  const [reconError, setReconError] = useState("");

  async function loadList(nextCurrencyId = currencyId) {
    setLoading(true);
    setError("");
    try {
      const q = nextCurrencyId ? `?currency_id=${encodeURIComponent(nextCurrencyId)}` : "";
      const data = await apiFetch(`/vendor-statement${q}`);
      setVendors(Array.isArray(data?.vendors) ? data.vendors : []);
      setCurrencies(Array.isArray(data?.currencies) ? data.currencies : []);
      setAgeingVendors(Array.isArray(data?.ageing_vendors) ? data.ageing_vendors : []);
      setAgeingInvoices(Array.isArray(data?.ageing_invoices) ? data.ageing_invoices : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load vendor statement."));
    } finally {
      setLoading(false);
    }
  }

  async function loadReconciliationSummary(nextCurrencyId = currencyId) {
    try {
      const q = nextCurrencyId ? `?currency_id=${encodeURIComponent(nextCurrencyId)}` : "";
      const data = await apiFetch(`/vendor-statement/reconciliation-summary${q}`);
      setReconSummary(data?.summary || null);
    } catch (e) {
      setReconSummary(null);
      setReconError(getApiErrorMessage(e, "Failed to load vendor reconciliation summary."));
    }
  }

  async function loadReconciliationQueue({ nextCurrencyId = currencyId, bucket = reconBucket, q = reconQuery } = {}) {
    setReconLoading(true);
    setReconError("");
    try {
      const params = new URLSearchParams();
      if (nextCurrencyId) params.set("currency_id", nextCurrencyId);
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/vendor-statement/reconciliation-queue${query ? `?${query}` : ""}`);
      setReconRows(Array.isArray(data?.rows) ? data.rows : []);
    } catch (e) {
      setReconRows([]);
      setReconError(getApiErrorMessage(e, "Failed to load vendor reconciliation queue."));
    } finally {
      setReconLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadList();
      loadReconciliationSummary().catch(() => {});
      loadReconciliationQueue().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadList(currencyId);
    loadReconciliationSummary(currencyId).catch(() => {});
    loadReconciliationQueue({ nextCurrencyId: currencyId, bucket: reconBucket, q: reconQuery }).catch(() => {});
  }, [currencyId]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadReconciliationQueue({ bucket: reconBucket }).catch(() => {});
  }, [reconBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextBucket = typeof launch.recon_bucket === "string" ? launch.recon_bucket : reconBucket;
    const nextQuery = typeof launch.recon_q === "string" ? launch.recon_q : "";
    const nextVendorId = Number(launch.vendor_id);
    if (Number.isFinite(nextVendorId) && nextVendorId > 0) {
      setView({ type: "vendor", vendorId: nextVendorId });
    } else if (view.type !== "list") {
      setView({ type: "list" });
    }
    setReconBucket(nextBucket);
    setReconQuery(nextQuery);
    loadReconciliationSummary(currencyId).catch(() => {});
    loadReconciliationQueue({ nextCurrencyId: currencyId, bucket: nextBucket, q: nextQuery }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  function openPayablesDeskForVendor(row) {
    if (typeof onOpenVendorPayments !== "function") return;
    let commandBucket = "payment_run_ready";
    if (Number(row?.blocked_match_amount || 0) > 0) commandBucket = "blocked_match";
    else if (Number(row?.submitted_payment_count || 0) > 0) commandBucket = "submitted";
    else if (Number(row?.approved_payment_count || 0) > 0) commandBucket = "approved";
    else if (Number(row?.active_payment_count || 0) > 0) commandBucket = "unallocated";
    else if (Number(row?.overdue_amount || 0) > 0) commandBucket = "overdue";
    onOpenVendorPayments({
      command_bucket: commandBucket,
      command_q: row?.vendor_name || "",
    });
  }

  if (view.type === "vendor") {
    return (
      <VendorStatementDetail
        vendorId={view.vendorId}
        currencyId={currencyId}
        currencies={currencies}
        onBack={() => setView({ type: "list" })}
        onSetCurrencyId={setCurrencyId}
        onOpenVendorPayments={() => openPayablesDeskForVendor({ vendor_name: vendors.find((item) => Number(item.id) === Number(view.vendorId))?.company_name || "" })}
      />
    );
  }

  const heroMetrics = [
    { label: "Overdue, no action", value: reconSummary?.overdue_no_action_vendors ?? ageingVendors.length, tone: "#8b5a00", amount: reconSummary?.overdue_no_action_amount || 0 },
    { label: "Payment gap", value: reconSummary?.payment_gap_vendors ?? 0, tone: "#234a8f", amount: reconSummary?.payment_gap_amount || 0 },
    { label: "Debit note gap", value: reconSummary?.debit_note_gap_vendors ?? 0, tone: "#7b4ad8", amount: reconSummary?.debit_note_gap_amount || 0 },
    { label: "Match blocked", value: reconSummary?.match_blocked_vendors ?? 0, tone: "#9f2042", amount: reconSummary?.match_blocked_amount || 0 },
  ];

  const bucketCards = [
    {
      key: "overdue_no_action",
      label: "Overdue with no action",
      count: Number(reconSummary?.overdue_no_action_vendors || 0),
      amount: Number(reconSummary?.overdue_no_action_amount || 0),
      tone: "#8b5a00",
    },
    {
      key: "payment_gap",
      label: "Recent payments not reflected",
      count: Number(reconSummary?.payment_gap_vendors || 0),
      amount: Number(reconSummary?.payment_gap_amount || 0),
      tone: "#234a8f",
    },
    {
      key: "debit_note_gap",
      label: "Recent debit notes to chase",
      count: Number(reconSummary?.debit_note_gap_vendors || 0),
      amount: Number(reconSummary?.debit_note_gap_amount || 0),
      tone: "#7b4ad8",
    },
    {
      key: "active_settlement",
      label: "Active settlements in flight",
      count: Number(reconSummary?.active_settlement_vendors || 0),
      amount: Number(reconSummary?.active_settlement_amount || 0),
      tone: "#0a7a35",
    },
    {
      key: "match_blocked",
      label: "Blocked by 3-way match",
      count: Number(reconSummary?.match_blocked_vendors || 0),
      amount: Number(reconSummary?.match_blocked_amount || 0),
      tone: "#9f2042",
    },
  ];

  return (
    <div style={{ maxWidth: 1380 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, opacity: 0.72, textTransform: "uppercase", letterSpacing: "0.08em" }}>AP Reconciliation Desk</div>
          <h2 style={{ margin: "4px 0 0 0" }}>Vendor Statement And Exceptions</h2>
        </div>
        <select value={currencyId} onChange={(e) => setCurrencyId(e.target.value)} disabled={loading} style={{ height: 34 }}>
          <option value="">All currencies</option>
          {currencies.map((c) => (
            <option key={c.id} value={String(c.id)}>{c.currency_code}</option>
          ))}
        </select>
        <button
          onClick={() => {
            loadList();
            loadReconciliationSummary().catch(() => {});
            loadReconciliationQueue().catch(() => {});
          }}
          disabled={loading || reconLoading}
        >
          {loading || reconLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0a7a35", marginTop: 12 }}>{notice}</div> : null}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
        {heroMetrics.map((item) => (
          <div key={item.label} style={{ ...metricCardStyle(), background: "#ffffff" }}>
            <div style={{ fontSize: 12, opacity: 0.68 }}>{item.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: item.tone }}>{item.value}</div>
            <div style={{ fontSize: 12, color: "#58627a" }}>
              {fmtMoney(item.amount)}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e7ebf3", borderRadius: 18, background: "#ffffff", padding: 16, boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)" }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Vendor Reconciliation Command Desk</div>
            <div style={{ marginTop: 4, fontSize: 13, color: "#58627a", lineHeight: 1.6 }}>
              Explain why the supplier statement may differ from Josh: overdue exposure with no action, recent payments or debit notes awaiting reflection, active settlements, and 3-way-match blocks.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {bucketCards.map((card) => (
              <button key={card.key} onClick={() => setReconBucket(card.key)} style={bucketButtonStyle(reconBucket === card.key)}>
                <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                <div style={{ fontSize: 12, opacity: 0.74 }}>{card.amount > 0 ? fmtMoney(card.amount) : "Open queue"}</div>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={reconQuery}
              onChange={(e) => setReconQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadReconciliationQueue({ q: reconQuery }).catch(() => {});
              }}
              placeholder="Search vendor or invoice"
              style={{ height: 38, minWidth: 260, flex: "1 1 260px", borderRadius: 10, border: "1px solid #d4dbeb", padding: "0 12px" }}
            />
            <button onClick={() => loadReconciliationQueue({ q: reconQuery })} disabled={reconLoading}>
              {reconLoading ? "Refreshing..." : "Refresh Exceptions"}
            </button>
            <div style={{ fontSize: 12, color: "#58627a" }}>Total AP in view: {fmtMoney(reconSummary?.total_outstanding_amount || 0)}</div>
          </div>

          {reconError ? <div style={{ color: "#b00020", fontSize: 13 }}>{reconError}</div> : null}

          {reconLoading ? (
            <div>Loading vendor reconciliation queue…</div>
          ) : reconRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {reconRows.map((row) => {
                const hasPaymentGap = Number(row.recent_posted_payment_amount || 0) > 0;
                const hasDebitNoteGap = Number(row.recent_debit_note_amount || 0) > 0;
                const hasActiveSettlement = Number(row.active_payment_count || 0) > 0;
                const hasMatchBlocked = Number(row.blocked_match_amount || 0) > 0;
                return (
                  <div
                    key={`${row.vendor_id}-${row.currency_id}`}
                    style={{
                      border: "1px solid #e7ebf3",
                      borderRadius: 18,
                      padding: 14,
                      background: "#ffffff",
                      boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                      display: "grid",
                      gap: 12,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 16 }}>{row.vendor_name}</div>
                        <div style={{ fontSize: 12, color: "#58627a", marginTop: 4 }}>
                          Oldest invoice {row.oldest_invoice_number || "—"} from {fmtDate(row.oldest_invoice_date)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <span style={chipStyle("#eef4ff", "#234a8f")}>{String(row.currency_code || "CUR").toUpperCase()}</span>
                        {hasPaymentGap ? <span style={chipStyle("#eef4ff", "#234a8f")}>PAYMENT GAP</span> : null}
                        {hasDebitNoteGap ? <span style={chipStyle("#f3ecff", "#6b36cc")}>DEBIT NOTE GAP</span> : null}
                        {hasActiveSettlement ? <span style={chipStyle("#edf9f1", "#0a7a35")}>ACTIVE SETTLEMENT</span> : null}
                        {hasMatchBlocked ? <span style={chipStyle("#fff2f3", "#9f2042")}>MATCH BLOCKED</span> : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                      <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Open invoices</div><div style={{ fontWeight: 800 }}>{row.open_invoice_count || 0}</div></div>
                      <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Overdue invoices</div><div style={{ fontWeight: 800 }}>{row.overdue_invoice_count || 0}</div></div>
                      <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Total AP</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.total_outstanding_amount, row.currency_code)}</div></div>
                      <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Overdue</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.overdue_amount, row.currency_code)}</div></div>
                      <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Blocked</div><div style={{ fontWeight: 800 }}>{fmtMoney(row.blocked_match_amount, row.currency_code)}</div></div>
                      <div style={metricCardStyle()}><div style={{ fontSize: 12, opacity: 0.68 }}>Oldest age</div><div style={{ fontWeight: 800 }}>{`${Number(row.oldest_ageing_days || 0)}d`}</div></div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                      <div style={{ ...metricCardStyle(), background: "#f8faff" }}>
                        <div style={{ fontSize: 12, opacity: 0.68 }}>Recent posted payments</div>
                        <div style={{ fontWeight: 800 }}>{fmtMoney(row.recent_posted_payment_amount, row.currency_code)}</div>
                        <div style={{ fontSize: 12, color: "#58627a" }}>
                          {row.recent_posted_payment_count || 0} docs{row.latest_payment_date ? ` • last ${fmtDate(row.latest_payment_date)}` : ""}
                        </div>
                      </div>
                      <div style={{ ...metricCardStyle(), background: "#fbf8ff" }}>
                        <div style={{ fontSize: 12, opacity: 0.68 }}>Recent debit notes</div>
                        <div style={{ fontWeight: 800 }}>{fmtMoney(row.recent_debit_note_amount, row.currency_code)}</div>
                        <div style={{ fontSize: 12, color: "#58627a" }}>
                          {row.recent_debit_note_count || 0} docs{row.latest_debit_note_date ? ` • last ${fmtDate(row.latest_debit_note_date)}` : ""}
                        </div>
                      </div>
                      <div style={{ ...metricCardStyle(), background: "#f2fbf6" }}>
                        <div style={{ fontSize: 12, opacity: 0.68 }}>Active settlements</div>
                        <div style={{ fontWeight: 800 }}>{fmtMoney(row.active_payment_amount, row.currency_code)}</div>
                        <div style={{ fontSize: 12, color: "#58627a" }}>
                          Draft {row.draft_payment_count || 0} • Submitted {row.submitted_payment_count || 0} • Approved {row.approved_payment_count || 0}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => setView({ type: "vendor", vendorId: Number(row.vendor_id) })} style={queueActionButtonStyle()}>
                        Open Vendor Ledger
                      </button>
                      <button onClick={() => openPayablesDeskForVendor(row)} style={queueActionButtonStyle()}>
                        Open Payables Desk
                      </button>
                      {Number.isFinite(Number(row.oldest_invoice_id)) && Number(row.oldest_invoice_id) > 0 ? (
                        <button onClick={() => onOpenPurchaseInvoice?.(Number(row.oldest_invoice_id))} style={queueActionButtonStyle()}>
                          Open Oldest Invoice
                        </button>
                      ) : null}
                    </div>

                    {hasMatchBlocked ? (
                      <div style={{ padding: 12, borderRadius: 14, background: "#fff7f7", border: "1px solid #ffd8d8", fontSize: 12, color: "#8c2d3d" }}>
                        AP is blocked by a 3-way quantity mismatch. Fix the purchasing flow before expecting the supplier statement to clear cleanly.
                      </div>
                    ) : hasActiveSettlement ? (
                      <div style={{ padding: 12, borderRadius: 14, background: "#f2fbf6", border: "1px solid #d9f1e3", fontSize: 12, color: "#24593b" }}>
                        A payment is already in flight for this vendor bucket. Use the payables desk to complete submission, approval, or posting.
                      </div>
                    ) : hasPaymentGap || hasDebitNoteGap ? (
                      <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, color: "#58627a" }}>
                        Use this queue when the supplier statement likely lags Josh because a payment or debit note was posted recently.
                      </div>
                    ) : (
                      <div style={{ padding: 12, borderRadius: 14, background: "#fff8ef", border: "1px solid #fde3b5", fontSize: 12, color: "#7c4b00" }}>
                        This vendor has overdue payable exposure with no recent settlement or credit activity. Chase the statement and decide the next settlement step.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
              No vendor exception rows in this bucket right now.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
        <select
          value=""
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) setView({ type: "vendor", vendorId: v });
          }}
          disabled={loading}
          style={{ height: 36, minWidth: 340 }}
        >
          <option value="">Open vendor statement…</option>
          {vendors.map((v) => (
            <option key={v.id} value={String(v.id)}>{v.company_name}</option>
          ))}
        </select>
        <div style={{ fontSize: 12, opacity: 0.75 }}>Pick a vendor to view the full ledger, running outstanding, and the statement-side explanation.</div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Ageing By Vendor</div>
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 140px repeat(5, 100px)", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Vendor</div><div>Statement</div><div>0-30</div><div>31-60</div><div>61-90</div><div>90+</div><div>Total</div>
          </div>
          {ageingVendors.length ? ageingVendors.slice(0, 8).map((row) => {
            const q = currencyId ? `?currency_id=${encodeURIComponent(currencyId)}` : "";
            return (
              <div key={row.vendor_id} style={{ display: "grid", gridTemplateColumns: "1.1fr 140px repeat(5, 100px)", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2", fontSize: 13, alignItems: "center" }}>
                <button onClick={() => setView({ type: "vendor", vendorId: Number(row.vendor_id) })} style={{ all: "unset", cursor: "pointer", color: "#0f4aa1" }}>
                  {row.vendor_name}
                </button>
                <a href={`/vendor-statement/vendor/${row.vendor_id}/statement/pdf${q}`} target="_blank" rel="noreferrer" style={{ color: "#0f4aa1", textDecoration: "none" }}>
                  Statement PDF
                </a>
                <div>{fmtMoney(row.current_bucket)}</div>
                <div>{fmtMoney(row.bucket_31_60)}</div>
                <div>{fmtMoney(row.bucket_61_90)}</div>
                <div>{fmtMoney(row.bucket_90_plus)}</div>
                <div>{fmtMoney(row.total_outstanding)}</div>
              </div>
            );
          }) : <div style={{ padding: 12, opacity: 0.72 }}>No outstanding ageing right now.</div>}
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid #e5e5e5", fontWeight: 700 }}>Most Overdue Purchase Invoices</div>
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr 90px 120px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
            <div>Invoice</div><div>Vendor</div><div>Days</div><div>Outstanding</div>
          </div>
          {ageingInvoices.length ? ageingInvoices.slice(0, 8).map((row) => (
            <button
              key={row.id}
              onClick={() => onOpenPurchaseInvoice?.(row.id)}
              style={{ all: "unset", cursor: "pointer", display: "grid", gridTemplateColumns: "140px 1fr 90px 120px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2", fontSize: 13 }}
            >
              <div>{row.purchase_invoice_number}</div>
              <div>{row.vendor_name}</div>
              <div>{row.ageing_days || 0}</div>
              <div>{fmtMoney(row.outstanding_invoice, row.invoice_currency_code)}</div>
            </button>
          )) : <div style={{ padding: 12, opacity: 0.72 }}>No overdue purchase invoices.</div>}
        </div>
      </div>
    </div>
  );
}

function VendorStatementDetail({ vendorId, currencyId, currencies, onBack, onSetCurrencyId, onOpenVendorPayments }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [vendor, setVendor] = useState(null);
  const [statementRows, setStatementRows] = useState([]);
  const [summary, setSummary] = useState({ total_invoiced: 0, total_paid: 0, outstanding: 0 });
  const [currencyLabel, setCurrencyLabel] = useState("INR");

  useEffect(() => {
    setLoading(true);
    setError("");
    const q = currencyId ? `?currency_id=${encodeURIComponent(currencyId)}` : "";
    apiFetch(`/vendor-statement/vendor/${vendorId}/statement${q}`)
      .then((data) => {
        setVendor(data?.vendor || null);
        setStatementRows(Array.isArray(data?.statementRows) ? data.statementRows : []);
        setSummary(data?.summary || { total_invoiced: 0, total_paid: 0, outstanding: 0 });
        setCurrencyLabel(data?.currencyLabel || "INR");
      })
      .catch((e) => setError(getApiErrorMessage(e, "Failed to load vendor statement.")))
      .finally(() => setLoading(false));
  }, [vendorId, currencyId]);

  const pdfHref = useMemo(() => {
    const q = currencyId ? `?currency_id=${encodeURIComponent(currencyId)}` : "";
    return `/vendor-statement/vendor/${vendorId}/statement/pdf${q}`;
  }, [vendorId, currencyId]);

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={onBack} disabled={loading}>Back</button>
        <h2 style={{ margin: 0, flex: 1 }}>{vendor?.company_name || "Vendor Statement"}</h2>
        <select value={currencyId} onChange={(e) => onSetCurrencyId(e.target.value)} disabled={loading} style={{ height: 34 }}>
          <option value="">All currencies</option>
          {currencies.map((c) => (
            <option key={c.id} value={String(c.id)}>{c.currency_code}</option>
          ))}
        </select>
        <a href={pdfHref} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
          <button disabled={loading}>Open PDF</button>
        </a>
        {typeof onOpenVendorPayments === "function" ? (
          <button onClick={onOpenVendorPayments} disabled={loading}>
            Open Payables Desk
          </button>
        ) : null}
      </div>

      {error ? <div style={{ color: "#b00020", marginTop: 12 }}>{error}</div> : null}

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Vendor</div>
          <div><strong>{vendor?.company_name || "—"}</strong></div>
          <div style={{ opacity: 0.8, fontSize: 13 }}>Code: {vendor?.vendor_code || "—"}</div>
          <div style={{ opacity: 0.8, fontSize: 13 }}>GSTIN: {vendor?.gstin || "—"}</div>
        </div>
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Summary</div>
          <div>Total Invoiced: {fmtMoney(summary.total_invoiced, currencyLabel)}</div>
          <div>Total Paid: {fmtMoney(summary.total_paid, currencyLabel)}</div>
          <div><strong>Outstanding: {fmtMoney(summary.outstanding, currencyLabel)}</strong></div>
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "110px 110px 160px 1fr 120px 120px 120px", gap: 8, padding: 12, fontSize: 12, opacity: 0.8, borderBottom: "1px solid #e5e5e5" }}>
          <div>Date</div><div>Type</div><div>Reference</div><div>Description</div><div>Debit</div><div>Credit</div><div>Balance</div>
        </div>
        {loading ? (
          <div style={{ padding: 12 }}>Loading…</div>
        ) : statementRows.length ? (
          statementRows.map((row, idx) => (
            <div
              key={`${row.txn_type}-${row.reference_no}-${idx}`}
              style={{ display: "grid", gridTemplateColumns: "110px 110px 160px 1fr 120px 120px 120px", gap: 8, padding: 12, borderBottom: "1px solid #f2f2f2", fontSize: 13 }}
            >
              <div>{fmtDate(row.txn_date)}</div>
              <div>{row.txn_type}</div>
              <div>{row.reference_no}</div>
              <div>{row.description}</div>
              <div>{row.debit ? fmtMoney(row.debit, row.currency_code) : "—"}</div>
              <div>{row.credit ? fmtMoney(row.credit, row.currency_code) : "—"}</div>
              <div>{fmtMoney(row.running_balance, currencyLabel)}</div>
            </div>
          ))
        ) : (
          <div style={{ padding: 12, opacity: 0.72 }}>No statement rows.</div>
        )}
      </div>
    </div>
  );
}
