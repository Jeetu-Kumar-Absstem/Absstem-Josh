import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, NoticeBanner, PageHero, toast } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "../hr/api";

function personLabel(u) {
  if (!u) return "";
  const name = u.full_name || u.email || `User ${u.id}`;
  return u.user_code ? `${name} (${u.user_code})` : name;
}

const STEPS = [
  { key: "select", label: "1 · Select" },
  { key: "dependencies", label: "2 · Dependencies" },
  { key: "reassign", label: "3 · Reassign" },
  { key: "confirm", label: "4 · Confirm" },
];

const stepChip = (active, done) => ({
  border: active ? "1px solid var(--absstem-primary, #00509E)" : "1px solid #dfe5ef",
  background: done ? "rgba(0, 80, 158, 0.08)" : active ? "#eef4ff" : "#fff",
  color: active || done ? "var(--absstem-primary, #00509E)" : "#64748b",
  fontWeight: active ? 800 : 600,
  borderRadius: 999,
  padding: "7px 12px",
  fontSize: 12,
});

const selectStyle = {
  width: "100%",
  minHeight: 40,
  borderRadius: 10,
  border: "1px solid #d0d7e2",
  padding: "8px 10px",
  fontSize: 13,
  background: "#fff",
};

export default function HrOffboardingDesk({ embedded = false, onCompleted } = {}) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [people, setPeople] = useState([]);
  const [peopleLoading, setPeopleLoading] = useState(false);

  const [selectedUserId, setSelectedUserId] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [reassignments, setReassignments] = useState({});
  const [notes, setNotes] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [alerts, setAlerts] = useState([]);

  const loadPeople = useCallback(async () => {
    setPeopleLoading(true);
    try {
      const data = await apiFetch("/hr/people?include_inactive=1");
      setPeople(Array.isArray(data?.people) ? data.people : []);
    } catch (err) {
      setPeople([]);
      const msg = getApiErrorMessage(err, "Could not load people directory.");
      setError(msg);
      toast(msg, "error");
    } finally {
      setPeopleLoading(false);
    }
  }, []);

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
    loadAlerts().catch(() => {});
  }, [loadPeople, loadAlerts]);

  const activePeople = useMemo(() => people.filter((p) => p.is_active !== false), [people]);
  const selectedUser = useMemo(
    () => activePeople.find((p) => String(p.id) === String(selectedUserId)) || preview?.user || null,
    [activePeople, selectedUserId, preview]
  );
  const successorOptions = useMemo(
    () => activePeople.filter((p) => String(p.id) !== String(selectedUserId)),
    [activePeople, selectedUserId]
  );

  const requiredGroups = useMemo(
    () => (Array.isArray(preview?.groups) ? preview.groups.filter((g) => g.required) : []),
    [preview]
  );
  const infoGroups = useMemo(
    () => (Array.isArray(preview?.groups) ? preview.groups.filter((g) => !g.required && g.count > 0) : []),
    [preview]
  );

  const mappingsComplete = useMemo(() => {
    if (!preview) return false;
    return requiredGroups.every((g) => {
      const sid = Number(reassignments[g.key]);
      return Number.isFinite(sid) && sid > 0 && String(sid) !== String(selectedUserId);
    });
  }, [preview, requiredGroups, reassignments, selectedUserId]);

  const emailMatches = useMemo(() => {
    const expected = String(selectedUser?.email || "").trim().toLowerCase();
    return Boolean(expected) && String(confirmEmail).trim().toLowerCase() === expected;
  }, [selectedUser, confirmEmail]);

  const currentStep = !selectedUserId
    ? "select"
    : previewLoading || !preview
      ? "dependencies"
      : !mappingsComplete
        ? "reassign"
        : "confirm";

  async function runDependencyCheck(userId) {
    if (!userId) {
      setPreview(null);
      setReassignments({});
      return;
    }
    setPreviewLoading(true);
    setError("");
    setNotice("");
    setConfirmOpen(false);
    setConfirmEmail("");
    try {
      const data = await apiFetch(`/hr/users/${userId}/offboard-preview`);
      setPreview(data);
      setReassignments({});
      const blocking = Array.isArray(data?.blocking_group_keys) ? data.blocking_group_keys.length : 0;
      if (blocking === 0) {
        setNotice("No blocking dependencies. You may proceed to confirmation after reviewing the inventory.");
      } else {
        setNotice(`Found ${blocking} responsibility group(s) that require a successor before deactivation.`);
      }
    } catch (err) {
      setPreview(null);
      const msg = getApiErrorMessage(err, "Dependency check failed.");
      setError(msg);
      toast(msg, "error");
    } finally {
      setPreviewLoading(false);
    }
  }

  function onSelectUser(nextId) {
    setSelectedUserId(nextId);
    setPreview(null);
    setReassignments({});
    setConfirmOpen(false);
    setConfirmEmail("");
    setError("");
    setNotice("");
    if (nextId) runDependencyCheck(nextId).catch(() => {});
  }

  function setSuccessor(groupKey, value) {
    setReassignments((prev) => ({ ...prev, [groupKey]: value }));
  }

  async function submitOffboard() {
    if (!selectedUserId || !mappingsComplete || !emailMatches) return;
    setSubmitting(true);
    setError("");
    try {
      const payload = {
        reassignments: Object.fromEntries(
          Object.entries(reassignments)
            .filter(([, v]) => v)
            .map(([k, v]) => [k, Number(v)])
        ),
        confirm_email: String(confirmEmail).trim(),
        notes: notes || null,
      };
      const data = await apiFetch(`/hr/users/${selectedUserId}/offboard`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const released = data?.offboard?.assets_released?.length || 0;
      const msg = `Offboarding complete. Access revoked; ${released} asset(s) released; work transferred.`;
      setNotice(msg);
      toast(msg, "success");
      setConfirmOpen(false);
      setConfirmEmail("");
      setSelectedUserId("");
      setPreview(null);
      setReassignments({});
      setNotes("");
      await loadPeople();
      await loadAlerts();
      if (typeof onCompleted === "function") onCompleted(data);
    } catch (err) {
      const msg = getApiErrorMessage(err, "Offboarding failed.");
      setError(msg);
      toast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function resolveAlert(id) {
    try {
      await apiFetch(`/hr/transitions/alerts/${id}/resolve`, { method: "POST", body: "{}" });
      await loadAlerts();
      toast("Alert marked resolved.", "success");
    } catch (err) {
      const msg = getApiErrorMessage(err, "Could not resolve alert.");
      setError(msg);
      toast(msg, "error");
    }
  }

  const deactivateEnabled = Boolean(preview) && !previewLoading && mappingsComplete && !submitting;

  return (
    <div style={{ maxWidth: embedded ? "100%" : 1480 }}>
      {!embedded ? (
        <PageHero
          eyebrow="People governance"
          title="Offboarding Transfer Protocol"
          description="Rigid pre-flight dependency check, mandatory successor routing, then high-friction confirmation before access revoke."
          stats={[
            { label: "Open alerts", value: String(alerts.length), tone: "var(--absstem-industrial-red, #E30513)" },
            {
              label: "Blocking groups",
              value: preview ? String(requiredGroups.length) : "—",
              tone: "var(--absstem-primary, #00509E)",
            },
          ]}
        />
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: embedded ? 0 : 12, marginBottom: 12 }}>
        {STEPS.map((step) => {
          const idx = STEPS.findIndex((s) => s.key === step.key);
          const curIdx = STEPS.findIndex((s) => s.key === currentStep);
          return (
            <span key={step.key} style={stepChip(step.key === currentStep, idx < curIdx)}>
              {step.label}
            </span>
          );
        })}
      </div>

      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 0.38fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 16 }}>
          <DeskCard
            title="Step 1 — Select departing employee"
            subtitle="Protocol starts only after an active user is chosen"
            actions={
              <button type="button" className="button-ghost" onClick={() => loadPeople()} disabled={peopleLoading}>
                {peopleLoading ? "Loading…" : "Refresh directory"}
              </button>
            }
          >
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              Employee to offboard
              <select
                style={selectStyle}
                value={selectedUserId}
                onChange={(e) => onSelectUser(e.target.value)}
                disabled={submitting}
              >
                <option value="">Select active employee…</option>
                {activePeople.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {personLabel(p)}
                    {p.email ? ` · ${p.email}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {selectedUser ? (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid #dfe5ef",
                  background: "#f8fafc",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 800 }}>{personLabel(selectedUser)}</div>
                <div style={{ opacity: 0.75 }}>{selectedUser.email || "No email on record"}</div>
              </div>
            ) : null}
          </DeskCard>

          <DeskCard
            title="Step 2 — Dependency check"
            subtitle="Pre-flight inventory of active responsibilities"
            actions={
              selectedUserId ? (
                <button
                  type="button"
                  className="button-ghost"
                  onClick={() => runDependencyCheck(selectedUserId)}
                  disabled={previewLoading || submitting}
                >
                  {previewLoading ? "Checking…" : "Re-run check"}
                </button>
              ) : null
            }
          >
            {!selectedUserId ? (
              <div style={{ fontSize: 13, opacity: 0.66 }}>Select an employee to run the dependency scan.</div>
            ) : previewLoading ? (
              <div style={{ fontSize: 13, opacity: 0.66 }}>Scanning sales, commissioning, reports, and rights…</div>
            ) : preview ? (
              <div style={{ display: "grid", gap: 12 }}>
                {(preview.groups || []).map((group) => (
                  <div
                    key={group.key}
                    style={{
                      border: group.required
                        ? "1px solid color-mix(in srgb, var(--absstem-industrial-red, #E30513) 35%, #f0b7c1)"
                        : "1px solid #e2e8f0",
                      borderRadius: 14,
                      padding: 12,
                      background: group.required ? "rgba(227, 5, 19, 0.04)" : "#fff",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 14 }}>{group.label}</div>
                        {group.description ? (
                          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{group.description}</div>
                        ) : null}
                      </div>
                      <DeskChip
                        label={`${group.count}`}
                        tone={group.required ? "rgba(227, 5, 19, 0.12)" : "#eef4ff"}
                        color={group.required ? "var(--absstem-industrial-red, #E30513)" : "var(--absstem-primary, #00509E)"}
                      />
                    </div>
                    {group.required ? (
                      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "var(--absstem-industrial-red, #E30513)" }}>
                        Successor mapping required
                      </div>
                    ) : group.count > 0 ? (
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>Informational — no successor required</div>
                    ) : (
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.55 }}>Clear</div>
                    )}
                    {Array.isArray(group.items) && group.items.length ? (
                      <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12, lineHeight: 1.45 }}>
                        {group.items.map((item) => (
                          <li key={`${group.key}-${item.id}`}>
                            <span style={{ fontWeight: 700 }}>{item.label}</span>
                            {item.detail ? <span style={{ opacity: 0.7 }}> — {item.detail}</span> : null}
                          </li>
                        ))}
                        {group.count > group.items.length ? (
                          <li style={{ opacity: 0.65 }}>+{group.count - group.items.length} more</li>
                        ) : null}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, opacity: 0.66 }}>No preview yet.</div>
            )}
          </DeskCard>

          <DeskCard
            title="Step 3 — Mandatory reassignment routing"
            subtitle="Map every blocking group to an active successor before Deactivate unlocks"
          >
            {!preview ? (
              <div style={{ fontSize: 13, opacity: 0.66 }}>Complete the dependency check first.</div>
            ) : !requiredGroups.length ? (
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                No blocking inheritance groups. Informational items
                {infoGroups.length ? ` (${infoGroups.map((g) => g.label).join(", ")})` : ""} will be handled automatically
                on confirm.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {requiredGroups.map((group) => (
                  <label key={group.key} style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                    {group.label}
                    <span style={{ fontWeight: 500, opacity: 0.7, fontSize: 12 }}>
                      {group.count} item{group.count === 1 ? "" : "s"} → successor
                    </span>
                    <select
                      style={selectStyle}
                      value={reassignments[group.key] || ""}
                      onChange={(e) => setSuccessor(group.key, e.target.value)}
                      disabled={submitting}
                    >
                      <option value="">Select successor…</option>
                      {successorOptions.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {personLabel(p)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
                  Handover notes (optional)
                  <textarea
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Context for audit trail"
                    disabled={submitting}
                    style={{ ...selectStyle, minHeight: 72, resize: "vertical" }}
                  />
                </label>
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                disabled={!deactivateEnabled}
                onClick={() => {
                  setConfirmEmail("");
                  setConfirmOpen(true);
                }}
                style={{
                  background: deactivateEnabled ? "var(--absstem-industrial-red, #E30513)" : "#cbd5e1",
                  color: "#fff",
                  border: deactivateEnabled
                    ? "1px solid color-mix(in srgb, var(--absstem-industrial-red, #E30513) 80%, #000)"
                    : "1px solid #94a3b8",
                  fontWeight: 800,
                  borderRadius: 12,
                  padding: "10px 16px",
                  cursor: deactivateEnabled ? "pointer" : "not-allowed",
                  opacity: deactivateEnabled ? 1 : 0.75,
                }}
              >
                Deactivate…
              </button>
              {!mappingsComplete && preview ? (
                <span style={{ fontSize: 12, color: "#7f1834", fontWeight: 700 }}>
                  Fill every required successor mapping to unlock Deactivate.
                </span>
              ) : null}
            </div>
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

      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="offboard-confirm-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            zIndex: 90,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={() => !submitting && setConfirmOpen(false)}
        >
          <div
            style={{
              width: "min(520px, 100%)",
              borderRadius: 18,
              background: "#fff",
              border: "2px solid var(--absstem-industrial-red, #E30513)",
              padding: 20,
              display: "grid",
              gap: 12,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div id="offboard-confirm-title" style={{ fontWeight: 900, fontSize: 18, color: "var(--absstem-industrial-red, #E30513)" }}>
              Confirm Offboarding &amp; Revoke Access
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.55,
                background: "#fff2f4",
                border: "1px solid #f0b7c1",
                borderRadius: 12,
                padding: 12,
                color: "#7f1834",
              }}
            >
              This will transfer mapped responsibilities, release assigned office assets, wipe active sessions, and
              permanently deactivate <strong>{personLabel(selectedUser)}</strong>.
            </div>
            {requiredGroups.length ? (
              <div style={{ fontSize: 12, lineHeight: 1.5, display: "grid", gap: 4 }}>
                {requiredGroups.map((g) => {
                  const succ = successorOptions.find((p) => String(p.id) === String(reassignments[g.key]));
                  return (
                    <div key={g.key}>
                      <strong>{g.label}</strong> → {succ ? personLabel(succ) : "—"}
                    </div>
                  );
                })}
              </div>
            ) : null}
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              Type departing user email to enable confirm
              <input
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                placeholder={selectedUser?.email || "email@company.com"}
                autoComplete="off"
                spellCheck={false}
                disabled={submitting}
                style={selectStyle}
              />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" className="button-ghost" onClick={() => setConfirmOpen(false)} disabled={submitting}>
                Cancel
              </button>
              <button
                type="button"
                onClick={submitOffboard}
                disabled={submitting || !emailMatches}
                style={{
                  background: emailMatches ? "var(--absstem-industrial-red, #E30513)" : "#cbd5e1",
                  color: "#fff",
                  border: emailMatches
                    ? "1px solid color-mix(in srgb, var(--absstem-industrial-red, #E30513) 80%, #000)"
                    : "1px solid #94a3b8",
                  fontWeight: 800,
                  borderRadius: 10,
                  padding: "8px 14px",
                  cursor: emailMatches && !submitting ? "pointer" : "not-allowed",
                }}
              >
                {submitting ? "Offboarding…" : "Confirm Offboarding & Revoke Access"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
