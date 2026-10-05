import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";

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

function errMsg(error, fallback) {
  if (typeof error?.data?.detail === "string" && error.data.detail.trim()) return error.data.detail.trim();
  if (typeof error?.data?.error === "string" && error.data.error.trim()) return error.data.error.trim();
  return fallback;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
}

function monthLabel(value) {
  if (!value) return "—";
  const d = String(value).slice(0, 7);
  return d;
}

const STATUS_TONE = {
  Draft: { tone: "#fff6e8", color: "#8b5a00" },
  Published: { tone: "#effcf3", color: "#0b7d45" },
};

function SectionCard({ title, children }) {
  return (
    <div style={{ border: "1px solid #e6ebf2", borderRadius: 16, padding: 14, background: "#fbfcfe" }}>
      <div style={{ fontWeight: 800, marginBottom: 10, fontSize: 14 }}>{title}</div>
      {children}
    </div>
  );
}

export default function ExecutiveBoardDesk() {
  const now = new Date();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [packs, setPacks] = useState([]);
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [generating, setGenerating] = useState(false);
  const [activePack, setActivePack] = useState(null);
  const [publishBusyId, setPublishBusyId] = useState(null);

  const loadPacks = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/management/board-packs");
      setPacks(Array.isArray(data?.packs) ? data.packs : []);
    } catch (err) {
      setError(errMsg(err, "Could not load board packs."));
      setPacks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPacks().catch(() => {});
  }, [loadPacks]);

  const stats = useMemo(() => {
    const published = packs.filter((p) => p.status === "Published").length;
    const drafts = packs.filter((p) => p.status === "Draft").length;
    return [
      { label: "Packs", value: String(packs.length), tone: "#234a8f" },
      { label: "Published", value: String(published), tone: "#0b7d45" },
      { label: "Drafts", value: String(drafts), tone: "#8b5a00" },
      {
        label: "Generate for",
        value: `${year}-${String(month).padStart(2, "0")}`,
        tone: "#7c3aed",
      },
    ];
  }, [packs, month, year]);

  async function generatePack() {
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/management/board-packs/generate", {
        method: "POST",
        body: JSON.stringify({
          month: Number(month),
          year: Number(year),
        }),
      });
      setNotice(`Board pack generated for ${year}-${String(month).padStart(2, "0")}.`);
      setActivePack(data?.pack || null);
      await loadPacks();
    } catch (err) {
      setError(errMsg(err, "Could not generate board pack."));
    } finally {
      setGenerating(false);
    }
  }

  async function openPack(id) {
    setError("");
    try {
      const data = await apiFetch(`/management/board-packs/${id}`);
      setActivePack(data?.pack || null);
    } catch (err) {
      setError(errMsg(err, "Could not open pack."));
    }
  }

  async function publishPack(pack) {
    setPublishBusyId(pack.id);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/management/board-packs/${pack.id}/publish`, {
        method: "POST",
        body: "{}",
      });
      setNotice(`Pack ${monthLabel(pack.report_month)} published.`);
      if (activePack?.id === pack.id) setActivePack(data?.pack || activePack);
      await loadPacks();
    } catch (err) {
      setError(errMsg(err, "Could not publish pack."));
    } finally {
      setPublishBusyId(null);
    }
  }

  function manuscriptText(pack) {
    if (!pack) return "";
    const ms = pack.manuscript_json || {};
    const fin = pack.financial_summary_json || {};
    const voc = pack.voc_summary_json || {};
    const lines = [
      ms.title || `Executive Board Pack — ${monthLabel(pack.report_month)}`,
      "",
      "HEADLINE",
      `- Commissioning completed: ${ms.headline?.commissioning_completed ?? "—"}`,
      `- Trade show spend: ₹ ${money(ms.headline?.trade_show_spend)}`,
      `- Trade show closed-won revenue: ₹ ${money(ms.headline?.trade_show_closed_won_revenue)}`,
      `- Voice of market notes: ${ms.headline?.voice_of_market_notes ?? "—"}`,
      "",
      "SECTIONS",
      ...(Array.isArray(ms.sections)
        ? ms.sections.map((s) => `• ${s.heading}: ${s.body}`)
        : []),
      "",
      "COMMISSIONING",
      `- Tickets: ${fin.commissioning?.completed_count ?? 0}`,
      `- Linked SO value: ₹ ${money(fin.commissioning?.order_value_linked)}`,
      `- Milestones ready/billed: ${fin.commissioning?.milestones_unlocked_or_billed ?? 0} (₹ ${money(
        fin.commissioning?.milestone_amount
      )})`,
      "",
      "TRADE SHOW ROI",
      `- Campaigns: ${fin.trade_show_roi?.campaigns_in_month ?? 0}`,
      `- Spend: ₹ ${money(fin.trade_show_roi?.total_spend)}`,
      `- Leads: ${fin.trade_show_roi?.lead_count ?? 0}`,
      `- Closed-won revenue: ₹ ${money(fin.trade_show_roi?.closed_won_revenue)}`,
      "",
      "VOICE OF MARKET",
      `- Notes: ${voc.total_notes ?? 0}`,
      `- VoC: ${voc.by_source?.voice_of_customer ?? 0} · VoChannel: ${voc.by_source?.voice_of_channel ?? 0}`,
      ...(Array.isArray(voc.top_notes)
        ? voc.top_notes.slice(0, 8).map(
            (n) =>
              `• [${n.severity}] ${n.strategic_category}: ${String(n.feedback_notes || "").slice(0, 180)}`
          )
        : []),
    ];
    return lines.join("\n");
  }

  function copyManuscript(pack) {
    const text = manuscriptText(pack);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setNotice("Manuscript copied for newsletter / governance use."),
        () => setNotice("Copy failed — select text from the modal instead.")
      );
    } else {
      setNotice("Clipboard unavailable — select text from the modal.");
    }
  }

  const years = [];
  for (let y = now.getFullYear(); y >= now.getFullYear() - 5; y -= 1) years.push(y);

  const fin = activePack?.financial_summary_json || {};
  const voc = activePack?.voc_summary_json || {};
  const ms = activePack?.manuscript_json || {};

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Executive control"
        title="Board pack desk"
        description="Compile commissioning outcomes, trade-show ROI, and Voice of Market into a manuscript-ready monthly pack."
        stats={stats}
      />

      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 0.38fr) minmax(0, 1fr)", gap: 16, marginTop: 16, alignItems: "start" }}>
        <DeskCard title="Generate monthly board pack" subtitle="Pulls live commissioning, ROI, and VoM for the selected month">
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              Month
              <select value={month} onChange={(e) => setMonth(e.target.value)}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={String(m)}>
                    {String(m).padStart(2, "0")} — {new Date(2000, m - 1, 1).toLocaleString("en", { month: "long" })}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              Year
              <select value={year} onChange={(e) => setYear(e.target.value)}>
                {years.map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={generatePack} disabled={generating}>
              {generating ? "Generating…" : "Generate Monthly Board Pack"}
            </button>
            <div style={{ fontSize: 12, opacity: 0.68, lineHeight: 1.5 }}>
              Regenerating the same company/month updates the Draft pack. Published packs keep Published status but refresh content.
            </div>
          </div>
        </DeskCard>

        <DeskCard
          title="Historical packs"
          subtitle="Draft and published executive manuscripts"
          actions={
            <button type="button" onClick={() => loadPacks()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          }
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6ebf2" }}>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Month</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 110 }}>Status</th>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Generated by</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 150 }}>Updated</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 180 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((pack) => {
                  const tone = STATUS_TONE[pack.status] || STATUS_TONE.Draft;
                  return (
                    <tr key={pack.id} style={{ borderBottom: "1px solid #f0f3f8" }}>
                      <td style={{ padding: "10px 8px", fontWeight: 700 }}>{monthLabel(pack.report_month)}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <DeskChip label={pack.status} tone={tone.tone} color={tone.color} />
                      </td>
                      <td style={{ padding: "10px 8px" }}>{pack.generated_by_name || "—"}</td>
                      <td style={{ padding: "10px 8px" }}>
                        {pack.updated_at ? new Date(pack.updated_at).toLocaleString() : "—"}
                      </td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                          <button type="button" className="button-ghost" onClick={() => openPack(pack.id)}>
                            View Manuscript
                          </button>
                          {pack.status !== "Published" ? (
                            <button
                              type="button"
                              onClick={() => publishPack(pack)}
                              disabled={publishBusyId === pack.id}
                            >
                              {publishBusyId === pack.id ? "…" : "Publish"}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && !packs.length ? (
              <div style={{ padding: 16, fontSize: 13, opacity: 0.66 }}>No board packs yet. Generate the first monthly pack.</div>
            ) : null}
          </div>
        </DeskCard>
      </div>

      {activePack ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.5)",
            zIndex: 90,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => setActivePack(null)}
        >
          <div
            style={{
              width: "min(820px, 100%)",
              maxHeight: "90vh",
              overflow: "auto",
              borderRadius: 20,
              background: "#fff",
              border: "1px solid #dde5f1",
              padding: 22,
              display: "grid",
              gap: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.55 }}>
                  Executive manuscript
                </div>
                <div style={{ fontWeight: 900, fontSize: 22, marginTop: 6 }}>
                  {ms.title || `Board pack — ${monthLabel(activePack.report_month)}`}
                </div>
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.7 }}>
                  Status: {activePack.status}
                  {activePack.generated_by_name ? ` · ${activePack.generated_by_name}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="button-ghost" onClick={() => copyManuscript(activePack)}>
                  Copy manuscript
                </button>
                {activePack.status !== "Published" ? (
                  <button type="button" onClick={() => publishPack(activePack)} disabled={publishBusyId === activePack.id}>
                    {publishBusyId === activePack.id ? "…" : "Publish Pack"}
                  </button>
                ) : null}
                <button type="button" onClick={() => setActivePack(null)}>
                  Close
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 10 }}>
              {[
                ["Commissioning", ms.headline?.commissioning_completed ?? "—"],
                ["Trade spend", `₹ ${money(ms.headline?.trade_show_spend)}`],
                ["Closed-won", `₹ ${money(ms.headline?.trade_show_closed_won_revenue)}`],
                ["VoM notes", ms.headline?.voice_of_market_notes ?? "—"],
              ].map(([label, value]) => (
                <div key={label} style={{ border: "1px solid #eef1f6", borderRadius: 14, padding: 12, background: "#f8fafc" }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.55 }}>{label}</div>
                  <div style={{ fontWeight: 800, marginTop: 6 }}>{value}</div>
                </div>
              ))}
            </div>

            {Array.isArray(ms.sections) && ms.sections.length ? (
              <SectionCard title="Narrative sections">
                <div style={{ display: "grid", gap: 10 }}>
                  {ms.sections.map((section) => (
                    <div key={section.key || section.heading}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{section.heading}</div>
                      <div style={{ fontSize: 13, opacity: 0.78, lineHeight: 1.55, marginTop: 4 }}>{section.body}</div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <SectionCard title="Financial summary">
                <div style={{ fontSize: 13, lineHeight: 1.55, display: "grid", gap: 6 }}>
                  <div>
                    Commissioning completed: <strong>{fin.commissioning?.completed_count ?? 0}</strong>
                  </div>
                  <div>
                    Linked SO value: <strong>₹ {money(fin.commissioning?.order_value_linked)}</strong>
                  </div>
                  <div>
                    Milestones ready/billed: <strong>{fin.commissioning?.milestones_unlocked_or_billed ?? 0}</strong> (₹{" "}
                    {money(fin.commissioning?.milestone_amount)})
                  </div>
                  <div style={{ borderTop: "1px solid #e8edf4", marginTop: 6, paddingTop: 8 }}>
                    Trade shows: <strong>{fin.trade_show_roi?.campaigns_in_month ?? 0}</strong> · Spend ₹{" "}
                    {money(fin.trade_show_roi?.total_spend)} · Revenue ₹ {money(fin.trade_show_roi?.closed_won_revenue)}
                  </div>
                  {Array.isArray(fin.trade_show_roi?.campaigns) && fin.trade_show_roi.campaigns.length ? (
                    <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                      {fin.trade_show_roi.campaigns.slice(0, 6).map((c) => (
                        <div key={c.id} style={{ opacity: 0.8 }}>
                          {c.event_name}: ₹ {money(c.total_spend)} spend → ₹ {money(c.closed_won_revenue)} won
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </SectionCard>

              <SectionCard title="Voice of market summary">
                <div style={{ fontSize: 13, lineHeight: 1.55, display: "grid", gap: 6 }}>
                  <div>
                    Notes: <strong>{voc.total_notes ?? 0}</strong> · VoC {voc.by_source?.voice_of_customer ?? 0} · Channel{" "}
                    {voc.by_source?.voice_of_channel ?? 0}
                  </div>
                  {voc.by_category && Object.keys(voc.by_category).length ? (
                    <div style={{ opacity: 0.8 }}>
                      Categories:{" "}
                      {Object.entries(voc.by_category)
                        .map(([k, v]) => `${k} (${v})`)
                        .join(", ")}
                    </div>
                  ) : null}
                  {Array.isArray(voc.top_notes) && voc.top_notes.length ? (
                    <div style={{ marginTop: 6, display: "grid", gap: 8 }}>
                      {voc.top_notes.slice(0, 6).map((n) => (
                        <div key={n.id} style={{ borderTop: "1px solid #e8edf4", paddingTop: 8 }}>
                          <div style={{ fontWeight: 700 }}>
                            [{n.severity}] {n.strategic_category}
                          </div>
                          <div style={{ opacity: 0.78, marginTop: 2 }}>{n.feedback_notes}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.66 }}>No VoM notes in this period.</div>
                  )}
                </div>
              </SectionCard>
            </div>

            <SectionCard title="Copy-ready manuscript text">
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: 12,
                  lineHeight: 1.55,
                  opacity: 0.85,
                }}
              >
                {manuscriptText(activePack)}
              </pre>
            </SectionCard>
          </div>
        </div>
      ) : null}
    </div>
  );
}
