import React, { useCallback, useEffect, useState } from "react";
import LiquidityWidget from "./LiquidityWidget";
import ShopFloorHealthPanel from "./ShopFloorHealthPanel";
import CommercialServicePulse from "./CommercialServicePulse";
import { useGlobalTimeline } from "../timeline/GlobalTimelineContext";
import { appendTimelineParams } from "../timeline/globalTimeline";
import "./executive.css";

async function fetchExecutiveMetrics(timeline, { bustCache = false } = {}) {
  const params = new URLSearchParams();
  appendTimelineParams(params, timeline);
  if (bustCache) params.set("_", String(Date.now()));
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`/api/executive/dashboard-metrics${qs}`, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      (typeof data?.detail === "string" && data.detail) ||
      (typeof data?.error === "string" && data.error) ||
      `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (!data?.ok || !data?.metrics) {
    throw new Error(data?.error || "Executive metrics payload missing");
  }
  return data.metrics;
}

export default function ExecutiveCommandCenter({ onNavigate }) {
  const timeline = useGlobalTimeline();
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState("");
  const [exceptions, setExceptions] = useState([]);

  const loadData = useCallback(
    async ({ bustCache = false } = {}) => {
      setLoading(true);
      setError("");
      try {
        const next = await fetchExecutiveMetrics(timeline, { bustCache });
        setMetrics(next);
        setLastUpdated(new Date());
      } catch (err) {
        console.error("Failed to load executive metrics:", err);
        setError(err?.message || "Could not refresh executive intelligence.");
      } finally {
        setLoading(false);
      }
    },
    [timeline]
  );

  const loadExceptions = useCallback(async () => {
    try {
      const [matchRes, grnRes, creditRes] = await Promise.all([
        fetch("/three-way-match/exceptions?limit=1", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/goods-receipts/exceptions-summary", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("/credit-control/summary", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const rows = [];
      const matchCount = Number(matchRes?.total ?? matchRes?.exceptions?.length ?? matchRes?.count ?? 0);
      if (matchCount > 0) {
        rows.push({
          key: "3wm",
          label: "3-way match exceptions",
          count: matchCount,
          page: "three_way_match",
        });
      }
      const grnCount = Number(
        grnRes?.summary?.open_exceptions ??
          grnRes?.summary?.exception_count ??
          grnRes?.exception_count ??
          0
      );
      if (grnCount > 0) {
        rows.push({ key: "grn", label: "GRN exceptions", count: grnCount, page: "goods_receipts" });
      }
      const creditHeld = Number(
        creditRes?.summary?.held_orders ??
          creditRes?.held_count ??
          creditRes?.summary?.blocked_count ??
          0
      );
      if (creditHeld > 0) {
        rows.push({ key: "credit", label: "Credit holds", count: creditHeld, page: "ar_desk" });
      }
      setExceptions(rows);
    } catch {
      setExceptions([]);
    }
  }, []);

  useEffect(() => {
    loadData({ bustCache: false }).catch(() => {});
  }, [loadData, timeline.revision, timeline.date_from, timeline.date_to, timeline.preset]);

  useEffect(() => {
    loadExceptions().catch(() => {});
  }, [loadExceptions, timeline.revision]);

  const workingCapital = metrics?.working_capital || {};
  const manufacturing = metrics?.manufacturing || {};
  const commercialService = metrics?.commercial_service || {};

  const netWorkingCapital = Number(workingCapital.net_working_capital || 0);
  const liquidCash = Number(workingCapital.liquid_cash_balance || 0);
  const totalPipeline = Number(commercialService.pipeline?.total_value || 0);
  const completionEfficiency = Number(manufacturing.completion_efficiency_pct || 0);

  return (
    <div className="executive-command-center">
      <div className="ecc-command-bar">
        <div className="ecc-title-group">
          <h1>Executive Intelligence & Real-Time Operational BI</h1>
          <p title={metrics?.timeline?.hint || timeline.hint || undefined}>
            Unified Command Center ·{" "}
            <strong>
              {[
                metrics?.timeline?.label || timeline.label,
                metrics?.timeline?.range_label || timeline.range_label,
              ]
                .filter(Boolean)
                .join(" · ")}
            </strong>
          </p>
        </div>
        <div className="ecc-actions-group">
          {lastUpdated && (
            <span style={{ fontSize: "0.75rem", color: "#64748b", marginRight: 6 }}>
              Updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            className="ecc-btn secondary"
            type="button"
            onClick={() => {
              loadData({ bustCache: true });
              loadExceptions();
            }}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "↻ Refresh Intelligence"}
          </button>
        </div>
      </div>

      {exceptions.length ? (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #fdba74",
            background: "#fff7ed",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
          }}
        >
          <strong style={{ color: "#9a3412", fontSize: 13 }}>Exceptions strip</strong>
          {exceptions.map((row) => (
            <button
              key={row.key}
              type="button"
              className="ecc-btn secondary"
              style={{ fontSize: 12 }}
              onClick={() => typeof onNavigate === "function" && onNavigate(row.page, { resetQuote: true })}
            >
              {row.label}: {row.count}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="ecc-macro-grid">
        <div
          className="ecc-macro-card"
          style={{ borderTopColor: netWorkingCapital >= 0 ? "var(--absstem-primary, #0ea5e9)" : "#b91c1c" }}
        >
          <span className="label">Net Working Capital</span>
          <span className="value" style={{ color: netWorkingCapital >= 0 ? "#0f172a" : "#b91c1c" }}>
            ₹{netWorkingCapital.toLocaleString("en-IN")}
          </span>
          <span className="subtext">Cash + AR + Inventory − AP − Net GST</span>
        </div>

        <div className="ecc-macro-card" style={{ borderTopColor: "#15803d" }}>
          <span className="label">Liquid Cash & Bank Reserves</span>
          <span className="value" style={{ color: "#15803d" }}>
            ₹{liquidCash.toLocaleString("en-IN")}
          </span>
          <span className="subtext">
            {liquidCash > 0
              ? workingCapital.cash_source === "finance_books"
                ? "Bank books as of window end"
                : "Cash and bank as of window end"
              : "No cash/bank GL or bank-book balance"}
          </span>
        </div>

        <div className="ecc-macro-card" style={{ borderTopColor: "#d97706" }}>
          <span className="label">Active Sales Pipeline</span>
          <span className="value" style={{ color: "#d97706" }}>
            ₹{totalPipeline.toLocaleString("en-IN")}
          </span>
          <span className="subtext">{commercialService.pipeline?.total_deals || 0} Commercial Deals Tracked</span>
        </div>

        <div className="ecc-macro-card" style={{ borderTopColor: "#7c3aed" }}>
          <span className="label">Shop Floor Completion Efficiency</span>
          <span className="value" style={{ color: "#7c3aed" }}>
            {completionEfficiency}%
          </span>
          <span className="subtext">{manufacturing.work_orders?.completed || 0} Finished Goods Built</span>
        </div>
      </div>

      <div className="ecc-panel-grid">
        <LiquidityWidget workingCapital={workingCapital} />
        <ShopFloorHealthPanel manufacturing={manufacturing} />
      </div>

      <CommercialServicePulse commercialService={commercialService} />
    </div>
  );
}
