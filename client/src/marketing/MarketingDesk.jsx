import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, DeskTopStrip, MiniMetric, NoticeBanner, getDeskStatusAppearance } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function TerritoryIngestPanel() {
  const [territories, setTerritories] = useState([]);
  const [endpoints, setEndpoints] = useState([]);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ name: "", match_type: "pincode_prefix", match_value: "", default_user_id: "" });
  const [channel, setChannel] = useState("website");
  const [freshKey, setFreshKey] = useState("");

  useEffect(() => {
    Promise.all([
      apiFetch("/geo/territories").catch(() => null),
      apiFetch("/leads/ingest/endpoints").catch(() => null),
    ]).then(([t, e]) => {
      setTerritories(Array.isArray(t?.territories) ? t.territories : []);
      setEndpoints(Array.isArray(e?.endpoints) ? e.endpoints : []);
    });
  }, []);

  return (
    <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
      <DeskCard title="Circle / territory routing" subtitle="Default assignee by pincode prefix, city, or state">
        <div style={{ display: "grid", gap: 8 }}>
          <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Territory name" />
          <select value={form.match_type} onChange={(e) => setForm((p) => ({ ...p, match_type: e.target.value }))}>
            <option value="pincode_prefix">Pincode prefix</option>
            <option value="pincode">Exact pincode</option>
            <option value="city">City</option>
            <option value="state">State</option>
          </select>
          <input value={form.match_value} onChange={(e) => setForm((p) => ({ ...p, match_value: e.target.value }))} placeholder="Match value (e.g. 122 or Gurugram)" />
          <button
            type="button"
            onClick={async () => {
              try {
                await apiFetch("/geo/territories", { method: "POST", body: JSON.stringify(form) });
                const data = await apiFetch("/geo/territories");
                setTerritories(Array.isArray(data?.territories) ? data.territories : []);
                setNotice("Territory saved.");
              } catch (error) {
                setNotice(getApiErrorMessage(error, "Could not save territory."));
              }
            }}
          >
            Save territory
          </button>
          {territories.slice(0, 8).map((row) => (
            <div key={row.id} style={{ fontSize: 13 }}>
              {row.name} · {row.match_type}={row.match_value}
            </div>
          ))}
          {notice ? <div style={{ fontSize: 12, opacity: 0.72 }}>{notice}</div> : null}
        </div>
      </DeskCard>
      <DeskCard title="Ingest API keys" subtitle="Website, Google, Meta, WhatsApp, telephony, QR. Show the key once.">
        <div style={{ display: "grid", gap: 8 }}>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="website">Website</option>
            <option value="google_lead_form">Google</option>
            <option value="meta_lead_form">Meta</option>
            <option value="linkedin_lead_form">LinkedIn</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="telephony_tollfree">Toll-free</option>
            <option value="qr_form">QR / exhibition</option>
          </select>
          <button
            type="button"
            onClick={async () => {
              try {
                const data = await apiFetch("/leads/ingest/endpoints", {
                  method: "POST",
                  body: JSON.stringify({ channel }),
                });
                setFreshKey(data?.api_key || "");
                const list = await apiFetch("/leads/ingest/endpoints");
                setEndpoints(Array.isArray(list?.endpoints) ? list.endpoints : []);
              } catch (error) {
                setNotice(getApiErrorMessage(error, "Could not create ingest key."));
              }
            }}
          >
            Issue / rotate key
          </button>
          {freshKey ? <div style={{ fontSize: 12, wordBreak: "break-all" }}>New key (copy now): {freshKey}</div> : null}
          {endpoints.map((row) => (
            <div key={row.id} style={{ fontSize: 13 }}>
              {row.channel} · {row.is_enabled ? "enabled" : "off"}
            </div>
          ))}
        </div>
      </DeskCard>
    </div>
  );
}

function QueueRow({ title, subtitle, meta, actionLabel, tone, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        border: "1px solid #e6ebf2",
        borderRadius: 18,
        padding: 14,
        background: "#ffffff",
        display: "grid",
        gap: 10,
        boxShadow: "0 8px 22px rgba(20, 31, 51, 0.05)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          <div style={{ marginTop: 4, fontSize: 13, opacity: 0.74, lineHeight: 1.5 }}>{subtitle}</div>
        </div>
        <DeskChip label={actionLabel} tone={tone.tone} color={tone.color} />
      </div>
      <div style={{ fontSize: 12, opacity: 0.68 }}>{meta}</div>
    </button>
  );
}

export default function MarketingDesk({ me = null, onNavigate = null } = {}) {
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [campaignAlerts, setCampaignAlerts] = useState([]);
  const [exhibitionAlerts, setExhibitionAlerts] = useState([]);
  const [unassignedLeads, setUnassignedLeads] = useState([]);
  const [assignBusyId, setAssignBusyId] = useState(null);

  async function loadDesk() {
    setLoading(true);
    try {
      const [desk, leads] = await Promise.all([
        apiFetch("/marketing/desk"),
        apiFetch("/leads?assignedTo=unassigned").catch(() => null),
      ]);
      setSummary(desk?.summary || null);
      setCampaignAlerts(Array.isArray(desk?.campaign_alerts) ? desk.campaign_alerts : []);
      setExhibitionAlerts(Array.isArray(desk?.exhibition_alerts) ? desk.exhibition_alerts : []);
      const leadRows = Array.isArray(leads?.leads) ? leads.leads : [];
      setUnassignedLeads(leadRows.filter((row) => !row.assigned_to).slice(0, 5));
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not load the Marketing desk right now."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDesk().catch(() => {});
  }, []);

  async function assignLeadToMe(lead) {
    const myId = Number(me?.id);
    if (!Number.isFinite(myId) || myId <= 0) {
      setNotice("Sign in again before assigning leads.");
      return;
    }
    setAssignBusyId(lead.id);
    try {
      await apiFetch(`/leads/${lead.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assigned_to: myId, assignment_reason: "Assigned from Marketing Desk" }),
      });
      setNotice(`Assigned ${lead.lead_number || `lead #${lead.id}`} to you.`);
      await loadDesk();
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not assign this lead."));
    } finally {
      setAssignBusyId(null);
    }
  }

  const topMetrics = useMemo(
    () => [
      {
        label: "Campaigns live",
        value: String(Number(summary?.live_campaigns || 0)),
        tone: "#7c3aed",
        note: "Open campaigns",
        onClick: () => onNavigate?.("campaigns", { resetQuote: true }),
      },
      {
        label: "Exhibitions open",
        value: String(Number(summary?.open_exhibitions || 0)),
        tone: "#8b5a00",
        note: "Open exhibitions",
        onClick: () => onNavigate?.("exhibitions", { resetQuote: true }),
      },
      {
        label: "Attributed leads",
        value: String(Number(summary?.attributed_leads || 0)),
        tone: "#234a8f",
        note: "Open leads",
        onClick: () => onNavigate?.("leads", { resetQuote: true }),
      },
      {
        label: "Fruitful leads",
        value: String(Number(summary?.fruitful_leads || 0)),
        tone: "#0b7d45",
        note: "Open source performance",
        onClick: () => onNavigate?.("source_performance", { resetQuote: true }),
      },
    ],
    [summary, onNavigate]
  );

  const nextActions = useMemo(() => {
    const actions = [];
    for (const item of exhibitionAlerts.slice(0, 2)) {
      const needsIntake = String(item.issue || "").toLowerCase().includes("no leads");
      actions.push({
        key: `ex-${item.id}`,
        label: needsIntake ? `Intake leads · ${item.title}` : `Follow up leads · ${item.title}`,
        onClick: () =>
          onNavigate?.(
            needsIntake ? "exhibitions" : "leads",
            needsIntake
              ? { resetQuote: true, exhibitionsLaunch: { exhibition_id: item.id, open_intake: true } }
              : {
                  resetQuote: true,
                  leadsLaunch: { exhibitionId: String(item.id), assignedTo: "unassigned", campaignId: "" },
                }
          ),
      });
    }
    for (const item of campaignAlerts.slice(0, 2)) {
      actions.push({
        key: `cp-${item.id}`,
        label: `Review campaign · ${item.title}`,
        onClick: () =>
          onNavigate?.("campaigns", {
            resetQuote: true,
            campaignsLaunch: { campaign_id: item.id },
          }),
      });
    }
    if (!actions.length) {
      actions.push(
        { key: "src", label: "Compare source yield before the next spend", onClick: () => onNavigate?.("source_performance", { resetQuote: true }) },
        { key: "leads", label: "Capture fresh leads with proper attribution", onClick: () => onNavigate?.("leads", { resetQuote: true }) }
      );
    }
    return actions.slice(0, 4);
  }, [campaignAlerts, exhibitionAlerts, onNavigate]);

  return (
    <div style={{ maxWidth: 1480 }}>
      <DeskTopStrip
        title="Marketing Desk"
        actions={
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" onClick={() => onNavigate?.("campaigns", { resetQuote: true })}>Open Campaigns</button>
            <button type="button" onClick={() => onNavigate?.("exhibitions", { resetQuote: true })}>Open Exhibitions</button>
            <button type="button" onClick={() => onNavigate?.("source_performance", { resetQuote: true })}>Open Source Performance</button>
            <button type="button" onClick={() => onNavigate?.("marketing", { resetQuote: true })}>Open Market Intelligence</button>
            <button type="button" onClick={() => onNavigate?.("marketing_mailers", { resetQuote: true })}>Open Mailers</button>
            <button type="button" onClick={() => onNavigate?.("leads", { resetQuote: true })}>Open Leads</button>
          </div>
        }
        metrics={topMetrics}
      />

      <NoticeBanner tone="info" message={notice} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 16 }}>
        <DeskStat label="Quote value influenced" value={`INR ${money(summary?.quote_value)}`} tone="#234a8f" />
        <DeskStat label="Order value influenced" value={`INR ${money(summary?.order_value)}`} tone="#0b7d45" />
        <DeskStat label="Campaign actions" value={campaignAlerts.length} tone="#7c3aed" />
        <DeskStat label="Exhibition actions" value={exhibitionAlerts.length} tone="#8b5a00" />
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.34fr)", gap: 16, alignItems: "start" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
          <DeskCard title="Campaign Queue" subtitle="Spend, demand quality, and conversion movement">
            <div style={{ display: "grid", gap: 12 }}>
              {campaignAlerts.map((item) => {
                const tone = getDeskStatusAppearance(item.status, {
                  info: ["planned", "paused"],
                  warning: ["live"],
                  success: ["closed"],
                  fallbackTone: "#eef4ff",
                });
                return (
                  <QueueRow
                    key={`campaign-${item.id}`}
                    title={item.title}
                    subtitle={item.issue}
                    meta={`Status: ${String(item.status || "").replace(/_/g, " ")} • Spend INR ${money(item.spend)}`}
                    actionLabel="Open campaign"
                    tone={tone}
                    onClick={() =>
                      onNavigate?.("campaigns", {
                        resetQuote: true,
                        campaignsLaunch: { campaign_id: item.id },
                      })
                    }
                  />
                );
              })}
              {!loading && !campaignAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No campaign exceptions right now.</div> : null}
            </div>
          </DeskCard>

          <DeskCard title="Exhibition Queue" subtitle="Lead capture and post-event follow-through">
            <div style={{ display: "grid", gap: 12 }}>
              {exhibitionAlerts.map((item) => {
                const tone = getDeskStatusAppearance(item.status, {
                  info: ["planned", "upcoming"],
                  warning: ["live", "follow"],
                  success: ["closed"],
                  fallbackTone: "#fff6e8",
                });
                const needsIntake = String(item.issue || "").toLowerCase().includes("no leads");
                return (
                  <QueueRow
                    key={`exhibition-${item.id}`}
                    title={item.title}
                    subtitle={item.issue}
                    meta={`Status: ${String(item.status || "").replace(/_/g, " ")} • Spend INR ${money(item.spend)}`}
                    actionLabel={needsIntake ? "Lead intake" : "Open leads"}
                    tone={tone}
                    onClick={() => {
                      if (needsIntake) {
                        onNavigate?.("exhibitions", {
                          resetQuote: true,
                          exhibitionsLaunch: { exhibition_id: item.id, open_intake: true },
                        });
                        return;
                      }
                      onNavigate?.("leads", {
                        resetQuote: true,
                        leadsLaunch: {
                          exhibitionId: String(item.id),
                          campaignId: "",
                          assignedTo: "unassigned",
                        },
                      });
                    }}
                  />
                );
              })}
              {!loading && !exhibitionAlerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No exhibition exceptions right now.</div> : null}
            </div>
          </DeskCard>
        </div>

        <DeskCard title="Next Best Actions" subtitle="Live exceptions first — then jump straight into the work.">
          <div style={{ display: "grid", gap: 10 }}>
            {nextActions.map((item) => (
              <button key={item.key} type="button" onClick={item.onClick} style={{ textAlign: "left" }}>
                {item.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Unassigned leads</div>
            <div style={{ display: "grid", gap: 10 }}>
              {unassignedLeads.map((lead) => {
                const busy = assignBusyId === lead.id;
                return (
                  <div
                    key={lead.id}
                    style={{
                      border: "1px solid #e6ebf2",
                      borderRadius: 14,
                      padding: 12,
                      background: "#fff",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div style={{ fontWeight: 800 }}>{lead.lead_number || `Lead #${lead.id}`}</div>
                    <div style={{ fontSize: 13, opacity: 0.74 }}>{lead.company_name || "—"}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" disabled={busy || !me?.id} onClick={() => assignLeadToMe(lead)}>
                        {busy ? "Assigning…" : "Assign to me"}
                      </button>
                      <button
                        type="button"
                        className="button-ghost"
                        onClick={() =>
                          onNavigate?.("leads", {
                            resetQuote: true,
                            leadsLaunch: { lead_id: lead.id },
                          })
                        }
                      >
                        Open lead
                      </button>
                    </div>
                  </div>
                );
              })}
              {!loading && !unassignedLeads.length ? (
                <div style={{ fontSize: 13, opacity: 0.66 }}>No unassigned leads in the current company.</div>
              ) : null}
            </div>
          </div>
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            <MiniMetric label="Primary model" value="First-touch ROI (initial contact)" />
            <MiniMetric label="Duplicate leads" value="Append or add new" />
            <MiniMetric label="Lifecycle" value="New → MQL → SQL → Negotiation" />
            <MiniMetric label="Sales activity" value="Uncontacted → Quote sent → Closed" />
          </div>
          {loading ? <div style={{ fontSize: 13, opacity: 0.68, marginTop: 12 }}>Loading Marketing queues...</div> : null}
        </DeskCard>
      </div>

      <TerritoryIngestPanel users={[]} />
    </div>
  );
}
