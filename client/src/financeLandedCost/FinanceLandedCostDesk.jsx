import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, toast } from "../shared/joshUi";

function Section({ title, subtitle, children }) {
  return <section className="desk-section"><div className="section-heading"><div><h2>{title}</h2><p className="muted">{subtitle}</p></div></div>{children}</section>;
}

function StatCard({ label, value, detail }) {
  return <div className="stat-card"><div className="muted">{label}</div><strong>{value}</strong><small>{detail}</small></div>;
}

function money(value) {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function FinanceLandedCostDesk() {
  const [settings, setSettings] = useState(null);
  const [threshold, setThreshold] = useState("5");
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ stock_qty: 0, stock_value_base: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsRes, valuationRes] = await Promise.all([
        fetch("/finance-landed-cost/settings"),
        fetch("/finance-landed-cost/valuation?limit=250"),
      ]);
      const settingsBody = await settingsRes.json();
      const valuationBody = await valuationRes.json();
      if (!settingsRes.ok || !settingsBody.ok) throw new Error(settingsBody.error || "Unable to load finance settings");
      if (!valuationRes.ok || !valuationBody.ok) throw new Error(valuationBody.error || "Unable to load valuation");
      setSettings(settingsBody.settings);
      setThreshold(String(settingsBody.settings?.landed_cost_variance_threshold_pct ?? 5));
      setRows(valuationBody.rows || []);
      setSummary(valuationBody.summary || { stock_qty: 0, stock_value_base: 0 });
    } catch (error) {
      toast(error.message || "Unable to load landed-cost valuation", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/finance-landed-cost/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ landed_cost_variance_threshold_pct: Number(threshold) }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || "Unable to save threshold");
      setSettings(body.settings);
      toast("Finance variance threshold saved", "success");
    } catch (error) {
      toast(error.message || "Unable to save threshold", "error");
    } finally {
      setSaving(false);
    }
  }

  const asOf = useMemo(() => {
    const dates = rows.map((row) => row.valuation_updated_at).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  }, [rows]);

  return (
    <div className="desk-shell">
      <div className="desk-header">
        <div>
          <div className="eyebrow">Finance control</div>
          <h1>Landed cost & inventory valuation</h1>
          <p className="muted">Weighted-average stock value from posted receipts, including freight, duty, and handling.</p>
        </div>
        <button className="button secondary" onClick={load} disabled={loading}>Refresh</button>
      </div>

      <div className="stat-grid">
        <StatCard label="Inventory value" value={money(summary.stock_value_base)} detail="Base currency" />
        <StatCard label="Quantity on hand" value={money(summary.stock_qty)} detail="Valued stock items" />
        <StatCard label="Variance threshold" value={`${threshold}%`} detail="Alternate vendor alert" />
      </div>

      <Section title="Finance settings" subtitle={settings ? `Updated ${new Date(settings.updated_at).toLocaleString()}` : "Default threshold is 5%"}>
        <form className="inline-form" onSubmit={saveSettings}>
          <label>
            Alternate vendor variance threshold %
            <input type="number" min="0" max="1000" step="0.01" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
          </label>
          <button className="button primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save setting"}</button>
        </form>
      </Section>

      <Section title="Valuation by item" subtitle={asOf ? `Latest valuation ${new Date(asOf).toLocaleString()}` : "No posted receipt valuation yet"}>
        {loading ? <div className="loading-state">Loading landed-cost balances…</div> : rows.length === 0 ? (
          <EmptyState title="No valued stock yet" body="Post a goods receipt linked to a purchase order to create a landed-cost valuation." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item Code / Name</th>
                  <th style={{ width: 140, textAlign: "right" }}>Valued Qty</th>
                  <th style={{ width: 180, textAlign: "right" }}>Avg. Landed Unit Cost</th>
                  <th style={{ width: 160, textAlign: "right" }}>Total Stock Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.product_id}>
                    <td><strong>{row.item_code || "—"}</strong><div className="muted">{row.item_name || "Unnamed item"}</div></td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{money(row.stock_qty)} {row.uom || ""}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{money(row.average_unit_cost_base)}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}><strong>{money(row.stock_value_base)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
