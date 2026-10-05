import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, MiniMetric, NoticeBanner, PageHero, FieldLabel, getDeskStatusAppearance } from "../shared/joshUi";

async function apiFetch(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || "Request failed");
    err.data = data;
    throw err;
  }
  return data;
}

function money(n) {
  const value = Number(n || 0);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function fmtMoney(amount, currencyCode) {
  const n = Number(amount || 0);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: currencyCode || "INR" }).format(safe);
  } catch {
    return safe.toFixed(2);
  }
}

function fmtDate(value) {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
}

function toneForStatus(status) {
  const a = getDeskStatusAppearance(status, {
    success: ["approved", "issued", "sent", "converted", "closed"],
    info: ["submitted", "pending", "pending_approval"],
    warning: ["draft"],
    danger: ["cancelled", "rejected"],
    fallbackTone: "#f6f7fb",
  });
  return a;
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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(dateText, deltaDays) {
  const base = dateText ? new Date(`${dateText}T00:00:00`) : new Date();
  base.setDate(base.getDate() + deltaDays);
  return base.toISOString().slice(0, 10);
}

function currentFinancialYearRange() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const start = new Date(Date.UTC(year, 3, 1));
  const end = new Date(Date.UTC(year + 1, 2, 31));
  return {
    date_from: start.toISOString().slice(0, 10),
    date_to: end.toISOString().slice(0, 10),
  };
}

function getPresetRange(preset) {
  const today = todayIso();
  if (preset === "last_90_days") return { date_from: shiftDays(today, -89), date_to: today };
  if (preset === "current_fy") return currentFinancialYearRange();
  return { date_from: "", date_to: "" };
}

export default function QuoteReport({ onBack }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bootstrap, setBootstrap] = useState({ statuses: [], customers: [], users: [] });

  const [tab, setTab] = useState("quotation_value");
  const [winLoss, setWinLoss] = useState({ by_reason: [], by_owner: [], by_product: [] });
  const [filters, setFilters] = useState({
    date_from: "",
    date_to: "",
    status: "",
    customer_id: "",
    created_by: "",
  });
  const [preset, setPreset] = useState("all_time");

  const [report, setReport] = useState({ totals: { quote_count: 0, total_amount_quote: 0 }, register: [], groups: [], products: [], funnel: [] });
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [groupDetail, setGroupDetail] = useState({ loading: false, error: "", quotes: [], items: [] });
  const [showGroupItems, setShowGroupItems] = useState(true);

  const registerCurrency = useMemo(() => {
    const codes = new Map();
    report.register.forEach((row) => {
      const key = String(row.currency_code || "").trim();
      if (!key) return;
      codes.set(key, (codes.get(key) || 0) + 1);
    });
    const sorted = Array.from(codes.entries()).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || "INR";
  }, [report.register]);

  const funnelTotal = useMemo(() => report.funnel.reduce((sum, row) => sum + Number(row.lead_count || 0), 0), [report.funnel]);

  async function loadBootstrap() {
    setError("");
    try {
      const data = await apiFetch("/quotes/report/bootstrap");
      setBootstrap({
        statuses: Array.isArray(data?.statuses) ? data.statuses : [],
        customers: Array.isArray(data?.customers) ? data.customers : [],
        users: Array.isArray(data?.users) ? data.users : [],
      });
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to load report filters.");
    }
  }

  function buildQuery(extra = {}) {
    const qp = new URLSearchParams();
    const merged = { ...filters, ...extra };
    Object.entries(merged).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      const text = String(value).trim();
      if (!text) return;
      qp.set(key, text);
    });
    const qs = qp.toString();
    return qs ? `?${qs}` : "";
  }

  async function loadReport() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const [data, winLossData] = await Promise.all([
        apiFetch(`/quotes/report${buildQuery()}`),
        apiFetch(`/quotes/report/win-loss${buildQuery()}`).catch(() => null),
      ]);
      setReport({
        totals: data?.totals || { quote_count: 0, total_amount_quote: 0 },
        register: Array.isArray(data?.register) ? data.register : [],
        groups: Array.isArray(data?.groups) ? data.groups : [],
        products: Array.isArray(data?.products) ? data.products : [],
        funnel: Array.isArray(data?.funnel) ? data.funnel : [],
      });
      setWinLoss({
        by_reason: Array.isArray(winLossData?.by_reason) ? winLossData.by_reason : [],
        by_owner: Array.isArray(winLossData?.by_owner) ? winLossData.by_owner : [],
        by_product: Array.isArray(winLossData?.by_product) ? winLossData.by_product : [],
      });
      setExpandedGroupId(null);
      setGroupDetail({ loading: false, error: "", quotes: [], items: [] });
      setNotice("Report refreshed.");
    } catch (e) {
      setError(e?.data?.error === "DISTRIBUTOR_NOT_LINKED" ? "Distributor is not linked." : "Failed to load quote report.");
    } finally {
      setLoading(false);
    }
  }

  async function loadGroupDetail(nextGroupId) {
    const groupId = nextGroupId === null ? "" : nextGroupId === undefined ? "" : nextGroupId;
    setGroupDetail({ loading: true, error: "", quotes: [], items: [] });
    try {
      const data = await apiFetch(`/quotes/report/group-detail${buildQuery({ group_id: groupId === null ? "" : String(groupId) })}`);
      setGroupDetail({
        loading: false,
        error: "",
        quotes: Array.isArray(data?.quotes) ? data.quotes : [],
        items: Array.isArray(data?.items) ? data.items : [],
      });
    } catch (e) {
      setGroupDetail({
        loading: false,
        error: e?.data?.error || "Failed to load group detail.",
        quotes: [],
        items: [],
      });
    }
  }

  function applyPreset(nextPreset) {
    const nextRange = getPresetRange(nextPreset);
    setPreset(nextPreset);
    setFilters((prev) => ({
      ...prev,
      date_from: nextRange.date_from,
      date_to: nextRange.date_to,
    }));
  }

  useEffect(() => {
    loadBootstrap();
    loadReport();
  }, []);

  const topGroups = useMemo(() => report.groups.slice(0, 60), [report.groups]);
  const topProducts = useMemo(() => report.products.slice(0, 80), [report.products]);
  const topRegister = useMemo(() => report.register.slice(0, 150), [report.register]);

  return (
    <div style={{ maxWidth: 1560 }}>
      <PageHero
        eyebrow="Commercial Analytics"
        title="Quote Report"
        description="In-app analysis only. Use group summaries, expand into quote-level lists, and drill all the way down into item lines without exporting CSV/Excel."
        actions={
          <>
            <button onClick={onBack}>Back</button>
            <button onClick={loadReport} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
          </>
        }
        stats={[
          { label: "Quotes In Range", value: report.totals.quote_count, tone: "#143d7a" },
          { label: "Quote Value", value: fmtMoney(report.totals.total_amount_quote, registerCurrency), tone: "#234a8f" },
          { label: "Lead Funnel (Count)", value: funnelTotal, tone: "#0a7a35" },
          { label: "Top Groups", value: report.groups.length, tone: "#8b5a00" },
        ]}
      />

      <NoticeBanner tone="error" message={error} />
      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 430px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Filters" subtitle="Company filter is taken from your active company context (AI/AT)">
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => applyPreset("all_time")} style={{ opacity: preset === "all_time" ? 1 : 0.72 }}>
                All Time
              </button>
              <button type="button" onClick={() => applyPreset("last_90_days")} style={{ opacity: preset === "last_90_days" ? 1 : 0.72 }}>
                Last 90 Days
              </button>
              <button type="button" onClick={() => applyPreset("current_fy")} style={{ opacity: preset === "current_fy" ? 1 : 0.72 }}>
                Current FY
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FieldLabel label="Date From">
                <input
                  type="date"
                  value={filters.date_from}
                  onChange={(e) => {
                    setPreset("custom");
                    setFilters((p) => ({ ...p, date_from: e.target.value }));
                  }}
                  style={inputStyle()}
                />
              </FieldLabel>
              <FieldLabel label="Date To">
                <input
                  type="date"
                  value={filters.date_to}
                  onChange={(e) => {
                    setPreset("custom");
                    setFilters((p) => ({ ...p, date_to: e.target.value }));
                  }}
                  style={inputStyle()}
                />
              </FieldLabel>
            </div>

            <div style={{ fontSize: 12, opacity: 0.72, lineHeight: 1.6 }}>
              Blank dates mean all-time reporting. Quote filtering now uses the commercial quote timing (`issued / prepared / created`) instead of only record creation time.
            </div>

            <FieldLabel label="Quote Status">
              <select value={filters.status} onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))} style={inputStyle()}>
                <option value="">All statuses</option>
                {bootstrap.statuses.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel label="Customer">
              <select value={filters.customer_id} onChange={(e) => setFilters((p) => ({ ...p, customer_id: e.target.value }))} style={inputStyle()}>
                <option value="">All customers</option>
                {bootstrap.customers.map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.customer_name}</option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel label="Salesperson / Created By">
              <select value={filters.created_by} onChange={(e) => setFilters((p) => ({ ...p, created_by: e.target.value }))} style={inputStyle()}>
                <option value="">All users</option>
                {bootstrap.users.map((u) => (
                  <option key={u.id} value={String(u.id)}>{u.full_name}</option>
                ))}
              </select>
            </FieldLabel>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={loadReport} disabled={loading}>{loading ? "Applying..." : "Apply Filters"}</button>
              <button
                onClick={() => {
                  setPreset("all_time");
                  setFilters({ date_from: "", date_to: "", status: "", customer_id: "", created_by: "" });
                  setNotice("");
                }}
                disabled={loading}
              >
                Reset
              </button>
            </div>
          </div>
        </DeskCard>

        <DeskCard
          title="Dash Tabs"
          subtitle="All-in-one view. Each tab keeps drill-down inside the screen."
          actions={<DeskChip label="NO CSV / EXCEL" tone="#f5f6fa" color="#5d6782" />}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => setTab("quotation_value")} style={{ opacity: tab === "quotation_value" ? 1 : 0.72 }}>
              Quotation Value
            </button>
            <button onClick={() => setTab("product_demand")} style={{ opacity: tab === "product_demand" ? 1 : 0.72 }}>
              Product Demand
            </button>
            <button onClick={() => setTab("funnel")} style={{ opacity: tab === "funnel" ? 1 : 0.72 }}>
              Funnel
            </button>
            <button onClick={() => setTab("win_loss")} style={{ opacity: tab === "win_loss" ? 1 : 0.72 }}>
              Win / Loss
            </button>
          </div>

          {tab === "quotation_value" ? (
            <div style={{ marginTop: 14, display: "grid", gap: 16 }}>
              <DeskCard title="Group Summary" subtitle="Click a group to expand into quote list + item lines">
                <div style={{ display: "grid", gap: 10, maxHeight: 520, overflowY: "auto", paddingRight: 4 }}>
                  {topGroups.length ? (
                    topGroups.map((g) => {
                      const gid = g.group_id === null ? 0 : Number(g.group_id);
                      const isExpanded = expandedGroupId === gid;
                      const tone = isExpanded ? "#eef4ff" : "#f6f7fb";
                      return (
                        <button
                          key={`${g.group_id || "ungrouped"}`}
                          onClick={async () => {
                            if (isExpanded) {
                              setExpandedGroupId(null);
                              setGroupDetail({ loading: false, error: "", quotes: [], items: [] });
                              return;
                            }
                            setExpandedGroupId(gid);
                            await loadGroupDetail(gid);
                          }}
                          style={{
                            all: "unset",
                            cursor: "pointer",
                            border: "1px solid #e7ebf3",
                            borderRadius: 16,
                            padding: 12,
                            background: "#ffffff",
                            boxShadow: "0 6px 18px rgba(26, 35, 53, 0.04)",
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                            <div style={{ fontWeight: 800 }}>{g.group_name}</div>
                            <DeskChip label={isExpanded ? "EXPANDED" : "GROUP"} tone={tone} color="#234a8f" />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                            <MiniMetric label="Quotes" value={Number(g.quote_count || 0)} />
                            <MiniMetric label="Qty" value={money(g.total_qty)} />
                            <MiniMetric label="Value" value={fmtMoney(g.total_amount_quote, registerCurrency)} />
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                      No grouped lines found for the selected range.
                    </div>
                  )}
                </div>
              </DeskCard>

              {expandedGroupId !== null ? (
                <DeskCard
                  title="Expanded Group"
                  subtitle="Both views are available: quote-level list and item-wise detail"
                  actions={
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <button type="button" onClick={() => setShowGroupItems((p) => !p)}>
                        {showGroupItems ? "Hide Item Lines" : "Show Item Lines"}
                      </button>
                      <DeskChip label={`GROUP ID ${expandedGroupId || 0}`} tone="#f6f7fb" color="#58627a" />
                    </div>
                  }
                >
                  <NoticeBanner tone="error" message={groupDetail.error} />
                  {groupDetail.loading ? (
                    <div>Loading group detail…</div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: showGroupItems ? "minmax(0, 0.9fr) minmax(0, 1.1fr)" : "minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
                      <div style={{ display: "grid", gap: 10 }}>
                        <div style={{ fontWeight: 800 }}>Quotes Under This Group</div>
                        <div style={{ display: "grid", gap: 10, maxHeight: 520, overflowY: "auto", paddingRight: 4 }}>
                          {groupDetail.quotes.length ? (
                            groupDetail.quotes.map((q) => {
                              const meta = toneForStatus(q.quote_status);
                              return (
                                <div key={q.id} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#fcfdff" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                                    <div>
                                      <div style={{ fontWeight: 800 }}>{q.quote_number}</div>
                                      <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>{q.customer_name}</div>
                                    </div>
                                    <DeskChip label={String(q.quote_status || "draft").toUpperCase()} tone={meta.tone} color={meta.color} />
                                  </div>
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 10 }}>
                                    <MiniMetric label="Date" value={fmtDate(q.created_at)} />
                                    <MiniMetric label="Created By" value={q.created_by_name || "—"} />
                                    <MiniMetric label="Total" value={fmtMoney(q.grand_total_quote, q.currency_code || registerCurrency)} />
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                              No quotes found for this group under the current filters.
                            </div>
                          )}
                        </div>
                      </div>

                      {showGroupItems ? (
                        <div style={{ display: "grid", gap: 10 }}>
                          <div style={{ fontWeight: 800 }}>Item Lines Under This Group</div>
                          <div style={{ display: "grid", gap: 10, maxHeight: 520, overflowY: "auto", paddingRight: 4 }}>
                            {groupDetail.items.length ? (
                              groupDetail.items.map((row, idx) => (
                                <div key={`${row.quote_id}-${row.line_no}-${idx}`} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#ffffff" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                                    <div>
                                      <div style={{ fontWeight: 800 }}>{row.item_name}</div>
                                      <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>
                                        {row.item_code || "—"} • Quote {row.quote_number} • {row.customer_name}
                                      </div>
                                    </div>
                                    <DeskChip label={fmtMoney(row.line_total_quote, registerCurrency)} tone="#eef4ff" color="#234a8f" />
                                  </div>
                                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: 10 }}>
                                    <MiniMetric label="Qty" value={money(row.qty)} />
                                    <MiniMetric label="Unit Price" value={fmtMoney(row.unit_price_quote, registerCurrency)} />
                                    <MiniMetric label="GST %" value={money(row.gst_pct)} />
                                    <MiniMetric label="Line Total" value={fmtMoney(row.line_total_quote, registerCurrency)} />
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                                No item lines found for this group under the current filters.
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                </DeskCard>
              ) : null}

              <DeskCard title="Quote Register" subtitle="Quick list of quotes (open quote from the Quotes queue when needed)">
                <div style={{ display: "grid", gap: 10, maxHeight: 520, overflowY: "auto", paddingRight: 4 }}>
                  {topRegister.length ? (
                    topRegister.map((q) => {
                      const meta = toneForStatus(q.quote_status);
                      return (
                        <div key={q.id} style={{ border: "1px solid #e7ebf3", borderRadius: 16, padding: 12, background: "#ffffff" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                            <div>
                              <div style={{ fontWeight: 800 }}>{q.quote_number}</div>
                              <div style={{ fontSize: 13, opacity: 0.72, marginTop: 4 }}>{q.customer_name}</div>
                            </div>
                            <DeskChip label={String(q.quote_status || "draft").toUpperCase()} tone={meta.tone} color={meta.color} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10, marginTop: 10 }}>
                            <MiniMetric label="Date" value={fmtDate(q.created_at)} />
                            <MiniMetric label="Company" value={q.company_code || "—"} />
                            <MiniMetric label="Salesperson" value={q.created_by_name || "—"} />
                            <MiniMetric label="Grand Total" value={fmtMoney(q.grand_total_quote, q.currency_code || registerCurrency)} />
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                      No quotes match the filters.
                    </div>
                  )}
                </div>
              </DeskCard>
            </div>
          ) : null}

          {tab === "product_demand" ? (
            <div style={{ marginTop: 14, display: "grid", gap: 16 }}>
              <DeskCard title="Top Item Demand" subtitle="Item-wise demand derived from quote lines (no exports)">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
                  {topProducts.length ? (
                    topProducts.map((row) => (
                      <div key={`${row.product_id || row.item_code}-${row.group_id || "g"}`} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                          <div>
                            <div style={{ fontWeight: 800 }}>{row.item_name}</div>
                            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>{row.item_code || "—"} • {row.group_name}</div>
                          </div>
                          <DeskChip label={fmtMoney(row.total_amount_quote, registerCurrency)} tone="#eef4ff" color="#234a8f" />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 12 }}>
                          <MiniMetric label="Quotes" value={Number(row.quote_count || 0)} />
                          <MiniMetric label="Qty" value={money(row.total_qty)} />
                          <MiniMetric label="Value" value={fmtMoney(row.total_amount_quote, registerCurrency)} />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                      No quote lines match the filters.
                    </div>
                  )}
                </div>
              </DeskCard>
            </div>
          ) : null}

          {tab === "funnel" ? (
            <div style={{ marginTop: 14, display: "grid", gap: 16 }}>
              <DeskCard title="Lead Funnel Snapshot" subtitle="Lead status counts within the selected date range (based on legacy_created_at/created_at)">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                  {report.funnel.length ? (
                    report.funnel.map((row) => (
                      <div key={row.status} style={{ border: "1px solid #e7ebf3", borderRadius: 18, padding: 14, background: "#ffffff" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                          <div style={{ fontWeight: 800 }}>{String(row.status || "unknown").toUpperCase()}</div>
                          <DeskChip label={String(row.lead_count || 0)} tone="#f6f7fb" color="#58627a" />
                        </div>
                        <div style={{ marginTop: 12 }}>
                          <MiniMetric label="Leads" value={Number(row.lead_count || 0)} />
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ padding: 18, borderRadius: 16, background: "#fafbff", border: "1px dashed #d5dcec", opacity: 0.76 }}>
                      No lead rows found in this range.
                    </div>
                  )}
                </div>
              </DeskCard>
            </div>
          ) : null}

          {tab === "win_loss" ? (
            <div style={{ marginTop: 14, display: "grid", gap: 16 }}>
              <DeskCard title="By closure reason" subtitle="Closed quotes grouped by master loss reason">
                <div style={{ display: "grid", gap: 8 }}>
                  {winLoss.by_reason.length ? (
                    winLoss.by_reason.map((row) => (
                      <div key={row.reason_code} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 12, background: "#fff" }}>
                        <div style={{ fontWeight: 800 }}>{row.reason_name}</div>
                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                          {Number(row.quote_count || 0)} quotes · {fmtMoney(row.total_amount_quote, registerCurrency)}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ opacity: 0.7 }}>No closed quotes in this range.</div>
                  )}
                </div>
              </DeskCard>
              <DeskCard title="By owner" subtitle="Converted vs closed by quote creator">
                <div style={{ display: "grid", gap: 8 }}>
                  {winLoss.by_owner.length ? (
                    winLoss.by_owner.map((row) => (
                      <div key={`${row.owner_user_id || "none"}-${row.owner_name}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 12, background: "#fff" }}>
                        <div style={{ fontWeight: 800 }}>{row.owner_name}</div>
                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                          Won {Number(row.won_count || 0)} ({fmtMoney(row.won_amount, registerCurrency)}) · Lost {Number(row.lost_count || 0)} ({fmtMoney(row.lost_amount, registerCurrency)})
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ opacity: 0.7 }}>No win/loss owner rows.</div>
                  )}
                </div>
              </DeskCard>
              <DeskCard title="By product" subtitle="Line-level win/loss pressure">
                <div style={{ display: "grid", gap: 8, maxHeight: 420, overflowY: "auto" }}>
                  {winLoss.by_product.length ? (
                    winLoss.by_product.map((row) => (
                      <div key={`${row.product_id}-${row.item_code}`} style={{ border: "1px solid #e7ebf3", borderRadius: 14, padding: 12, background: "#fff" }}>
                        <div style={{ fontWeight: 800 }}>{row.item_name}</div>
                        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                          {row.item_code} · Won {Number(row.won_count || 0)} · Lost {Number(row.lost_count || 0)}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ opacity: 0.7 }}>No product win/loss rows.</div>
                  )}
                </div>
              </DeskCard>
            </div>
          ) : null}
        </DeskCard>
      </div>
    </div>
  );
}
