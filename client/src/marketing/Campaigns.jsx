import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function pct(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function CampaignRoiPanel({ campaignId }) {
  const [roi, setRoi] = useState(null);
  useEffect(() => {
    let active = true;
    apiFetch(`/marketing/campaigns/${campaignId}/roi`)
      .then((data) => {
        if (active) setRoi(data?.roi || null);
      })
      .catch(() => {
        if (active) setRoi(null);
      });
    return () => {
      active = false;
    };
  }, [campaignId]);
  if (!roi) return <div style={{ fontSize: 12, opacity: 0.68 }}>First-touch ROI loading…</div>;
  return (
    <div style={{ fontSize: 13, opacity: 0.86, background: "#f8fafc", borderRadius: 12, padding: 10 }}>
      {`First-touch ROI ${pct(roi.roi)} • CPL INR ${money(roi.cpl)} • Cost/MQL INR ${money(roi.cost_per_mql)} • Cost/SQL INR ${money(roi.cost_per_sql)} • Cost/Order INR ${money(roi.cost_per_order)} • MQL ${roi.mql_count} • SQL ${roi.sql_count}`}
    </div>
  );
}

function statusTone(status) {
  if (status === "closed") return { tone: "#effcf3", color: "#0b7d45" };
  if (status === "live") return { tone: "#fff6e8", color: "#8b5a00" };
  if (status === "paused") return { tone: "#f5f6fa", color: "#58627a" };
  return { tone: "#eef4ff", color: "#234a8f" };
}

export default function Campaigns({ launch = null, onConsumeLaunch = null, onNavigate = null } = {}) {
  const [rows, setRows] = useState([]);
  const [sources, setSources] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [form, setForm] = useState({
    campaign_name: "",
    channel_type: "social_media",
    lead_source_id: "",
    city: "",
    start_date: "",
    end_date: "",
    planned_budget: "",
    actual_spend: "",
    agency_name: "",
    notes: "",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [campaignsData, bootstrapData] = await Promise.all([apiFetch("/marketing/campaigns"), apiFetch("/marketing/bootstrap")]);
        if (!active) return;
        setRows(Array.isArray(campaignsData?.campaigns) ? campaignsData.campaigns : []);
        setSources(Array.isArray(bootstrapData?.lead_sources) ? bootstrapData.lead_sources : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load campaigns right now."));
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const nextFocus = launch.campaign_id || launch.focusId || "";
    if (nextFocus) setFocusId(String(nextFocus));
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  const stats = useMemo(() => {
    const live = rows.filter((item) => item.status === "live").length;
    const leadCount = rows.reduce((sum, item) => sum + Number(item.lead_count || 0), 0);
    const fruitful = rows.reduce((sum, item) => sum + Number(item.fruitful_leads || 0), 0);
    const spend = rows.reduce((sum, item) => sum + Number(item.actual_spend || 0), 0);
    return [
      { label: "Live campaigns", value: String(live), tone: "#7c3aed" },
      { label: "Attributed leads", value: String(leadCount), tone: "#234a8f" },
      { label: "Fruitful leads", value: String(fruitful), tone: "#0b7d45" },
      { label: "Spend tracked", value: `INR ${money(spend)}`, tone: "#8b5a00" },
    ];
  }, [rows]);

  async function createCampaign() {
    if (!form.campaign_name.trim()) {
      setNotice("Enter a campaign name before saving.");
      return;
    }
    try {
      const data = await apiFetch("/marketing/campaigns", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          lead_source_id: form.lead_source_id ? Number(form.lead_source_id) : null,
        }),
      });
      setRows((current) => [data.campaign, ...current].filter(Boolean));
      setForm({
        campaign_name: "",
        channel_type: "social_media",
        lead_source_id: "",
        city: "",
        start_date: "",
        end_date: "",
        planned_budget: "",
        actual_spend: "",
        agency_name: "",
        notes: "",
      });
      setNotice("Campaign saved.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not save campaign right now."));
    }
  }

  async function updateStatus(id, campaign_status, message) {
    try {
      const data = await apiFetch(`/marketing/campaigns/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ campaign_status }),
      });
      setRows((current) => current.map((item) => (item.id === id ? data.campaign : item)));
      setNotice(message);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update campaign right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Digital Demand"
        title="Campaigns"
        description="Track social and digital campaigns with budget, spend, and downstream yield so Marketing can judge quality instead of just counting inquiries."
        stats={stats}
      />

      <NoticeBanner tone="info" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 0.36fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="New Campaign" subtitle="Create a source that can feed attributed leads into the sales funnel">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.campaign_name} onChange={(e) => setForm((current) => ({ ...current, campaign_name: e.target.value }))} placeholder="Campaign name" />
            <select value={form.channel_type} onChange={(e) => setForm((current) => ({ ...current, channel_type: e.target.value }))}>
              <option value="social_media">Social media</option>
              <option value="google_ads">Google ads</option>
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="referral">Referral</option>
              <option value="other">Other</option>
            </select>
            <select value={form.lead_source_id} onChange={(e) => setForm((current) => ({ ...current, lead_source_id: e.target.value }))}>
              <option value="">Lead source</option>
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.source_name}
                </option>
              ))}
            </select>
            <input value={form.city} onChange={(e) => setForm((current) => ({ ...current, city: e.target.value }))} placeholder="Target city (optional)" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input type="date" value={form.start_date} onChange={(e) => setForm((current) => ({ ...current, start_date: e.target.value }))} />
              <input type="date" value={form.end_date} onChange={(e) => setForm((current) => ({ ...current, end_date: e.target.value }))} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input value={form.planned_budget} onChange={(e) => setForm((current) => ({ ...current, planned_budget: e.target.value }))} placeholder="Planned budget" />
              <input value={form.actual_spend} onChange={(e) => setForm((current) => ({ ...current, actual_spend: e.target.value }))} placeholder="Actual spend" />
            </div>
            <input value={form.agency_name} onChange={(e) => setForm((current) => ({ ...current, agency_name: e.target.value }))} placeholder="Agency / vendor (optional)" />
            <textarea rows={4} value={form.notes} onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))} placeholder="Notes" />
            <button type="button" onClick={createCampaign}>Save Campaign</button>
          </div>
        </DeskCard>

        <DeskCard title="Campaign Performance" subtitle="Budget, lead quality, quote movement, and order yield">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading campaigns...</div> : null}
            {rows.map((item) => {
              const tone = statusTone(item.status);
              const isFocused = String(focusId || "") === String(item.id);
              return (
                <div
                  key={item.id}
                  id={`campaign-${item.id}`}
                  style={{
                    border: isFocused ? "2px solid #7c3aed" : "1px solid #e6ebf2",
                    borderRadius: 18,
                    padding: 14,
                    background: isFocused ? "#f8f4ff" : "#fff",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.campaign_name}</div>
                      <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                        {[item.channel_type.replace(/_/g, " "), item.lead_source_name, item.city].filter(Boolean).join(" • ")}
                      </div>
                    </div>
                    <DeskChip label={item.status} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {`Leads ${item.lead_count} • Fruitful ${item.fruitful_leads} • Quotes ${item.quote_count} • Orders ${item.sales_order_count}`}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {`Spend INR ${money(item.actual_spend)} / Budget INR ${money(item.planned_budget)} • Quote value INR ${money(item.quote_value)} • Order value INR ${money(item.order_value)}`}
                  </div>
                  <CampaignRoiPanel campaignId={item.id} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate?.("leads", {
                          resetQuote: true,
                          leadsLaunch: { campaignId: String(item.id), exhibitionId: "", assignedTo: "" },
                        })
                      }
                    >
                      View leads
                    </button>
                    {item.status !== "live" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "live", `Campaign marked live: ${item.campaign_name}.`)}>
                        Mark Live
                      </button>
                    ) : null}
                    {item.status !== "paused" && item.status !== "closed" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "paused", `Campaign paused: ${item.campaign_name}.`)}>
                        Pause
                      </button>
                    ) : null}
                    {item.status !== "closed" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "closed", `Campaign closed: ${item.campaign_name}.`)}>
                        Close
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!loading && !rows.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No campaigns yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
