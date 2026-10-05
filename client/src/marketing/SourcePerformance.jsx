import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function ratio(numerator, denominator) {
  const den = Number(denominator || 0);
  if (den <= 0) return "0%";
  return `${Math.round((Number(numerator || 0) / den) * 100)}%`;
}

function typeTone(type) {
  return type === "exhibition"
    ? { tone: "#fff6e8", color: "#8b5a00" }
    : { tone: "#eef4ff", color: "#234a8f" };
}

export default function SourcePerformance({ onNavigate = null } = {}) {
  const [rows, setRows] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/marketing/source-performance");
        if (!active) return;
        setRows(Array.isArray(data?.rows) ? data.rows : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load source performance right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(() => {
    const leadCount = rows.reduce((sum, item) => sum + Number(item.lead_count || 0), 0);
    const fruitful = rows.reduce((sum, item) => sum + Number(item.fruitful_leads || 0), 0);
    const quoteValue = rows.reduce((sum, item) => sum + Number(item.quote_value || 0), 0);
    const orderValue = rows.reduce((sum, item) => sum + Number(item.order_value || 0), 0);
    return [
      { label: "Lead volume", value: String(leadCount), tone: "#234a8f" },
      { label: "Fruitful yield", value: ratio(fruitful, leadCount), tone: "#0b7d45" },
      { label: "Quote value", value: `INR ${money(quoteValue)}`, tone: "#7c3aed" },
      { label: "Order value", value: `INR ${money(orderValue)}`, tone: "#8b5a00" },
    ];
  }, [rows]);

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Yield Analysis"
        title="Source Performance"
        description="Compare campaigns and exhibitions by lead count, fruitful movement, quote value, and order value so the next Marketing decision is based on business yield."
        stats={stats}
      />

      <NoticeBanner tone="info" message={notice} />

      <DeskCard title="Source Yield Table" subtitle="Compare lead volume, quote movement, order value, and cost efficiency" actions={loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading...</div> : null}>
        <div style={{ display: "grid", gap: 12, marginTop: 4 }}>
          {rows.map((item) => {
            const tone = typeTone(item.source_type);
            return (
              <div key={`${item.source_type}-${item.id}`} style={{ border: "1px solid #e6ebf2", borderRadius: 18, padding: 14, background: "#fff", display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>{item.source_name}</div>
                    <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                      {[item.channel_or_city, item.status ? String(item.status).replace(/_/g, " ") : null].filter(Boolean).join(" • ")}
                    </div>
                  </div>
                  <DeskChip label={item.source_type} tone={tone.tone} color={tone.color} />
                </div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {`Leads ${item.lead_count} • Fruitful ${item.fruitful_leads} (${ratio(item.fruitful_leads, item.lead_count)}) • Customers ${item.customer_count} • Quotes ${item.quote_count} • Orders ${item.sales_order_count}`}
                </div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {`Spend INR ${money(item.spend)} • Cost/Lead INR ${money(item.cost_per_lead)} • Cost/MQL INR ${money(item.cost_per_mql)} • Cost/SQL INR ${money(item.cost_per_sql)} • Cost/Order INR ${money(item.cost_per_order)}`}
                </div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {`MQL ${item.mql_count || 0} • SQL ${item.sql_count || 0} • First-touch ROI ${Math.round(Number(item.roi || 0) * 100)}%`}
                </div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {`Quote value INR ${money(item.quote_value)} • Order value INR ${money(item.order_value)}`}
                </div>
                {onNavigate ? (
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate("leads", {
                          resetQuote: true,
                          leadsLaunch:
                            item.source_type === "exhibition"
                              ? { exhibitionId: String(item.id), campaignId: "" }
                              : { campaignId: String(item.id), exhibitionId: "" },
                        })
                      }
                    >
                      View attributed leads
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!loading && !rows.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No source performance data yet.</div> : null}
        </div>
      </DeskCard>
    </div>
  );
}
