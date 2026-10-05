import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero, PressFitLinker, toast } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n);
}

function fmtDate(value) {
  if (!value) return "—";
  return String(value).slice(0, 10);
}

const TRADE_STATUSES = ["Planned", "Active", "Completed", "Closed"];
const VOC_SOURCES = ["Voice of Customer", "Voice of Channel"];
const VOC_CATEGORIES = [
  "Distributor Rationalization",
  "Application Feedback",
  "Pricing Pressure",
  "Competitive Intelligence",
  "Service Quality",
  "Product Gap",
  "Channel Conflict",
  "Other",
];
const VOC_SEVERITIES = ["Info", "Watch", "Critical"];

const STATUS_TONE = {
  Planned: { tone: "#f3f4f6", color: "#4b5563" },
  Active: { tone: "#eef4ff", color: "#234a8f" },
  Completed: { tone: "#effcf3", color: "#0b7d45" },
  Closed: { tone: "#fff6e8", color: "#8b5a00" },
  Info: { tone: "#eef4ff", color: "#234a8f" },
  Watch: { tone: "#fff6e8", color: "#8b5a00" },
  Critical: { tone: "#fff2f3", color: "#9f2042" },
};

const tabBtn = (active) => ({
  border: active ? "1px solid #96b5ff" : "1px solid #dfe5ef",
  background: active ? "#eef4ff" : "#fff",
  color: active ? "#1e3a8a" : "#334155",
  fontWeight: active ? 800 : 600,
  borderRadius: 999,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
});

export default function MarketingRoiDesk() {
  const [tab, setTab] = useState("trade");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [campaigns, setCampaigns] = useState([]);
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [campaignForm, setCampaignForm] = useState({
    event_name: "",
    event_date: "",
    total_spend: "",
    status: "Planned",
    region: "",
    notes: "",
  });
  const [roiDetail, setRoiDetail] = useState(null);
  const [roiBusyId, setRoiBusyId] = useState(null);
  const [attachLeads, setAttachLeads] = useState([]);
  const [attachLeadsLoading, setAttachLeadsLoading] = useState(false);
  const [attachLeadId, setAttachLeadId] = useState("");
  const [attachLead, setAttachLead] = useState(null);
  const [attachLeadLoading, setAttachLeadLoading] = useState(false);

  const [logs, setLogs] = useState([]);
  const [showVocModal, setShowVocModal] = useState(false);
  const [savingVoc, setSavingVoc] = useState(false);
  const [vocForm, setVocForm] = useState({
    source_type: "Voice of Customer",
    strategic_category: "Application Feedback",
    severity: "Info",
    feedback_notes: "",
    is_highlighted: false,
  });

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/marketing/trade-shows");
      setCampaigns(Array.isArray(data?.campaigns) ? data.campaigns : []);
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not load trade show campaigns."));
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/marketing/voice-of-market");
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not load voice of market logs."));
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "trade") loadCampaigns().catch(() => {});
    else loadLogs().catch(() => {});
  }, [tab, loadCampaigns, loadLogs]);

  const stats = useMemo(() => {
    const spend = campaigns.reduce((s, c) => s + Number(c.total_spend || 0), 0);
    const revenue = campaigns.reduce((s, c) => s + Number(c.closed_won_revenue || 0), 0);
    const leads = campaigns.reduce((s, c) => s + Number(c.lead_count || 0), 0);
    return [
      { label: "Campaigns", value: String(campaigns.length), tone: "#234a8f" },
      { label: "Total spend", value: `₹ ${money(spend)}`, tone: "#8b5a00" },
      { label: "Leads attributed", value: String(leads), tone: "#7c3aed" },
      { label: "Closed-won revenue", value: `₹ ${money(revenue)}`, tone: "#0b7d45" },
    ];
  }, [campaigns]);

  async function saveCampaign() {
    if (!campaignForm.event_name.trim()) {
      setError("Event name is required.");
      return;
    }
    setSavingCampaign(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/marketing/trade-shows", {
        method: "POST",
        body: JSON.stringify({
          event_name: campaignForm.event_name.trim(),
          event_date: campaignForm.event_date || null,
          total_spend: campaignForm.total_spend === "" ? 0 : Number(campaignForm.total_spend),
          status: campaignForm.status,
          region: campaignForm.region || null,
          notes: campaignForm.notes || null,
        }),
      });
      setShowCampaignModal(false);
      setCampaignForm({
        event_name: "",
        event_date: "",
        total_spend: "",
        status: "Planned",
        region: "",
        notes: "",
      });
      setNotice("Trade show campaign added.");
      await loadCampaigns();
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not create campaign."));
    } finally {
      setSavingCampaign(false);
    }
  }

  async function viewRoi(campaign) {
    setRoiBusyId(campaign.id);
    setError("");
    setAttachLeadId("");
    setAttachLead(null);
    try {
      const data = await apiFetch(`/marketing/trade-shows/${campaign.id}/roi`);
      setRoiDetail(data?.campaign || null);
      setAttachLeadsLoading(true);
      try {
        const leadsData = await apiFetch("/leads");
        setAttachLeads(Array.isArray(leadsData?.leads) ? leadsData.leads : []);
      } catch {
        setAttachLeads([]);
      } finally {
        setAttachLeadsLoading(false);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not load ROI drill-down."));
    } finally {
      setRoiBusyId(null);
    }
  }

  function leadDisplayName(lead) {
    if (!lead) return "Select a lead";
    const company = String(lead.company_name || "").trim();
    const number = lead.lead_number ? String(lead.lead_number) : `Lead #${lead.id}`;
    return company ? `${company}` : number;
  }

  async function pickAttachLead(rawId) {
    setAttachLeadId(rawId);
    setAttachLead(null);
    if (!rawId) return;
    setAttachLeadLoading(true);
    try {
      const data = await apiFetch(`/leads/${rawId}`);
      setAttachLead(data?.lead || null);
    } catch (err) {
      setAttachLead(null);
      toast(getApiErrorMessage(err, "Could not load that lead."), "error");
    } finally {
      setAttachLeadLoading(false);
    }
  }

  function closeRoiDetail() {
    setRoiDetail(null);
    setAttachLeadId("");
    setAttachLead(null);
    setAttachLeads([]);
  }

  async function linkLeadToCampaign() {
    if (!roiDetail?.id || !attachLead?.id) {
      const err = new Error("Select a lead before linking.");
      err.data = { error: "CAMPAIGN_AND_LEAD_REQUIRED" };
      throw err;
    }
    const already = Number(attachLead.trade_show_campaign_id);
    if (Number.isFinite(already) && already > 0 && already !== Number(roiDetail.id)) {
      const err = new Error("This lead is already attributed to another trade show campaign.");
      err.data = { error: "LEAD_ALREADY_ATTRIBUTED" };
      throw err;
    }
    const data = await apiFetch(`/marketing/trade-shows/${roiDetail.id}/attach-lead`, {
      method: "POST",
      body: JSON.stringify({ lead_id: attachLead.id }),
    });
    setAttachLead((prev) =>
      prev
        ? {
            ...prev,
            trade_show_campaign_id: data?.lead?.trade_show_campaign_id ?? roiDetail.id,
          }
        : prev
    );
    setNotice(`Lead attributed to ${roiDetail.event_name}.`);
    await loadCampaigns();
    try {
      const refreshed = await apiFetch(`/marketing/trade-shows/${roiDetail.id}/roi`);
      if (refreshed?.campaign) setRoiDetail(refreshed.campaign);
    } catch {
      /* keep current detail */
    }
  }

  async function unlinkLeadFromCampaign() {
    if (!roiDetail?.id || !attachLead?.id) {
      const err = new Error("Select a lead before unlinking.");
      err.data = { error: "CAMPAIGN_AND_LEAD_REQUIRED" };
      throw err;
    }
    await apiFetch(`/marketing/trade-shows/${roiDetail.id}/detach-lead`, {
      method: "POST",
      body: JSON.stringify({ lead_id: attachLead.id }),
    });
    setAttachLead((prev) => (prev ? { ...prev, trade_show_campaign_id: null } : prev));
    setNotice(`Lead removed from ${roiDetail.event_name}.`);
    toast(`Unlinked from ${roiDetail.event_name}`, "success");
    await loadCampaigns();
    try {
      const refreshed = await apiFetch(`/marketing/trade-shows/${roiDetail.id}/roi`);
      if (refreshed?.campaign) setRoiDetail(refreshed.campaign);
    } catch {
      /* keep current detail */
    }
  }

  async function saveVoc() {
    if (!vocForm.feedback_notes.trim()) {
      setError("Feedback notes are required.");
      return;
    }
    setSavingVoc(true);
    setError("");
    setNotice("");
    try {
      await apiFetch("/marketing/voice-of-market", {
        method: "POST",
        body: JSON.stringify({
          source_type: vocForm.source_type,
          strategic_category: vocForm.strategic_category,
          severity: vocForm.severity,
          feedback_notes: vocForm.feedback_notes.trim(),
          is_highlighted: Boolean(vocForm.is_highlighted),
        }),
      });
      setShowVocModal(false);
      setVocForm({
        source_type: "Voice of Customer",
        strategic_category: "Application Feedback",
        severity: "Info",
        feedback_notes: "",
        is_highlighted: false,
      });
      setNotice("Voice of market note logged.");
      await loadLogs();
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not log feedback."));
    } finally {
      setSavingVoc(false);
    }
  }

  function copyRoiText(detail) {
    if (!detail) return;
    const text = [
      `Trade show ROI — ${detail.event_name}`,
      `Date: ${fmtDate(detail.event_date)}`,
      `Spend: ${money(detail.total_spend)}`,
      `Leads: ${detail.lead_count || 0}`,
      `CPL: ${detail.cost_per_lead != null ? money(detail.cost_per_lead) : "—"}`,
      `Closed-won leads: ${detail.closed_won_leads || 0}`,
      `Closed-won revenue: ${money(detail.closed_won_revenue)}`,
      `ROI multiple: ${detail.roi_multiple != null ? detail.roi_multiple : "—"}`,
    ].join("\n");
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setNotice("ROI summary copied."),
        () => setNotice(text)
      );
    } else {
      setNotice(text);
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Market intelligence"
        title="Marketing ROI"
        description="Track trade-show cost-per-lead and closed-won yield, and capture Voice of Customer / Channel notes for leadership."
        stats={stats}
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, marginBottom: 8 }}>
        <button type="button" style={tabBtn(tab === "trade")} onClick={() => setTab("trade")}>
          Trade Show ROI
        </button>
        <button type="button" style={tabBtn(tab === "voc")} onClick={() => setTab("voc")}>
          Voice of Market
        </button>
      </div>

      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}

      {tab === "trade" ? (
        <DeskCard
          title="Trade show campaigns"
          subtitle="Spend, CPL, and closed-won revenue from attributed leads"
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => loadCampaigns()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </button>
              <button type="button" onClick={() => setShowCampaignModal(true)}>
                Add Campaign
              </button>
            </div>
          }
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6ebf2" }}>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Event</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 110 }}>Date</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 110 }}>Status</th>
                  <th style={{ padding: "10px 8px", textAlign: "right", width: 120 }}>Total Spend</th>
                  <th style={{ padding: "10px 8px", textAlign: "right", width: 110 }}>CPL</th>
                  <th style={{ padding: "10px 8px", textAlign: "right", width: 140 }}>Closed-Won Revenue</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 80 }}>Leads</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 110 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((row) => {
                  const tone = STATUS_TONE[row.status] || STATUS_TONE.Planned;
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid #f0f3f8" }}>
                      <td style={{ padding: "10px 8px", fontWeight: 700 }}>{row.event_name}</td>
                      <td style={{ padding: "10px 8px" }}>{fmtDate(row.event_date)}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <DeskChip label={row.status} tone={tone.tone} color={tone.color} />
                      </td>
                      <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "monospace" }}>₹ {money(row.total_spend)}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "monospace" }}>
                        {row.cost_per_lead != null ? `₹ ${money(row.cost_per_lead)}` : "—"}
                      </td>
                      <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>₹ {money(row.closed_won_revenue)}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center", fontWeight: 700 }}>{row.lead_count || 0}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <button type="button" className="button-ghost" onClick={() => viewRoi(row)} disabled={roiBusyId === row.id}>
                          {roiBusyId === row.id ? "…" : "View ROI"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && !campaigns.length ? (
              <div style={{ padding: 16, fontSize: 13, opacity: 0.66 }}>
                No trade show campaigns yet. Add Hanover, Faridabad, or other exhibition ROI rows.
              </div>
            ) : null}
          </div>
        </DeskCard>
      ) : (
        <DeskCard
          title="Voice of market"
          subtitle="Ground-level Customer and Channel intelligence"
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => loadLogs()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </button>
              <button type="button" onClick={() => setShowVocModal(true)}>
                Log Feedback
              </button>
            </div>
          }
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6ebf2" }}>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 110 }}>When</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 120 }}>Source</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 140 }}>Category</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 110 }}>Severity</th>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Notes</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 120 }}>By</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => {
                  const tone = STATUS_TONE[row.severity] || STATUS_TONE.Info;
                  return (
                    <tr key={row.id} style={{ borderBottom: "1px solid #f0f3f8", background: row.is_highlighted ? "#fffbeb" : undefined }}>
                      <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>
                        {row.created_at ? new Date(row.created_at).toLocaleDateString() : "—"}
                      </td>
                      <td style={{ padding: "10px 8px" }}>{row.source_type}</td>
                      <td style={{ padding: "10px 8px", fontWeight: 700 }}>{row.strategic_category}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <DeskChip label={row.severity} tone={tone.tone} color={tone.color} />
                      </td>
                      <td style={{ padding: "10px 8px", maxWidth: 360 }}>
                        <div style={{ opacity: 0.85, lineHeight: 1.45 }}>{row.feedback_notes}</div>
                      </td>
                      <td style={{ padding: "10px 8px" }}>{row.submitted_by_name || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && !logs.length ? (
              <div style={{ padding: 16, fontSize: 13, opacity: 0.66 }}>No voice of market notes yet.</div>
            ) : null}
          </div>
        </DeskCard>
      )}

      {showCampaignModal ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 80,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => !savingCampaign && setShowCampaignModal(false)}
        >
          <div
            style={{
              width: "min(480px, 100%)",
              borderRadius: 18,
              background: "#fff",
              border: "1px solid #dde5f1",
              padding: 20,
              display: "grid",
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 900, fontSize: 18 }}>Add trade show campaign</div>
            <input
              placeholder="Event name (e.g. Hanover, Faridabad) *"
              value={campaignForm.event_name}
              onChange={(e) => setCampaignForm((c) => ({ ...c, event_name: e.target.value }))}
            />
            <input
              type="date"
              value={campaignForm.event_date}
              onChange={(e) => setCampaignForm((c) => ({ ...c, event_date: e.target.value }))}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Total spend"
              value={campaignForm.total_spend}
              onChange={(e) => setCampaignForm((c) => ({ ...c, total_spend: e.target.value }))}
            />
            <select value={campaignForm.status} onChange={(e) => setCampaignForm((c) => ({ ...c, status: e.target.value }))}>
              {TRADE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input
              placeholder="Region (optional)"
              value={campaignForm.region}
              onChange={(e) => setCampaignForm((c) => ({ ...c, region: e.target.value }))}
            />
            <textarea
              rows={3}
              placeholder="Notes"
              value={campaignForm.notes}
              onChange={(e) => setCampaignForm((c) => ({ ...c, notes: e.target.value }))}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="button-ghost" onClick={() => setShowCampaignModal(false)} disabled={savingCampaign}>
                Cancel
              </button>
              <button type="button" onClick={saveCampaign} disabled={savingCampaign}>
                {savingCampaign ? "Saving…" : "Save campaign"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showVocModal ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 80,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => !savingVoc && setShowVocModal(false)}
        >
          <div
            style={{
              width: "min(520px, 100%)",
              borderRadius: 18,
              background: "#fff",
              border: "1px solid #dde5f1",
              padding: 20,
              display: "grid",
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 900, fontSize: 18 }}>Log voice of market</div>
            <select value={vocForm.source_type} onChange={(e) => setVocForm((c) => ({ ...c, source_type: e.target.value }))}>
              {VOC_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={vocForm.strategic_category}
              onChange={(e) => setVocForm((c) => ({ ...c, strategic_category: e.target.value }))}
            >
              {VOC_CATEGORIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select value={vocForm.severity} onChange={(e) => setVocForm((c) => ({ ...c, severity: e.target.value }))}>
              {VOC_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <textarea
              rows={5}
              placeholder="Feedback notes *"
              value={vocForm.feedback_notes}
              onChange={(e) => setVocForm((c) => ({ ...c, feedback_notes: e.target.value }))}
            />
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={vocForm.is_highlighted}
                onChange={(e) => setVocForm((c) => ({ ...c, is_highlighted: e.target.checked }))}
              />
              Highlight for board pack
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="button-ghost" onClick={() => setShowVocModal(false)} disabled={savingVoc}>
                Cancel
              </button>
              <button type="button" onClick={saveVoc} disabled={savingVoc}>
                {savingVoc ? "Saving…" : "Save feedback"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {roiDetail ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 85,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={closeRoiDetail}
        >
          <div
            style={{
              width: "min(680px, 100%)",
              maxHeight: "min(92vh, 900px)",
              overflow: "auto",
              borderRadius: 18,
              background: "#fff",
              border: "1px solid #dde5f1",
              padding: 20,
              display: "grid",
              gap: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 900, fontSize: 18 }}>{roiDetail.event_name}</div>
            <div style={{ fontSize: 13, opacity: 0.7 }}>
              {fmtDate(roiDetail.event_date)} · {roiDetail.status}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {[
                ["Total spend", `₹ ${money(roiDetail.total_spend)}`],
                ["Leads", String(roiDetail.lead_count || 0)],
                ["CPL", roiDetail.cost_per_lead != null ? `₹ ${money(roiDetail.cost_per_lead)}` : "—"],
                ["Closed-won leads", String(roiDetail.closed_won_leads || 0)],
                ["Closed-won revenue", `₹ ${money(roiDetail.closed_won_revenue)}`],
                ["ROI multiple", roiDetail.roi_multiple != null ? String(roiDetail.roi_multiple) : "—"],
              ].map(([label, value]) => (
                <div key={label} style={{ border: "1px solid #eef1f6", borderRadius: 14, padding: 12 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.55 }}>{label}</div>
                  <div style={{ fontWeight: 800, marginTop: 6 }}>{value}</div>
                </div>
              ))}
            </div>

            <div
              style={{
                border: "1px solid #e8eef6",
                borderRadius: 16,
                padding: 16,
                background: "#f8fafc",
                display: "grid",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontWeight: 800, fontSize: 14 }}>Attribute lead</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                  Press-fit a lead onto this trade show so CPL and closed-won ROI stay accurate.
                </div>
              </div>
              <label style={{ display: "grid", gap: 6, fontSize: 12, fontWeight: 700, color: "#475569" }}>
                Lead
                <select
                  value={attachLeadId}
                  onChange={(e) => pickAttachLead(e.target.value)}
                  disabled={attachLeadsLoading || attachLeadLoading}
                  style={{ fontWeight: 600, color: "#16202b" }}
                >
                  <option value="">{attachLeadsLoading ? "Loading leads…" : "Select a lead…"}</option>
                  {attachLeads.map((lead) => (
                    <option key={lead.id} value={String(lead.id)}>
                      {lead.lead_number ? `${lead.lead_number} · ` : ""}
                      {lead.company_name || `Lead #${lead.id}`}
                    </option>
                  ))}
                </select>
              </label>

              {attachLeadLoading ? (
                <div style={{ fontSize: 12, opacity: 0.6 }}>Loading lead…</div>
              ) : attachLead ? (
                <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                  <div style={{ minWidth: 320 }}>
                    <PressFitLinker
                      leftLabel={leadDisplayName(attachLead)}
                      rightLabel={roiDetail.event_name || "Campaign"}
                      linked={Number(attachLead.trade_show_campaign_id) === Number(roiDetail.id)}
                      linkLabel="Link lead"
                      linkedLabel="Attributed · Crimped"
                      onLink={linkLeadToCampaign}
                      onUnlink={unlinkLeadFromCampaign}
                      onError={(err) => toast(getApiErrorMessage(err, "Could not update lead attribution."), "error")}
                      onLinked={() => toast(`Linked to ${roiDetail.event_name}`, "success")}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.55 }}>Choose a lead to enable the press-fit linker.</div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="button-ghost" onClick={() => copyRoiText(roiDetail)}>
                Copy summary
              </button>
              <button type="button" onClick={closeRoiDetail}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
