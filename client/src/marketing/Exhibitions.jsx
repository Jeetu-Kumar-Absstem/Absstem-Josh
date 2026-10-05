import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function statusTone(status) {
  if (status === "closed") return { tone: "#effcf3", color: "#0b7d45" };
  if (status === "follow_up" || status === "live") return { tone: "#fff6e8", color: "#8b5a00" };
  return { tone: "#eef4ff", color: "#234a8f" };
}

function parseLeadPaste(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("company") && (lower.includes("contact") || lower.includes("phone") || lower.includes("email"))) {
      continue;
    }
    const parts = line.includes("\t") ? line.split("\t") : line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const cells = parts.map((part) => String(part || "").trim().replace(/^"|"$/g, ""));
    const company_name = cells[0] || "";
    if (!company_name) continue;
    rows.push({
      company_name,
      contact_name: cells[1] || "",
      phone: cells[2] || "",
      email: cells[3] || "",
      designation: cells[4] || "",
    });
  }
  return rows;
}

export default function Exhibitions({ launch = null, onConsumeLaunch = null, onNavigate = null } = {}) {
  const [rows, setRows] = useState([]);
  const [sources, setSources] = useState([]);
  const [distributors, setDistributors] = useState([]);
  const [users, setUsers] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [focusId, setFocusId] = useState(null);
  const [intakeExhibitionId, setIntakeExhibitionId] = useState("");
  const [intakeAssignee, setIntakeAssignee] = useState("");
  const [intakeText, setIntakeText] = useState("");
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [form, setForm] = useState({
    exhibition_name: "",
    collaboration_mode: "company",
    distributor_id: "",
    cost_split_mode: "shared",
    city: "",
    venue: "",
    stall_no: "",
    organizer_name: "",
    lead_source_id: "",
    start_date: "",
    end_date: "",
    planned_budget: "",
    actual_spend: "",
    distributor_spend: "",
    notes: "",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const [exhibitionsData, bootstrapData, usersData] = await Promise.all([
          apiFetch("/marketing/exhibitions"),
          apiFetch("/marketing/bootstrap"),
          apiFetch("/leads/users").catch(() => ({ users: [] })),
        ]);
        if (!active) return;
        setRows(Array.isArray(exhibitionsData?.exhibitions) ? exhibitionsData.exhibitions : []);
        setSources(Array.isArray(bootstrapData?.lead_sources) ? bootstrapData.lead_sources : []);
        setDistributors(Array.isArray(bootstrapData?.distributors) ? bootstrapData.distributors : []);
        setUsers(Array.isArray(usersData?.users) ? usersData.users : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load exhibitions right now."));
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
    const nextFocus = launch.exhibition_id || launch.focusId || "";
    if (nextFocus) {
      setFocusId(String(nextFocus));
      setIntakeExhibitionId(String(nextFocus));
    }
    if (launch.open_intake) {
      setIntakeExhibitionId(String(nextFocus || intakeExhibitionId || ""));
    }
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  const parsedIntake = useMemo(() => parseLeadPaste(intakeText), [intakeText]);

  const stats = useMemo(() => {
    const open = rows.filter((item) => ["upcoming", "live", "follow_up"].includes(item.status)).length;
    const leadCount = rows.reduce((sum, item) => sum + Number(item.lead_count || 0), 0);
    const fruitful = rows.reduce((sum, item) => sum + Number(item.fruitful_leads || 0), 0);
    const spend = rows.reduce((sum, item) => sum + Number(item.total_spend || item.actual_spend || 0), 0);
    return [
      { label: "Open exhibitions", value: String(open), tone: "#8b5a00" },
      { label: "Attributed leads", value: String(leadCount), tone: "#234a8f" },
      { label: "Fruitful leads", value: String(fruitful), tone: "#0b7d45" },
      { label: "Spend tracked", value: `INR ${money(spend)}`, tone: "#7c3aed" },
    ];
  }, [rows]);

  async function createExhibition() {
    if (!form.exhibition_name.trim()) {
      setNotice("Enter an exhibition name before saving.");
      return;
    }
    try {
      const data = await apiFetch("/marketing/exhibitions", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          lead_source_id: form.lead_source_id ? Number(form.lead_source_id) : null,
          distributor_id: form.collaboration_mode === "joint" && form.distributor_id ? Number(form.distributor_id) : null,
          distributor_spend: form.distributor_spend,
        }),
      });
      setRows((current) => [data.exhibition, ...current].filter(Boolean));
      if (data?.exhibition?.id) {
        setFocusId(String(data.exhibition.id));
        setIntakeExhibitionId(String(data.exhibition.id));
      }
      setForm({
        exhibition_name: "",
        collaboration_mode: "company",
        distributor_id: "",
        cost_split_mode: "shared",
        city: "",
        venue: "",
        stall_no: "",
        organizer_name: "",
        lead_source_id: "",
        start_date: "",
        end_date: "",
        planned_budget: "",
        actual_spend: "",
        distributor_spend: "",
        notes: "",
      });
      setNotice("Exhibition saved.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not save exhibition right now."));
    }
  }

  async function updateStatus(id, exhibition_status, message) {
    try {
      const data = await apiFetch(`/marketing/exhibitions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ exhibition_status }),
      });
      setRows((current) => current.map((item) => (item.id === id ? data.exhibition : item)));
      setNotice(message);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update exhibition right now."));
    }
  }

  function openExhibitionLeads(exhibitionId, assignedTo = "") {
    onNavigate?.("leads", {
      resetQuote: true,
      leadsLaunch: {
        exhibitionId: String(exhibitionId || ""),
        campaignId: "",
        assignedTo: assignedTo || "",
        handoff: "",
      },
    });
  }

  async function importLeads() {
    if (!intakeExhibitionId) {
      setNotice("Select an exhibition before importing leads.");
      return;
    }
    if (!parsedIntake.length) {
      setNotice("Paste at least one lead row (company, contact, phone, email).");
      return;
    }
    setIntakeBusy(true);
    setNotice("");
    try {
      const data = await apiFetch("/leads/bulk", {
        method: "POST",
        body: JSON.stringify({
          marketing_exhibition_id: Number(intakeExhibitionId),
          assigned_to: intakeAssignee ? Number(intakeAssignee) : null,
          leads: parsedIntake,
        }),
      });
      const created = Number(data?.created_count || 0);
      const skipped = Number(data?.skipped_count || 0);
      setNotice(`Imported ${created} lead(s)${skipped ? ` · skipped ${skipped}` : ""}.`);
      setIntakeText("");
      const refresh = await apiFetch("/marketing/exhibitions");
      setRows(Array.isArray(refresh?.exhibitions) ? refresh.exhibitions : rows);
      if (created > 0) openExhibitionLeads(intakeExhibitionId);
    } catch (error) {
      if (error?.data?.error === "BULK_LIMIT_100") setNotice("Import limit is 100 leads at a time.");
      else if (error?.data?.error === "ATTRIBUTION_REQUIRED") setNotice("Exhibition attribution is required.");
      else setNotice(getApiErrorMessage(error, "Could not import exhibition leads."));
    } finally {
      setIntakeBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Field Demand"
        title="Exhibitions"
        description="Track exhibition spend, capture booth leads in bulk, and judge each event by business outcome — not visitor traffic."
        stats={stats}
      />

      <NoticeBanner tone="info" message={notice} />

      <div style={{ marginTop: 16 }}>
        <DeskCard
          title="Fair lead intake"
          subtitle="Paste from Excel / WhatsApp lists. Columns: company, contact, phone, email (optional designation). Exhibition is locked on every row."
        >
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1.2fr) minmax(180px, 0.8fr)", gap: 10 }}>
              <select value={intakeExhibitionId} onChange={(e) => setIntakeExhibitionId(e.target.value)}>
                <option value="">Select exhibition</option>
                {rows.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.exhibition_name}
                  </option>
                ))}
              </select>
              <select value={intakeAssignee} onChange={(e) => setIntakeAssignee(e.target.value)}>
                <option value="">Assign later (unassigned)</option>
                {users.map((user) => (
                  <option key={user.id} value={String(user.id)}>
                    {user.full_name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={7}
              value={intakeText}
              onChange={(e) => setIntakeText(e.target.value)}
              placeholder={"Company\tContact\tPhone\tEmail\nAcme Pharma\tRavi Kumar\t98xxxxxxx\travi@acme.com"}
              style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13 }}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button type="button" onClick={importLeads} disabled={intakeBusy}>
                {intakeBusy ? "Importing…" : `Import ${parsedIntake.length || 0} lead(s)`}
              </button>
              {intakeExhibitionId ? (
                <button type="button" onClick={() => openExhibitionLeads(intakeExhibitionId)}>
                  View exhibition leads
                </button>
              ) : null}
              {intakeExhibitionId ? (
                <button type="button" onClick={() => openExhibitionLeads(intakeExhibitionId, "unassigned")}>
                  Unassigned follow-up
                </button>
              ) : null}
              <span style={{ fontSize: 12, opacity: 0.68 }}>Max 100 rows per import · tabs or commas</span>
            </div>
          </div>
        </DeskCard>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(320px, 0.36fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="New Exhibition" subtitle="Create an event source that can feed attributed leads into the sales funnel">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.exhibition_name} onChange={(e) => setForm((current) => ({ ...current, exhibition_name: e.target.value }))} placeholder="Exhibition name" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <select
                value={form.collaboration_mode}
                onChange={(e) =>
                  setForm((current) => ({
                    ...current,
                    collaboration_mode: e.target.value,
                    distributor_id: e.target.value === "joint" ? current.distributor_id : "",
                  }))
                }
              >
                <option value="company">Company-owned</option>
                <option value="joint">Joint with distributor</option>
              </select>
              <select
                value={form.cost_split_mode}
                onChange={(e) => setForm((current) => ({ ...current, cost_split_mode: e.target.value }))}
              >
                <option value="shared">Cost shared</option>
                <option value="company">Company paid</option>
                <option value="distributor">Distributor paid</option>
              </select>
            </div>
            {form.collaboration_mode === "joint" ? (
              <select value={form.distributor_id} onChange={(e) => setForm((current) => ({ ...current, distributor_id: e.target.value }))}>
                <option value="">Select distributor</option>
                {distributors.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.company_name}
                  </option>
                ))}
              </select>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input value={form.city} onChange={(e) => setForm((current) => ({ ...current, city: e.target.value }))} placeholder="City" />
              <input value={form.venue} onChange={(e) => setForm((current) => ({ ...current, venue: e.target.value }))} placeholder="Venue" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input value={form.stall_no} onChange={(e) => setForm((current) => ({ ...current, stall_no: e.target.value }))} placeholder="Stall no." />
              <input value={form.organizer_name} onChange={(e) => setForm((current) => ({ ...current, organizer_name: e.target.value }))} placeholder="Organizer" />
            </div>
            <select value={form.lead_source_id} onChange={(e) => setForm((current) => ({ ...current, lead_source_id: e.target.value }))}>
              <option value="">Lead source</option>
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.source_name}
                </option>
              ))}
            </select>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input type="date" value={form.start_date} onChange={(e) => setForm((current) => ({ ...current, start_date: e.target.value }))} />
              <input type="date" value={form.end_date} onChange={(e) => setForm((current) => ({ ...current, end_date: e.target.value }))} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <input value={form.planned_budget} onChange={(e) => setForm((current) => ({ ...current, planned_budget: e.target.value }))} placeholder="Planned budget" />
              <input value={form.actual_spend} onChange={(e) => setForm((current) => ({ ...current, actual_spend: e.target.value }))} placeholder="Actual spend" />
            </div>
            {form.collaboration_mode === "joint" ? (
              <input
                value={form.distributor_spend}
                onChange={(e) => setForm((current) => ({ ...current, distributor_spend: e.target.value }))}
                placeholder="Distributor spend (optional)"
              />
            ) : null}
            <textarea rows={4} value={form.notes} onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))} placeholder="Notes" />
            <button type="button" onClick={createExhibition}>Save Exhibition</button>
          </div>
        </DeskCard>

        <DeskCard title="Exhibition Performance" subtitle="Event spend, lead capture, quote movement, and order yield">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading exhibitions...</div> : null}
            {rows.map((item) => {
              const tone = statusTone(item.status);
              const isFocused = String(focusId || "") === String(item.id);
              return (
                <div
                  key={item.id}
                  id={`exhibition-${item.id}`}
                  style={{
                    border: isFocused ? "2px solid #c9852a" : "1px solid #e6ebf2",
                    borderRadius: 18,
                    padding: 14,
                    background: isFocused ? "#fffaf0" : "#fff",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.exhibition_name}</div>
                      <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                        {[
                          item.collaboration_mode === "joint" ? "Joint" : null,
                          item.distributor_name ? item.distributor_name : null,
                          item.city,
                          item.venue,
                          item.stall_no ? `Stall ${item.stall_no}` : null,
                        ]
                          .filter(Boolean)
                          .join(" • ")}
                      </div>
                    </div>
                    <DeskChip label={item.status.replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {`Leads ${item.lead_count} • Fruitful ${item.fruitful_leads} • Quotes ${item.quote_count} • Orders ${item.sales_order_count}`}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    {`Spend INR ${money(item.total_spend || item.actual_spend)} / Budget INR ${money(item.planned_budget)} • Quote value INR ${money(item.quote_value)} • Order value INR ${money(item.order_value)}`}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => {
                        setIntakeExhibitionId(String(item.id));
                        setFocusId(String(item.id));
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Lead intake
                    </button>
                    <button type="button" onClick={() => openExhibitionLeads(item.id)}>
                      View leads
                    </button>
                    {item.status === "follow_up" ? (
                      <button type="button" onClick={() => openExhibitionLeads(item.id, "unassigned")}>
                        Unassigned SLA
                      </button>
                    ) : null}
                    {item.status !== "upcoming" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "upcoming", `Exhibition marked upcoming: ${item.exhibition_name}.`)}>
                        Mark Upcoming
                      </button>
                    ) : null}
                    {item.status !== "live" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "live", `Exhibition marked live: ${item.exhibition_name}.`)}>
                        Mark Live
                      </button>
                    ) : null}
                    {item.status !== "follow_up" && item.status !== "closed" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "follow_up", `Exhibition moved to follow-up: ${item.exhibition_name}.`)}>
                        Start Follow-up
                      </button>
                    ) : null}
                    {item.status !== "closed" ? (
                      <button type="button" onClick={() => updateStatus(item.id, "closed", `Exhibition closed: ${item.exhibition_name}.`)}>
                        Close
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!loading && !rows.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No exhibitions yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
