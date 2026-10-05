import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, NoticeBanner, PageHero, getDeskStatusAppearance } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

const STAGES = [
  ["planned", "Planned"],
  ["today", "Today"],
  ["in_progress", "In Progress"],
  ["under_review", "Under Review"],
  ["done", "Done"],
];

function stageTone(stage) {
  return getDeskStatusAppearance(stage, {
    success: ["done"],
    info: ["today", "progress", "review"],
    warning: ["planned"],
    fallbackTone: "#f5f7fb",
  });
}

export default function ActivityPlanner() {
  const [activities, setActivities] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    title: "",
    owner: "",
    department: "HR",
    due: "",
    priority: "medium",
  });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/planner");
        if (!active) return;
        setActivities(Array.isArray(data?.activities) ? data.activities : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load planner activities right now."));
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
    const today = activities.filter((item) => item.stage === "today").length;
    const inProgress = activities.filter((item) => item.stage === "in_progress").length;
    const review = activities.filter((item) => item.stage === "under_review").length;
    const done = activities.filter((item) => item.stage === "done").length;
    return { today, inProgress, review, done };
  }, [activities]);

  async function createActivity() {
    if (!form.title.trim() || !form.owner.trim() || !form.due.trim()) {
      setNotice("Fill title, owner, and due date before adding an activity.");
      return;
    }
    try {
      const data = await apiFetch("/hr/planner", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setActivities((current) => [data.activity, ...current]);
      setForm({ title: "", owner: "", department: "HR", due: "", priority: "medium" });
      setNotice("Activity added to the planner.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not add the activity right now."));
    }
  }

  async function moveActivity(id, nextStage, label, title) {
    try {
      const data = await apiFetch(`/hr/planner/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ stage: nextStage }),
      });
      setActivities((current) => current.map((item) => (item.id === id ? data.activity : item)));
      setNotice(`${title} moved to ${label}.`);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not move the activity right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Daily Work Planning"
        title="Activity Planner"
        description="Plan employee work, track daily follow-up, and move tasks from planned to done through a compact action-driven board."
        stats={[
          { label: "Today", value: String(stats.today), tone: "#234a8f" },
          { label: "In progress", value: String(stats.inProgress), tone: "#8b5a00" },
          { label: "Under review", value: String(stats.review), tone: "#9f2042" },
          { label: "Done", value: String(stats.done), tone: "#147a3d" },
        ]}
      />

      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(300px, 0.32fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="Add Activity" subtitle="Use this for daily plans, follow-up actions, and internal task tracking">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.title} onChange={(e) => setForm((current) => ({ ...current, title: e.target.value }))} placeholder="Activity title" />
            <input value={form.owner} onChange={(e) => setForm((current) => ({ ...current, owner: e.target.value }))} placeholder="Owner or team" />
            <select value={form.department} onChange={(e) => setForm((current) => ({ ...current, department: e.target.value }))}>
              <option value="HR">HR</option>
              <option value="Sales">Sales</option>
              <option value="Service">Service</option>
              <option value="Accounts">Accounts</option>
              <option value="Manufacturing">Manufacturing</option>
            </select>
            <input type="date" value={form.due} onChange={(e) => setForm((current) => ({ ...current, due: e.target.value }))} />
            <select value={form.priority} onChange={(e) => setForm((current) => ({ ...current, priority: e.target.value }))}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <button type="button" onClick={createActivity}>Add Activity</button>
          </div>
        </DeskCard>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12 }}>
          {STAGES.map(([stageKey, stageLabel]) => (
            <DeskCard key={stageKey} title={stageLabel} subtitle="Planner lane">
              <div style={{ display: "grid", gap: 10 }}>
                {activities.filter((item) => item.stage === stageKey).map((item) => {
                  const tone = stageTone(item.stage);
                  return (
                    <div
                      key={item.id}
                      style={{
                        border: "1px solid #e6ebf2",
                        borderRadius: 16,
                        padding: 12,
                        background: "#ffffff",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                        <div>
                          <div style={{ fontWeight: 800 }}>{item.title}</div>
                          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                            {[item.owner, item.department, item.due].filter(Boolean).join(" • ")}
                          </div>
                        </div>
                        <DeskChip label={item.priority} tone={tone.tone} color={tone.color} />
                      </div>
                      <div style={{ display: "grid", gap: 6 }}>
                        {STAGES.filter(([candidate]) => candidate !== stageKey).map(([candidate, label]) => (
                          <button key={candidate} type="button" onClick={() => moveActivity(item.id, candidate, label, item.title)}>
                            Move To {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {loading ? <div style={{ fontSize: 13, opacity: 0.66 }}>Loading...</div> : null}
                {!loading && !activities.some((item) => item.stage === stageKey) ? <div style={{ fontSize: 13, opacity: 0.66 }}>No activities here.</div> : null}
              </div>
            </DeskCard>
          ))}
        </div>
      </div>
    </div>
  );
}
