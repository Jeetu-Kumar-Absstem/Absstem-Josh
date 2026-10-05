import { useEffect, useMemo, useState } from "react";
import ApprovalHistoryDrawer from "../shared/ApprovalHistoryDrawer";
import SlideOverDrawer from "../components/SlideOverDrawer";
import { DeskCard, DeskChip, EmptyState, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance, toast, useSubmitLock } from "../shared/joshUi";

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

function buildAllocationRows(openInvoices, allocations) {
  const map = new Map();
  for (const row of openInvoices || []) {
    map.set(Number(row.id), {
      purchase_invoice_id: Number(row.id),
      purchase_invoice_number: row.purchase_invoice_number,
      invoice_date: row.invoice_date,
      invoice_status: row.invoice_status,
      invoice_currency_code: row.invoice_currency_code,
      invoice_total: row.grand_total_invoice,
      invoice_outstanding_before_current: row.outstanding,
      allocated_amount: "0",
    });
  }
  for (const row of allocations || []) {
    map.set(Number(row.purchase_invoice_id), {
      purchase_invoice_id: Number(row.purchase_invoice_id),
      purchase_invoice_number: row.purchase_invoice_number,
      invoice_date: row.invoice_date,
      invoice_status: row.invoice_status,
      invoice_currency_code: row.invoice_currency_code,
      invoice_total: row.invoice_total,
      invoice_outstanding_before_current: row.invoice_outstanding_before_current,
      allocated_amount: String(row.allocated_amount ?? 0),
    });
  }
  return Array.from(map.values()).sort((a, b) => String(a.purchase_invoice_number || "").localeCompare(String(b.purchase_invoice_number || "")));
}

function statusAppearance(status) {
  return getDeskStatusAppearance(status, {
    success: ["approved", "posted"],
    info: ["submitted"],
    warning: ["draft"],
    danger: ["cancelled"],
    fallbackTone: "#f6f7fb",
  });
}

function inputStyle(readOnly = false) {
  return {
    height: 38,
    padding: "0 10px",
    borderRadius: 10,
    border: "1px solid #d8dfeb",
    background: readOnly ? "#f7f9fc" : "#ffffff",
  };
}

function textAreaStyle(readOnly = false) {
  return {
    width: "100%",
    padding: 10,
    borderRadius: 12,
    border: "1px solid #d8dfeb",
    background: readOnly ? "#f7f9fc" : "#ffffff",
    resize: "vertical",
  };
}

function getApiErrorMessage(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function commandButtonStyle(active) {
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

export default function VendorPayments({ openVendorPaymentId, launch, onConsumeLaunch }) {
  const [view, setView] = useState({ type: "list" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [payments, setPayments] = useState([]);
  const [commandSummary, setCommandSummary] = useState(null);
  const [commandLoading, setCommandLoading] = useState(false);
  const [commandError, setCommandError] = useState("");
  const [commandRows, setCommandRows] = useState([]);
  const [commandQueueType, setCommandQueueType] = useState("invoice_groups");
  const [commandBucket, setCommandBucket] = useState("payment_run_ready");
  const [commandQuery, setCommandQuery] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [], finance_books: [], tds_sections: [] });
  const [createVendorId, setCreateVendorId] = useState("");
  const [creating, setCreating] = useState(false);

  const paymentStats = useMemo(() => {
    const total = payments.length;
    const draft = payments.filter((row) => String(row.payment_status || "").toLowerCase() === "draft").length;
    const submitted = payments.filter((row) => String(row.payment_status || "").toLowerCase() === "submitted").length;
    const posted = payments.filter((row) => ["approved", "posted"].includes(String(row.payment_status || "").toLowerCase())).length;
    return { total, draft, submitted, posted };
  }, [payments]);

  async function loadBootstrap() {
    const data = await apiFetch("/vendor-payments/bootstrap");
    setBootstrap({
      vendors: Array.isArray(data?.vendors) ? data.vendors : [],
      currencies: Array.isArray(data?.currencies) ? data.currencies : [],
        finance_books: Array.isArray(data?.finance_books) ? data.finance_books : [],
        tds_sections: Array.isArray(data?.tds_sections) ? data.tds_sections : [],
    });
  }

  async function loadList() {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/vendor-payments");
      setPayments(Array.isArray(data?.vendor_payments) ? data.vendor_payments : []);
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load vendor payments."));
    } finally {
      setLoading(false);
    }
  }

  async function loadCommandSummary() {
    try {
      const data = await apiFetch("/vendor-payments/command-summary");
      setCommandSummary(data?.summary || null);
    } catch (e) {
      setCommandSummary(null);
      setCommandError(getApiErrorMessage(e, "Failed to load payables command summary."));
    }
  }

  async function loadCommandQueue({ bucket = commandBucket, q = commandQuery } = {}) {
    setCommandLoading(true);
    setCommandError("");
    try {
      const params = new URLSearchParams();
      if (bucket) params.set("bucket", bucket);
      if (q) params.set("q", q);
      const query = params.toString();
      const data = await apiFetch(`/vendor-payments/command-queue${query ? `?${query}` : ""}`);
      setCommandRows(Array.isArray(data?.rows) ? data.rows : []);
      setCommandQueueType(typeof data?.queue_type === "string" ? data.queue_type : "invoice_groups");
    } catch (e) {
      setCommandRows([]);
      setCommandError(getApiErrorMessage(e, "Failed to load payables command queue."));
    } finally {
      setCommandLoading(false);
    }
  }

  useEffect(() => {
    if (view.type === "list") {
      loadBootstrap().catch(() => {});
      loadList();
      loadCommandSummary().catch(() => {});
      loadCommandQueue().catch(() => {});
    }
  }, [view.type]);

  useEffect(() => {
    if (view.type !== "list") return;
    loadCommandQueue({ bucket: commandBucket }).catch(() => {});
  }, [commandBucket]);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextCommandBucket = typeof launch.command_bucket === "string" ? launch.command_bucket : commandBucket;
    const nextCommandQuery = typeof launch.command_q === "string" ? launch.command_q : "";
    setCommandBucket(nextCommandBucket);
    setCommandQuery(nextCommandQuery);
    if (view.type !== "list") setView({ type: "list" });
    loadCommandSummary().catch(() => {});
    loadCommandQueue({ bucket: nextCommandBucket, q: nextCommandQuery }).catch(() => {});
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    const id = Number(openVendorPaymentId);
    if (!Number.isFinite(id) || id <= 0) return;
    setView({ type: "detail", id });
  }, [openVendorPaymentId]);

  async function createPayment(vendorIdInput = createVendorId, paymentCurrencyId = null) {
    const vendorId = Number(vendorIdInput);
    if (!Number.isFinite(vendorId) || vendorId <= 0) {
      setError("Select a vendor first.");
      return;
    }
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/vendor-payments", {
        method: "POST",
        body: JSON.stringify({
          vendor_id: vendorId,
          payment_currency_id: Number.isFinite(Number(paymentCurrencyId)) && Number(paymentCurrencyId) > 0 ? Number(paymentCurrencyId) : undefined,
        }),
      });
      const id = data?.vendor_payment?.id;
      if (id) setView({ type: "detail", id });
      setNotice("Vendor payment created.");
      loadCommandSummary().catch(() => {});
      loadCommandQueue().catch(() => {});
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to create vendor payment."));
    } finally {
      setCreating(false);
    }
  }

  // Keep queue mounted under the drawer so filters/buckets stay intact.
  const closeDetail = () => {
    setView({ type: "list" });
    loadList();
    loadCommandSummary().catch(() => {});
    loadCommandQueue().catch(() => {});
  };

  const detailPayment =
    view.type === "detail" ? payments.find((row) => Number(row.id) === Number(view.id)) : null;

  const heroStats = [
    { label: "Ready For Payment", value: commandSummary?.payment_run_ready_groups ?? paymentStats.total, tone: "#143d7a" },
    { label: "Overdue Buckets", value: commandSummary?.overdue_groups ?? paymentStats.draft, tone: "#8b5a00" },
    { label: "Match Blocked", value: commandSummary?.blocked_match_groups ?? paymentStats.submitted, tone: "#9f2042" },
    {
      label: "Submitted / Approved",
      value: commandSummary
        ? Number(commandSummary.submitted_payment_count || 0) + Number(commandSummary.approved_payment_count || 0)
        : paymentStats.posted,
      tone: "#0a7a35",
    },
  ];

  const commandCards = [
    {
      key: "payment_run_ready",
      label: "Ready for payment run",
      count: Number(commandSummary?.payment_run_ready_groups || 0),
      amount: Number(commandSummary?.payment_run_ready_amount || 0),
      tone: "#143d7a",
    },
    {
      key: "overdue",
      label: "Overdue vendor buckets",
      count: Number(commandSummary?.overdue_groups || 0),
      amount: Number(commandSummary?.overdue_amount || 0),
      tone: "#8b5a00",
    },
    {
      key: "blocked_match",
      label: "Blocked by 3-way match",
      count: Number(commandSummary?.blocked_match_groups || 0),
      amount: Number(commandSummary?.blocked_match_amount || 0),
      tone: "#9f2042",
    },
    {
      key: "submitted",
      label: "Submitted payments",
      count: Number(commandSummary?.submitted_payment_count || 0),
      amount: 0,
      tone: "#234a8f",
    },
    {
      key: "approved",
      label: "Approved not posted",
      count: Number(commandSummary?.approved_payment_count || 0),
      amount: 0,
      tone: "#0a7a35",
    },
    {
      key: "unallocated",
      label: "Unallocated active payments",
      count: Number(commandSummary?.unallocated_payment_count || 0),
      amount: Number(commandSummary?.unallocated_payment_amount || 0),
      tone: "#7b4ad8",
    },
  ];

  return (
    <>
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Vendor Settlement Desk"
        title="Vendor Payments"
        description="Run AP from one operating surface: spot overdue payable buckets, separate match blocks from payment-ready vendors, and then open the payment document without losing allocation context."
        actions={<button onClick={() => {
          loadList();
          loadCommandSummary().catch(() => {});
          loadCommandQueue().catch(() => {});
        }} disabled={loading || commandLoading}>{loading || commandLoading ? "Refreshing..." : "Refresh Queue"}</button>}
        stats={heroStats}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16 }}>
        <DeskCard title="Payables Command Desk" subtitle="Work the next AP decision from a bucketed queue before dropping into payment entry">
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {commandCards.map((card) => (
                <button
                  key={card.key}
                  onClick={() => setCommandBucket(card.key)}
                  style={commandButtonStyle(commandBucket === card.key)}
                >
                  <div style={{ fontSize: 12, opacity: 0.68 }}>{card.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: card.tone }}>{card.count}</div>
                  <div style={{ fontSize: 12, opacity: 0.72 }}>
                    {card.amount > 0 ? fmtMoney(card.amount) : "Open queue"}
                  </div>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={commandQuery}
                onChange={(e) => setCommandQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadCommandQueue({ q: commandQuery }).catch(() => {});
                }}
                placeholder="Search vendor or document"
                style={{ ...inputStyle(), minWidth: 260, flex: "1 1 260px" }}
              />
              <button onClick={() => loadCommandQueue({ q: commandQuery })} disabled={commandLoading}>
                {commandLoading ? "Refreshing..." : "Refresh Command Queue"}
              </button>
              <div style={{ fontSize: 12, color: "#58627a" }}>
                Total open AP: {fmtMoney(commandSummary?.total_outstanding_amount || 0)}
              </div>
            </div>

            <NoticeBanner tone="error" message={commandError} />

            {commandLoading ? (
              <div>Loading payables actions…</div>
            ) : commandRows.length ? (
              <div style={{ display: "grid", gap: 12 }}>
                {commandQueueType === "payments"
                  ? commandRows.map((item) => {
                      const appearance = statusAppearance(item.payment_status);
                      return (
                        <button
                          key={item.id}
                          onClick={() => setView({ type: "detail", id: item.id })}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            border: "1px solid #e7ebf3",
                            borderRadius: 18,
                            padding: 14,
                            background: "#ffffff",
                            boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                            <div>
                              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                                {fmtDate(item.payment_date)}
                              </div>
                              <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{item.payment_number}</div>
                            </div>
                            <DeskChip label={String(item.payment_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                          </div>
                          <div style={{ fontSize: 14, fontWeight: 700 }}>{item.vendor_name}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                            <MiniMetric label="Amount" value={fmtMoney(item.payment_amount, item.payment_currency_code)} />
                            <MiniMetric label="Allocated" value={fmtMoney(item.allocated_amount, item.payment_currency_code)} />
                            <MiniMetric label="Unallocated" value={fmtMoney(item.unallocated_amount, item.payment_currency_code)} />
                            <MiniMetric label="TDS" value={fmtMoney(item.tds_amount, item.payment_currency_code)} />
                          </div>
                        </button>
                      );
                    })
                  : commandRows.map((row) => {
                      const blocked = Number(row.blocked_match_amount || 0) > 0;
                      const activePayments = Number(row.active_payment_count || 0);
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
                              <DeskChip label={String(row.currency_code || "CUR").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                              {blocked ? <DeskChip label="MATCH BLOCKED" tone="#fff2f3" color="#9f2042" /> : null}
                              {activePayments ? <DeskChip label={`ACTIVE ${activePayments}`} tone="#f5f6fa" color="#5d6782" /> : null}
                            </div>
                          </div>

                          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
                            <MiniMetric label="Open Invoices" value={row.invoice_count} />
                            <MiniMetric label="Total AP" value={fmtMoney(row.total_outstanding_amount, row.currency_code)} />
                            <MiniMetric label="Overdue" value={fmtMoney(row.overdue_amount, row.currency_code)} />
                            <MiniMetric label="Ready" value={fmtMoney(row.ready_amount, row.currency_code)} />
                            <MiniMetric label="Blocked" value={fmtMoney(row.blocked_match_amount, row.currency_code)} />
                            <MiniMetric label="Oldest Age" value={`${Number(row.oldest_ageing_days || 0)}d`} />
                          </div>

                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                            <div style={{ fontSize: 12, color: "#58627a" }}>
                              Draft {row.draft_payment_count || 0} • Submitted {row.submitted_payment_count || 0} • Approved {row.approved_payment_count || 0}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button
                                onClick={() => createPayment(row.vendor_id, row.currency_id)}
                                disabled={creating || blocked || activePayments > 0}
                              >
                                {creating ? "Creating..." : "Start Draft Payment"}
                              </button>
                            </div>
                          </div>

                          {blocked ? (
                            <div style={{ padding: 12, borderRadius: 14, background: "#fff7f7", border: "1px solid #ffd8d8", fontSize: 12, color: "#8c2d3d" }}>
                              Resolve the linked 3-way mismatch before this vendor bucket moves into the payment run.
                            </div>
                          ) : activePayments > 0 ? (
                            <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, color: "#58627a" }}>
                              A draft, submitted, or approved payment already exists for this vendor and currency bucket.
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
              </div>
            ) : (
              <EmptyState
                title="No rows in this bucket"
                body="No rows in this payables bucket right now. Switch buckets or refresh the command queue."
              />
            )}
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Launch Vendor Payment" subtitle="Start a supplier payment desk from the vendor and handle allocations after entry">
          <div style={{ display: "grid", gap: 12 }}>
            <FieldLabel label="Vendor">
              <select value={createVendorId} onChange={(e) => setCreateVendorId(e.target.value)} style={inputStyle()}>
                <option value="">Select vendor</option>
                {bootstrap.vendors.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.company_name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <button onClick={() => createPayment()} disabled={creating}>{creating ? "Creating..." : "Create Vendor Payment"}</button>
            <div style={{ padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
              Use the command desk first when you need to decide who is ready, overdue, or blocked. Then open the payment document here for TDS, finance book, and allocation control.
            </div>
          </div>
        </DeskCard>

        <DeskCard title="Payment Queue" subtitle="Settlement cards keep TDS, net paid, and allocation posture visible">
          {loading ? (
            <div>Loading vendor payments…</div>
          ) : payments.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {payments.map((item) => {
                const appearance = statusAppearance(item.payment_status);
                return (
                  <button
                    key={item.id}
                    onClick={() => setView({ type: "detail", id: item.id })}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      border: "1px solid #e7ebf3",
                      borderRadius: 18,
                      padding: 14,
                      background: "#ffffff",
                      boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                      display: "grid",
                      gap: 10,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.58 }}>
                          {fmtDate(item.payment_date)}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>{item.payment_number}</div>
                      </div>
                      <DeskChip label={String(item.payment_status || "draft").toUpperCase()} tone={appearance.tone} color={appearance.color} />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{item.vendor_name}</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
                      <MiniMetric label="TDS" value={fmtMoney(item.tds_amount, item.payment_currency_code)} />
                      <MiniMetric label="Net Paid" value={fmtMoney(item.net_payment_amount, item.payment_currency_code)} />
                      <MiniMetric label="Allocated" value={fmtMoney(item.allocated_amount, item.payment_currency_code)} />
                      <MiniMetric label="Unallocated" value={fmtMoney(item.unallocated_amount, item.payment_currency_code)} />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No vendor payments yet"
              body="Start a draft from the payables command desk or launch a payment from the vendor picker."
            />
          )}
        </DeskCard>
      </div>
    </div>
    <SlideOverDrawer
      open={view.type === "detail"}
      onClose={closeDetail}
      eyebrow="Vendor Payment"
      title={
        view.type === "detail"
          ? detailPayment?.payment_number || `Payment #${view.id}`
          : "Vendor Payment"
      }
      subtitle={
        detailPayment?.vendor_name
          ? `${detailPayment.vendor_name} • Queue stays open behind this drawer`
          : "Queue stays open behind this drawer — close when you are done."
      }
      width={780}
    >
      {view.type === "detail" ? (
        <VendorPaymentDetail
          id={view.id}
          embedded
          onBack={closeDetail}
          onNotice={(msg) => setNotice(msg)}
        />
      ) : null}
    </SlideOverDrawer>
    </>
  );
}

function VendorPaymentDetail({ id, onBack, onNotice, embedded = false }) {
  const { busy, isBusy, runLocked } = useSubmitLock();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const saving = isBusy("save");
  const [approvalRemarks, setApprovalRemarks] = useState("");
  const [bootstrap, setBootstrap] = useState({ vendors: [], currencies: [], finance_books: [], tds_sections: [] });
  const [payment, setPayment] = useState(null);
  const [allocationRows, setAllocationRows] = useState([]);
  const [form, setForm] = useState({
    payment_status: "draft",
    payment_date: "",
    payment_amount: "0",
    finance_book_id: "",
    tds_section_id: "",
    tds_base_amount: "0",
    tds_rate: "0",
    tds_amount: "0",
    payment_mode: "",
    reference_no: "",
    bank_name: "",
    remarks: "",
  });

  useEffect(() => {
    setLoading(true);
    setError("");
    setNotice("");
    Promise.all([apiFetch("/vendor-payments/bootstrap"), apiFetch(`/vendor-payments/${id}`)])
      .then(([boot, data]) => {
        setBootstrap({
          vendors: Array.isArray(boot?.vendors) ? boot.vendors : [],
          currencies: Array.isArray(boot?.currencies) ? boot.currencies : [],
          finance_books: Array.isArray(boot?.finance_books) ? boot.finance_books : [],
          tds_sections: Array.isArray(boot?.tds_sections) ? boot.tds_sections : [],
        });
        const header = data?.vendor_payment || null;
        const allocations = Array.isArray(data?.allocations) ? data.allocations : [];
        const openInvoices = Array.isArray(data?.open_invoices) ? data.open_invoices : [];
        const rows = Array.isArray(data?.allocation_rows) ? data.allocation_rows : buildAllocationRows(openInvoices, allocations);
        setPayment(header);
        setAllocationRows(rows);
        setForm({
          payment_status: header?.payment_status || "draft",
          payment_date: header?.payment_date ? String(header.payment_date).slice(0, 10) : "",
          payment_amount: String(header?.payment_amount ?? 0),
          finance_book_id: header?.finance_book_id ? String(header.finance_book_id) : "",
          tds_section_id: header?.tds_section_id ? String(header.tds_section_id) : "",
          tds_base_amount: String(header?.tds_base_amount ?? 0),
          tds_rate: String(header?.tds_rate ?? 0),
          tds_amount: String(header?.tds_amount ?? 0),
          payment_mode: header?.payment_mode || "",
          reference_no: header?.reference_no || "",
          bank_name: header?.bank_name || "",
          remarks: header?.remarks || "",
        });
      })
      .catch((e) => setError(e?.data?.error || "Failed to load vendor payment."))
      .finally(() => setLoading(false));
  }, [id]);

  const allocatedPreview = useMemo(() => {
    return allocationRows.reduce((sum, row) => sum + Number(row.allocated_amount || 0), 0);
  }, [allocationRows]);

  const unallocatedPreview = useMemo(() => {
    const amt = Number(form.payment_amount || 0);
    return amt - allocatedPreview;
  }, [form.payment_amount, allocatedPreview]);

  const netPaymentPreview = useMemo(() => {
    return Number(form.payment_amount || 0) - Number(form.tds_amount || 0);
  }, [form.payment_amount, form.tds_amount]);

  const tdsAmountPreview = useMemo(() => {
    return (Number(form.tds_base_amount || 0) * Number(form.tds_rate || 0)) / 100;
  }, [form.tds_base_amount, form.tds_rate]);
  const statusMeta = statusAppearance(form.payment_status);

  function updateRow(invoiceId, nextValue) {
    setAllocationRows((prev) =>
      prev.map((row) =>
        Number(row.purchase_invoice_id) === Number(invoiceId) ? { ...row, allocated_amount: nextValue } : row
      )
    );
  }

  async function save() {
    if (!payment) return;
    await runLocked("save", async () => {
      setError("");
      setNotice("");
      try {
        const payload = {
          vendor_id: payment.vendor_id,
          payment_currency_id: payment.payment_currency_id,
          payment_status: form.payment_status,
          payment_date: form.payment_date || undefined,
          payment_amount: Number(form.payment_amount || 0),
          finance_book_id: form.finance_book_id ? Number(form.finance_book_id) : null,
          tds_section_id: form.tds_section_id ? Number(form.tds_section_id) : null,
          tds_base_amount: Number(form.tds_base_amount || 0),
          tds_rate: Number(form.tds_rate || 0),
          payment_mode: form.payment_mode || null,
          reference_no: form.reference_no || null,
          bank_name: form.bank_name || null,
          remarks: form.remarks || null,
          approval_remarks: approvalRemarks || null,
          allocation_rows: allocationRows.map((row) => ({
            purchase_invoice_id: row.purchase_invoice_id,
            allocated_amount: Number(row.allocated_amount || 0),
          })),
        };
        const data = await apiFetch(`/vendor-payments/${payment.id}`, { method: "PUT", body: JSON.stringify(payload) });
        const header = data?.vendor_payment || payment;
        setPayment(header);
        const allocations = Array.isArray(data?.allocations) ? data.allocations : [];
        const openInvoices = Array.isArray(data?.open_invoices) ? data.open_invoices : [];
        setAllocationRows(Array.isArray(data?.allocation_rows) ? data.allocation_rows : buildAllocationRows(openInvoices, allocations));
        setForm((prev) => ({
          ...prev,
          payment_status: header?.payment_status || prev.payment_status,
          payment_date: header?.payment_date ? String(header.payment_date).slice(0, 10) : prev.payment_date,
          payment_amount: String(header?.payment_amount ?? prev.payment_amount),
          finance_book_id: header?.finance_book_id ? String(header.finance_book_id) : prev.finance_book_id,
          tds_section_id: header?.tds_section_id ? String(header.tds_section_id) : prev.tds_section_id,
          tds_base_amount: String(header?.tds_base_amount ?? prev.tds_base_amount),
          tds_rate: String(header?.tds_rate ?? prev.tds_rate),
          tds_amount: String(header?.tds_amount ?? prev.tds_amount),
        }));
        const msg = "Vendor payment saved.";
        setNotice(msg);
        toast(msg, "success");
        onNotice?.(msg);
        setApprovalRemarks("");
      } catch (e) {
        const code = e?.data?.error;
        let message = code || "Failed to save vendor payment.";
        if (code === "PAYMENT_NOT_EDITABLE") message = "Only draft payments can be edited.";
        else if (code === "ALLOCATION_EXCEEDS_PAYMENT") message = "Allocated amount exceeds payment amount.";
        else if (code === "ALLOCATION_EXCEEDS_OUTSTANDING") message = "An allocation exceeds invoice outstanding.";
        setError(message);
        toast(message, "error");
      }
    });
  }

  if (loading) return <div>Loading vendor payment…</div>;

  if (!payment) {
    return (
      <div>
        <button onClick={onBack}>Back</button>
        <div style={{ color: "#b00020", marginTop: 12 }}>{error || "Vendor payment not found."}</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow={embedded ? "Drawer detail" : "Vendor Payment Desk"}
        title={payment.payment_number}
        description={`${payment.vendor_name || "Vendor pending"} • ${payment.payment_status || "draft"} • Control amount, TDS, and invoice settlement from one desk.`}
        actions={
          <>
            {!embedded ? <button onClick={onBack}>Back</button> : null}
            <button onClick={() => setHistoryOpen(true)}>History / Remarks</button>
            <button onClick={save} disabled={busy}>{saving ? "Saving..." : "Save"}</button>
          </>
        }
        stats={[
          { label: "Status", value: String(form.payment_status || "draft").toUpperCase(), tone: statusMeta.color },
          { label: "Payment Amount", value: fmtMoney(form.payment_amount, payment.payment_currency_code), tone: "#143d7a" },
          { label: "TDS", value: fmtMoney(tdsAmountPreview, payment.payment_currency_code), tone: "#234a8f" },
          { label: "Net Paid", value: fmtMoney(Number(form.payment_amount || 0) - tdsAmountPreview, payment.payment_currency_code), tone: "#0a7a35" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(320px, 0.8fr)", gap: 16, alignItems: "start" }}>
        <DeskCard
          title="Payment Snapshot"
          subtitle="Payment, bank book, and TDS controls stay visible without crowding the operator"
          actions={<DeskChip label={String(form.payment_status || "draft").toUpperCase()} tone={statusMeta.tone} color={statusMeta.color} />}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <FieldLabel label="Status">
              <select value={form.payment_status} onChange={(e) => setForm((p) => ({ ...p, payment_status: e.target.value }))} style={inputStyle()}>
                <option value="draft">Draft</option>
                <option value="submitted">Submitted</option>
                <option value="approved">Approved</option>
                <option value="posted">Posted</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </FieldLabel>
            <FieldLabel label="Date">
              <input type="date" value={form.payment_date} onChange={(e) => setForm((p) => ({ ...p, payment_date: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label={`Amount (${payment.payment_currency_code || ""})`}>
              <input value={form.payment_amount} onChange={(e) => setForm((p) => ({ ...p, payment_amount: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Bank / Cash Book">
              <select value={form.finance_book_id} onChange={(e) => setForm((p) => ({ ...p, finance_book_id: e.target.value }))} style={inputStyle()}>
                <option value="">-- None --</option>
                {bootstrap.finance_books.map((book) => (
                  <option key={book.id} value={String(book.id)}>
                    {book.book_name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="TDS Section">
              <select value={form.tds_section_id} onChange={(e) => setForm((p) => ({ ...p, tds_section_id: e.target.value }))} style={inputStyle()}>
                <option value="">-- None --</option>
                {bootstrap.tds_sections.map((section) => (
                  <option key={section.id} value={String(section.id)}>
                    {section.section_code}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="TDS Base">
              <input value={form.tds_base_amount} onChange={(e) => setForm((p) => ({ ...p, tds_base_amount: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="TDS Rate %">
              <input value={form.tds_rate} onChange={(e) => setForm((p) => ({ ...p, tds_rate: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="TDS Amount">
              <input value={String(tdsAmountPreview.toFixed(2))} readOnly style={inputStyle(true)} />
            </FieldLabel>
            <FieldLabel label="Mode">
              <input value={form.payment_mode} onChange={(e) => setForm((p) => ({ ...p, payment_mode: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Reference No">
              <input value={form.reference_no} onChange={(e) => setForm((p) => ({ ...p, reference_no: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
            <FieldLabel label="Bank">
              <input value={form.bank_name} onChange={(e) => setForm((p) => ({ ...p, bank_name: e.target.value }))} style={inputStyle()} />
            </FieldLabel>
          </div>
          <FieldLabel label="Remarks" style={{ marginTop: 12 }}>
            <textarea value={form.remarks} onChange={(e) => setForm((p) => ({ ...p, remarks: e.target.value }))} rows={4} style={textAreaStyle()} />
          </FieldLabel>
        </DeskCard>

        <DeskCard title="Settlement Preview" subtitle="Preview the effect before the payment is posted">
          <div style={{ display: "grid", gap: 10 }}>
            <MiniMetric label="Allocated" value={fmtMoney(allocatedPreview, payment.payment_currency_code)} />
            <MiniMetric label="Unallocated" value={fmtMoney(unallocatedPreview, payment.payment_currency_code)} />
            <MiniMetric label="TDS" value={fmtMoney(tdsAmountPreview, payment.payment_currency_code)} />
            <MiniMetric label="Net Paid" value={fmtMoney(Number(form.payment_amount || 0) - tdsAmountPreview, payment.payment_currency_code)} />
          </div>
          <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: "#f8faff", border: "1px solid #e3ebfa", fontSize: 12, lineHeight: 1.7, color: "#58627a" }}>
            Only posted payments reduce vendor outstanding.
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="Allocate To Purchase Invoices"
          subtitle="Card allocations preserve invoice context and reduce horizontal overflow"
          actions={<DeskChip label={(payment.payment_status || "draft") === "draft" ? "DRAFT ALLOCATION" : "LOCKED"} tone={(payment.payment_status || "draft") === "draft" ? "#eef4ff" : "#f5f6fa"} color={(payment.payment_status || "draft") === "draft" ? "#234a8f" : "#5d6782"} />}
        >
          {allocationRows.length ? (
            <div style={{ display: "grid", gap: 12 }}>
              {allocationRows.map((row) => (
                <div key={row.purchase_invoice_id} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#fcfdff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div style={{ fontWeight: 700 }}>{row.purchase_invoice_number}</div>
                    <DeskChip label={String(row.invoice_status || "open").toUpperCase()} tone="#eef4ff" color="#234a8f" />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                    <MiniMetric label="Date" value={fmtDate(row.invoice_date)} />
                    <MiniMetric label="Total" value={fmtMoney(row.invoice_total, row.invoice_currency_code)} />
                    <MiniMetric label="Outstanding" value={fmtMoney(row.invoice_outstanding_before_current, row.invoice_currency_code)} />
                  </div>
                  <FieldLabel label="Allocate" style={{ marginTop: 12 }}>
                    <input
                      value={row.allocated_amount}
                      onChange={(e) => updateRow(row.purchase_invoice_id, e.target.value)}
                      style={inputStyle((payment.payment_status || "draft") !== "draft")}
                      disabled={(payment.payment_status || "draft") !== "draft"}
                    />
                  </FieldLabel>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No invoices for allocation"
              body="No open purchase invoices are available to allocate against this payment."
            />
          )}
        </DeskCard>
      </div>
      <ApprovalHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docType="vendor_payment"
        docId={id}
        remarks={approvalRemarks}
        onRemarksChange={setApprovalRemarks}
      />
    </div>
  );
}
