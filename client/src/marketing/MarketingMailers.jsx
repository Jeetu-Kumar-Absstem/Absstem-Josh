import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, MiniMetric, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function toneForType(type) {
  return type === "event_awareness"
    ? { tone: "#fff6e8", color: "#8b5a00" }
    : { tone: "#eef4ff", color: "#234a8f" };
}

export default function MarketingMailers() {
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [mailers, setMailers] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [active, setActive] = useState(null);
  const [logs, setLogs] = useState([]);
  const [dormancy, setDormancy] = useState(null);
  const [bootstrap, setBootstrap] = useState({ lead_sources: [], distributors: [], campaigns: [], exhibitions: [] });

  const [createForm, setCreateForm] = useState({
    mailer_name: "",
    mailer_type: "newsletter",
    subject: "",
    body_text: "",
    include_event_details: false,
    campaign_id: "",
    exhibition_id: "",
  });

  const [sendForm, setSendForm] = useState({
    audience_type: "customers",
    custom_emails: "",
    distributor_id: "",
    sender_distributor_id: "",
  });

  async function loadList() {
    setLoading(true);
    try {
      const [listData, bootData, dormancyData] = await Promise.all([
        apiFetch("/marketing/mailers"),
        apiFetch("/marketing/bootstrap"),
        apiFetch("/marketing/dormancy/preview").catch(() => null),
      ]);
      setMailers(Array.isArray(listData?.mailers) ? listData.mailers : []);
      setBootstrap({
        lead_sources: Array.isArray(bootData?.lead_sources) ? bootData.lead_sources : [],
        distributors: Array.isArray(bootData?.distributors) ? bootData.distributors : [],
        campaigns: Array.isArray(bootData?.campaigns) ? bootData.campaigns : [],
        exhibitions: Array.isArray(bootData?.exhibitions) ? bootData.exhibitions : [],
      });
      setDormancy(dormancyData);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not load marketing mailers right now."));
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(id) {
    if (!id) return;
    setLoading(true);
    try {
      const data = await apiFetch(`/marketing/mailers/${id}`);
      setActive(data?.mailer || null);
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not load mailer details right now."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
  }, []);

  useEffect(() => {
    if (!activeId) {
      setActive(null);
      setLogs([]);
      return;
    }
    loadDetail(activeId);
  }, [activeId]);

  const stats = useMemo(() => {
    const sent = mailers.reduce((sum, item) => sum + Number(item.sent_count || 0), 0);
    const opens = mailers.reduce((sum, item) => sum + Number(item.open_count || 0), 0);
    const clicks = mailers.reduce((sum, item) => sum + Number(item.click_count || 0), 0);
    const drafts = mailers.filter((item) => item.mailer_status === "draft").length;
    return [
      { label: "Draft mailers", value: String(drafts), tone: "#234a8f" },
      { label: "Emails sent", value: String(sent), tone: "#7c3aed" },
      { label: "Opens tracked", value: String(opens), tone: "#0b7d45" },
      { label: "Clicks tracked", value: String(clicks), tone: "#8b5a00" },
    ];
  }, [mailers]);

  async function createMailer() {
    if (!createForm.mailer_name.trim() || !createForm.subject.trim() || !createForm.body_text.trim()) {
      setNotice("Mailer name, subject, and body are required.");
      return;
    }
    try {
      const data = await apiFetch("/marketing/mailers", {
        method: "POST",
        body: JSON.stringify({
          ...createForm,
          campaign_id: createForm.campaign_id ? Number(createForm.campaign_id) : null,
          exhibition_id: createForm.exhibition_id ? Number(createForm.exhibition_id) : null,
        }),
      });
      setNotice("Mailer saved.");
      await loadList();
      if (data?.mailer?.id) setActiveId(data.mailer.id);
      setCreateForm({
        mailer_name: "",
        mailer_type: "newsletter",
        subject: "",
        body_text: "",
        include_event_details: false,
        campaign_id: "",
        exhibition_id: "",
      });
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not save mailer right now."));
    }
  }

  async function sendMailer() {
    if (!active?.id) return;
    try {
      const payload = {
        ...sendForm,
        distributor_id: sendForm.distributor_id ? Number(sendForm.distributor_id) : null,
        sender_distributor_id: sendForm.sender_distributor_id ? Number(sendForm.sender_distributor_id) : null,
      };
      const data = await apiFetch(`/marketing/mailers/${active.id}/send`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const okCount = Array.isArray(data?.results) ? data.results.filter((r) => r.ok).length : 0;
      setNotice(`Mailer sent. Success: ${okCount}.`);
      await loadList();
      await loadDetail(active.id);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not send mailer right now."));
    }
  }

  const activeTone = toneForType(active?.mailer_type || "newsletter");

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Outbound awareness"
        title="Marketing Mailers"
        description="Send newsletters and upcoming event awareness mails in a controlled way, with open and click tracking for real engagement visibility."
        stats={stats}
      />

      <NoticeBanner tone="info" message={notice} />

      <DeskCard
        title="6-month dormancy / Brevo segment"
        subtitle="Idle leads (no sales engagement for 6 months) are flagged for the monthly newsletter. New sales activity removes them."
      >
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <MiniMetric label="Dormant now" value={String(dormancy?.dormant_count || 0)} />
          <button
            type="button"
            onClick={async () => {
              try {
                const data = await apiFetch("/marketing/dormancy/run", { method: "POST", body: "{}" });
                setNotice(`Dormancy scan: marked ${data?.marked || 0}, cleared ${data?.cleared || 0}.`);
                await loadList();
              } catch (error) {
                setNotice(getApiErrorMessage(error, "Could not run dormancy scan."));
              }
            }}
          >
            Run scan
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                const data = await apiFetch("/marketing/brevo/sync", { method: "POST", body: "{}" });
                setNotice(`Brevo sync: pushed ${data?.pushed || 0}, removed ${data?.removed || 0}, errors ${data?.errors || 0}.`);
              } catch (error) {
                setNotice(getApiErrorMessage(error, "Brevo is not configured (set BREVO_API_KEY)."));
              }
            }}
          >
            Sync Brevo
          </button>
        </div>
      </DeskCard>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 0.36fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Create Mailer" subtitle="Newsletter or event awareness mail with tracking">
          <div style={{ display: "grid", gap: 10 }}>
            <input
              value={createForm.mailer_name}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, mailer_name: e.target.value }))}
              placeholder="Mailer name"
            />
            <select value={createForm.mailer_type} onChange={(e) => setCreateForm((prev) => ({ ...prev, mailer_type: e.target.value }))}>
              <option value="newsletter">Newsletter</option>
              <option value="event_awareness">Event awareness</option>
            </select>
            <input value={createForm.subject} onChange={(e) => setCreateForm((prev) => ({ ...prev, subject: e.target.value }))} placeholder="Subject" />
            <textarea
              rows={9}
              value={createForm.body_text}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, body_text: e.target.value }))}
              placeholder="Write the mail content here. Links will be tracked automatically."
            />
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, opacity: 0.82 }}>
              <input
                type="checkbox"
                checked={createForm.include_event_details}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, include_event_details: e.target.checked }))}
              />
              Add exhibition details block (if linked)
            </label>
            <select value={createForm.exhibition_id} onChange={(e) => setCreateForm((prev) => ({ ...prev, exhibition_id: e.target.value }))}>
              <option value="">Link exhibition (optional)</option>
              {bootstrap.exhibitions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.exhibition_name}
                </option>
              ))}
            </select>
            <select value={createForm.campaign_id} onChange={(e) => setCreateForm((prev) => ({ ...prev, campaign_id: e.target.value }))}>
              <option value="">Link campaign (optional)</option>
              {bootstrap.campaigns.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.campaign_name}
                </option>
              ))}
            </select>
            <button type="button" onClick={createMailer}>
              Save Mailer
            </button>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading…</div> : null}
          </div>
        </DeskCard>

        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard title="Mailer List" subtitle="Pick a mailer to send and track engagement">
            <div style={{ display: "grid", gap: 10 }}>
              {mailers.map((item) => {
                const tone = toneForType(item.mailer_type);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveId(item.id)}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      border: "1px solid #e6ebf2",
                      borderRadius: 18,
                      padding: 14,
                      background: String(item.id) === String(activeId) ? "#eef4ff" : "#ffffff",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 800 }}>{item.mailer_name}</div>
                        <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                          {[item.mailer_status, item.exhibition_name, item.campaign_name].filter(Boolean).join(" • ")}
                        </div>
                      </div>
                      <DeskChip label={item.mailer_type.replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.78 }}>{item.subject}</div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, opacity: 0.7 }}>
                      <span>Sent: {item.sent_count}</span>
                      <span>Opens: {item.open_count}</span>
                      <span>Clicks: {item.click_count}</span>
                    </div>
                  </button>
                );
              })}
              {!loading && !mailers.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No mailers yet.</div> : null}
            </div>
          </DeskCard>

          {active ? (
            <DeskCard
              title="Send And Track"
              subtitle="Select audience and send. Unsubscribed emails are automatically suppressed."
              actions={<DeskChip label={active.mailer_status} tone={activeTone.tone} color={activeTone.color} />}
            >
              <div style={{ display: "grid", gap: 12 }}>
                <MiniMetric label="Subject" value={active.subject} />
                <MiniMetric label="Linked exhibition" value={active.exhibition_name || "—"} />
                <MiniMetric label="Linked campaign" value={active.campaign_name || "—"} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <select
                    value={sendForm.audience_type}
                    onChange={(e) => setSendForm((prev) => ({ ...prev, audience_type: e.target.value }))}
                  >
                    <option value="customers">Customers</option>
                    <option value="leads">Leads</option>
                    <option value="distributor">Distributor (single)</option>
                    <option value="custom">Custom emails</option>
                  </select>
                  <select
                    value={sendForm.sender_distributor_id}
                    onChange={(e) => setSendForm((prev) => ({ ...prev, sender_distributor_id: e.target.value }))}
                  >
                    <option value="">Sender mailbox</option>
                    {bootstrap.distributors.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.company_name}
                      </option>
                    ))}
                  </select>
                </div>
                {sendForm.audience_type === "custom" ? (
                  <textarea
                    rows={3}
                    value={sendForm.custom_emails}
                    onChange={(e) => setSendForm((prev) => ({ ...prev, custom_emails: e.target.value }))}
                    placeholder="Enter emails separated by comma"
                  />
                ) : null}
                {sendForm.audience_type === "distributor" ? (
                  <select
                    value={sendForm.distributor_id}
                    onChange={(e) => setSendForm((prev) => ({ ...prev, distributor_id: e.target.value }))}
                  >
                    <option value="">Select distributor</option>
                    {bootstrap.distributors.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.company_name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button type="button" onClick={sendMailer}>
                  Send Mailer
                </button>
              </div>

              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 800 }}>Recent sends</div>
                {logs.slice(0, 12).map((row) => (
                  <div key={row.id} style={{ border: "1px solid #e6ebf2", borderRadius: 14, padding: 12, background: "#fff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 700 }}>{row.to_email}</div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{String(row.sent_at || "").slice(0, 19).replace("T", " ")}</div>
                    </div>
                    <div style={{ marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12, opacity: 0.72 }}>
                      <span>Opens: {row.open_count}</span>
                      <span>Clicks: {row.click_count}</span>
                      {row.error_text ? <span style={{ color: "#9f2042" }}>{row.error_text}</span> : <span style={{ color: "#0b7d45" }}>Sent</span>}
                    </div>
                  </div>
                ))}
                {!logs.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No sends yet.</div> : null}
              </div>
            </DeskCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

