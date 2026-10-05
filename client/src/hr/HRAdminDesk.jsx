import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "../hr/api";
import HrOffboardingDesk from "./HrOffboardingDesk";

function personLabel(u) {
  if (!u) return "";
  const name = u.full_name || u.email || `User ${u.id}`;
  return u.user_code ? `${name} (${u.user_code})` : name;
}

const SKILL_LEVELS = ["Aware", "Trained", "Competent", "Expert", "Assessor"];
const SKILL_SUGGESTIONS = [
  "PSA Installation",
  "Welding Inspection",
  "Civil QA",
  "Commissioning",
  "Electrical Safety",
  "Oxygen Plant Ops",
  "Nitrogen Plant Ops",
];

const DELEGATION_MODULES = [
  { key: "hr", label: "HR (desk, attendance, leave, salary…)" },
  { key: "office", label: "Office Admin (assets & visitors)" },
  { key: "service", label: "Field service / aftermarket" },
];

const LEVEL_TONE = {
  Aware: { tone: "#f3f4f6", color: "#4b5563" },
  Trained: { tone: "#eef4ff", color: "#234a8f" },
  Competent: { tone: "#effcf3", color: "#0b7d45" },
  Expert: { tone: "#fff6e8", color: "#8b5a00" },
  Assessor: { tone: "#f5efff", color: "#6d28d9" },
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

export default function HRAdminDesk() {
  const [tab, setTab] = useState("skills");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [people, setPeople] = useState([]);

  const [skills, setSkills] = useState([]);
  const [skillFilter, setSkillFilter] = useState("");
  const [showSkillModal, setShowSkillModal] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null);
  const [skillForm, setSkillForm] = useState({
    user_id: "",
    skill_category: "",
    certification_level: "Trained",
    last_evaluated_date: "",
    notes: "",
  });
  const [savingSkill, setSavingSkill] = useState(false);

  const [delegateForm, setDelegateForm] = useState({
    from_user_id: "",
    to_user_id: "",
    modules: [],
    notes: "",
  });
  const [delegating, setDelegating] = useState(false);

  const [alerts, setAlerts] = useState([]);

  const loadPeople = useCallback(async () => {
    try {
      const data = await apiFetch("/hr/people?include_inactive=1");
      setPeople(Array.isArray(data?.people) ? data.people : []);
    } catch {
      setPeople([]);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (skillFilter.trim()) params.set("skill_category", skillFilter.trim());
      const qs = params.toString();
      const data = await apiFetch(`/hr/skills${qs ? `?${qs}` : ""}`);
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not load skill matrix."));
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [skillFilter]);

  const loadAlerts = useCallback(async () => {
    try {
      const data = await apiFetch("/hr/transitions/alerts");
      setAlerts(Array.isArray(data?.alerts) ? data.alerts : []);
    } catch {
      setAlerts([]);
    }
  }, []);

  useEffect(() => {
    loadPeople().catch(() => {});
  }, [loadPeople]);

  useEffect(() => {
    if (tab === "skills") loadSkills().catch(() => {});
    if (tab === "transitions" || tab === "offboarding") loadAlerts().catch(() => {});
  }, [tab, loadSkills, loadAlerts]);

  const activePeople = useMemo(() => people.filter((p) => p.is_active !== false), [people]);

  const stats = useMemo(() => {
    const experts = skills.filter((s) => s.certification_level === "Expert" || s.certification_level === "Assessor").length;
    const peopleWithSkills = new Set(skills.map((s) => s.user_id)).size;
    return [
      { label: "Skill rows", value: String(skills.length), tone: "#234a8f" },
      { label: "People covered", value: String(peopleWithSkills), tone: "#0b7d45" },
      { label: "Expert / Assessor", value: String(experts), tone: "#8b5a00" },
      { label: "Open offboard alerts", value: String(alerts.length), tone: "#9f2042" },
    ];
  }, [skills, alerts.length]);

  function openCreateSkill() {
    setEditingSkill(null);
    setSkillForm({
      user_id: "",
      skill_category: "",
      certification_level: "Trained",
      last_evaluated_date: new Date().toISOString().slice(0, 10),
      notes: "",
    });
    setShowSkillModal(true);
  }

  function openEditSkill(skill) {
    setEditingSkill(skill);
    setSkillForm({
      user_id: String(skill.user_id),
      skill_category: skill.skill_category || "",
      certification_level: skill.certification_level || "Trained",
      last_evaluated_date: skill.last_evaluated_date ? String(skill.last_evaluated_date).slice(0, 10) : "",
      notes: skill.notes || "",
    });
    setShowSkillModal(true);
  }

  async function saveSkill() {
    if (!skillForm.user_id || !skillForm.skill_category.trim()) {
      setError("Select a person and skill category.");
      return;
    }
    setSavingSkill(true);
    setError("");
    setNotice("");
    try {
      if (editingSkill?.id) {
        await apiFetch(`/hr/skills/${editingSkill.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            skill_category: skillForm.skill_category.trim(),
            certification_level: skillForm.certification_level,
            last_evaluated_date: skillForm.last_evaluated_date || null,
            notes: skillForm.notes || null,
          }),
        });
        setNotice("Skill updated.");
      } else {
        await apiFetch("/hr/skills", {
          method: "POST",
          body: JSON.stringify({
            user_id: Number(skillForm.user_id),
            skill_category: skillForm.skill_category.trim(),
            certification_level: skillForm.certification_level,
            last_evaluated_date: skillForm.last_evaluated_date || null,
            notes: skillForm.notes || null,
          }),
        });
        setNotice("Skill recorded.");
      }
      setShowSkillModal(false);
      await loadSkills();
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not save skill."));
    } finally {
      setSavingSkill(false);
    }
  }

  function toggleModule(key) {
    setDelegateForm((current) => {
      const has = current.modules.includes(key);
      return {
        ...current,
        modules: has ? current.modules.filter((m) => m !== key) : [...current.modules, key],
      };
    });
  }

  async function submitDelegate() {
    if (!delegateForm.from_user_id || !delegateForm.to_user_id) {
      setError("Select Transfer From and Transfer To.");
      return;
    }
    if (delegateForm.from_user_id === delegateForm.to_user_id) {
      setError("From and To must be different people.");
      return;
    }
    if (!delegateForm.modules.length) {
      setError("Select at least one module to delegate.");
      return;
    }
    setDelegating(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/hr/transitions/delegate", {
        method: "POST",
        body: JSON.stringify({
          from_user_id: Number(delegateForm.from_user_id),
          to_user_id: Number(delegateForm.to_user_id),
          modules: delegateForm.modules,
          notes: delegateForm.notes || null,
        }),
      });
      const keys = data?.delegation?.screen_keys || [];
      setNotice(`Rights delegated (${keys.length} screen${keys.length === 1 ? "" : "s"}).`);
      setDelegateForm({ from_user_id: "", to_user_id: "", modules: [], notes: "" });
    } catch (err) {
      setError(getApiErrorMessage(err, "Delegation failed."));
    } finally {
      setDelegating(false);
    }
  }

  async function resolveAlert(id) {
    try {
      await apiFetch(`/hr/transitions/alerts/${id}/resolve`, { method: "POST", body: "{}" });
      await loadAlerts();
      setNotice("Alert marked resolved.");
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not resolve alert."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="People governance"
        title="HR Admin"
        description="Maintain engineering skill matrices and run secure administrative handovers / offboarding."
        stats={stats}
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12, marginBottom: 8 }}>
        <button type="button" style={tabBtn(tab === "skills")} onClick={() => setTab("skills")}>
          Engineering Skill Matrix
        </button>
        <button type="button" style={tabBtn(tab === "transitions")} onClick={() => setTab("transitions")}>
          Transitions &amp; Delegation
        </button>
        <button type="button" style={tabBtn(tab === "offboarding")} onClick={() => setTab("offboarding")}>
          Offboarding Protocol
        </button>
      </div>

      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}

      {tab === "skills" ? (
        <DeskCard
          title="Engineering & field skill matrix"
          subtitle="Qualification foundation for commissioning and dispatch assignment"
          actions={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                placeholder="Filter skill category"
                value={skillFilter}
                onChange={(e) => setSkillFilter(e.target.value)}
                style={{ minWidth: 180 }}
              />
              <button type="button" onClick={() => loadSkills()} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </button>
              <button type="button" onClick={openCreateSkill}>
                Add / update skill
              </button>
            </div>
          }
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e6ebf2" }}>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Person</th>
                  <th style={{ padding: "10px 8px", textAlign: "left" }}>Skill</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 120 }}>Level</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 130 }}>Last evaluated</th>
                  <th style={{ padding: "10px 8px", textAlign: "left", width: 140 }}>Evaluator</th>
                  <th style={{ padding: "10px 8px", textAlign: "center", width: 80 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((skill) => {
                  const tone = LEVEL_TONE[skill.certification_level] || LEVEL_TONE.Trained;
                  return (
                    <tr key={skill.id} style={{ borderBottom: "1px solid #f0f3f8" }}>
                      <td style={{ padding: "10px 8px", fontWeight: 700 }}>
                        {skill.full_name || skill.email}
                      </td>
                      <td style={{ padding: "10px 8px" }}>{skill.skill_category}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <DeskChip label={skill.certification_level} tone={tone.tone} color={tone.color} />
                      </td>
                      <td style={{ padding: "10px 8px" }}>
                        {skill.last_evaluated_date ? String(skill.last_evaluated_date).slice(0, 10) : "—"}
                      </td>
                      <td style={{ padding: "10px 8px" }}>{skill.evaluated_by_name || "—"}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <button type="button" className="button-ghost" onClick={() => openEditSkill(skill)}>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && !skills.length ? (
              <div style={{ padding: 16, fontSize: 13, opacity: 0.66 }}>
                No skills recorded yet. Add PSA Installation, Welding Inspection, and related certifications.
              </div>
            ) : null}
          </div>
        </DeskCard>
      ) : null}

      {tab === "transitions" ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.4fr)", gap: 16, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 16 }}>
            <DeskCard title="Delegate admin rights" subtitle="Transfer screen overrides / module packs to a successor">
              <div style={{ display: "grid", gap: 12 }}>
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Transfer From
                  <select
                    value={delegateForm.from_user_id}
                    onChange={(e) => setDelegateForm((c) => ({ ...c, from_user_id: e.target.value }))}
                  >
                    <option value="">Select exiting administrator…</option>
                    {people.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {personLabel(p)}
                        {p.is_active === false ? " (inactive)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Transfer To
                  <select
                    value={delegateForm.to_user_id}
                    onChange={(e) => setDelegateForm((c) => ({ ...c, to_user_id: e.target.value }))}
                  >
                    <option value="">Select successor…</option>
                    {activePeople.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {personLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Modules / rights packs</div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {DELEGATION_MODULES.map((mod) => (
                      <label key={mod.key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={delegateForm.modules.includes(mod.key)}
                          onChange={() => toggleModule(mod.key)}
                        />
                        {mod.label}
                      </label>
                    ))}
                  </div>
                </div>
                <textarea
                  rows={3}
                  placeholder="Handover notes (optional)"
                  value={delegateForm.notes}
                  onChange={(e) => setDelegateForm((c) => ({ ...c, notes: e.target.value }))}
                />
                <button type="button" onClick={submitDelegate} disabled={delegating}>
                  {delegating ? "Delegating…" : "Delegate rights"}
                </button>
              </div>
            </DeskCard>

            <DeskCard title="Offboarding Transfer Protocol" subtitle="Secure step-by-step exit with dependency routing">
              <div style={{ fontSize: 13, opacity: 0.78, lineHeight: 1.55, marginBottom: 12 }}>
                Full work transfer (sales orders, commissioning, reports, rights) lives under the Offboarding Protocol
                tab — not the lightweight asset-only revoke.
              </div>
              <button type="button" onClick={() => setTab("offboarding")}>
                Open Offboarding Protocol
              </button>
            </DeskCard>
          </div>

          <DeskCard title="Offboarding alerts" subtitle="Pending rights without a successor">
            <div style={{ display: "grid", gap: 10 }}>
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  style={{
                    border: "1px solid #f0b7c1",
                    borderRadius: 14,
                    padding: 12,
                    background: "#fff2f4",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: 13 }}>{alert.full_name || alert.email}</div>
                  <div style={{ fontSize: 12, opacity: 0.8, lineHeight: 1.45 }}>{alert.message}</div>
                  <button type="button" className="button-ghost" onClick={() => resolveAlert(alert.id)}>
                    Mark resolved
                  </button>
                </div>
              ))}
              {!alerts.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No open alerts.</div> : null}
            </div>
          </DeskCard>
        </div>
      ) : null}

      {tab === "offboarding" ? (
        <HrOffboardingDesk
          embedded
          onCompleted={() => {
            setNotice("Offboarding Transfer Protocol completed.");
            loadAlerts().catch(() => {});
            loadPeople().catch(() => {});
          }}
        />
      ) : null}

      {showSkillModal ? (
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
          onClick={() => !savingSkill && setShowSkillModal(false)}
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
            <div style={{ fontWeight: 900, fontSize: 18 }}>{editingSkill ? "Update skill" : "Add skill"}</div>
            <select
              value={skillForm.user_id}
              disabled={Boolean(editingSkill)}
              onChange={(e) => setSkillForm((c) => ({ ...c, user_id: e.target.value }))}
            >
              <option value="">Select person…</option>
              {activePeople.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {personLabel(p)}
                </option>
              ))}
            </select>
            <input
              list="hr-skill-suggestions"
              placeholder="Skill category (e.g. PSA Installation)"
              value={skillForm.skill_category}
              onChange={(e) => setSkillForm((c) => ({ ...c, skill_category: e.target.value }))}
            />
            <datalist id="hr-skill-suggestions">
              {SKILL_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <select
              value={skillForm.certification_level}
              onChange={(e) => setSkillForm((c) => ({ ...c, certification_level: e.target.value }))}
            >
              {SKILL_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={skillForm.last_evaluated_date}
              onChange={(e) => setSkillForm((c) => ({ ...c, last_evaluated_date: e.target.value }))}
            />
            <textarea
              rows={3}
              placeholder="Notes"
              value={skillForm.notes}
              onChange={(e) => setSkillForm((c) => ({ ...c, notes: e.target.value }))}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="button-ghost" onClick={() => setShowSkillModal(false)} disabled={savingSkill}>
                Cancel
              </button>
              <button type="button" onClick={saveSkill} disabled={savingSkill}>
                {savingSkill ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
