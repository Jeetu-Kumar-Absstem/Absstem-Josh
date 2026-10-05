import { useCallback, useEffect, useState } from "react";

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

const STATUS_STYLE = {
  Draft: { tone: "#f6f7fb", color: "#58627a" },
  Client_Submitted: { tone: "#fff7ea", color: "#8b5a00" },
  Approved: { tone: "#eefbf3", color: "#0b7d45" },
  Rejected: { tone: "#fff2f2", color: "#a52323" },
};

function canApproveReadiness(me) {
  if (!me) return false;
  if (me.group_name === "SuperAdmin") return true;
  const screens = me.permissions?.screens || {};
  return Boolean(
    screens.field_service?.can_approve ||
      screens.sales_orders?.can_approve ||
      screens.dispatches?.can_approve
  );
}

function canEditReadiness(me) {
  if (!me) return false;
  if (me.group_name === "SuperAdmin") return true;
  const screens = me.permissions?.screens || {};
  return Boolean(
    screens.field_service?.can_edit ||
      screens.sales_orders?.can_edit ||
      screens.dispatches?.can_edit ||
      screens.field_service?.can_create ||
      screens.sales_orders?.can_create
  );
}

/**
 * Sales Order / Ops panel — site readiness gate before dispatch.
 */
export default function SiteReadinessPanel({ me, salesOrderId, onStatusChange }) {
  const [checklist, setChecklist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [flags, setFlags] = useState({
    electrical_ready: false,
    civil_ready: false,
    pneumatic_ready: false,
  });

  const refresh = useCallback(async () => {
    if (!salesOrderId) return;
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/field-service/site-readiness?sales_order_id=${encodeURIComponent(salesOrderId)}`);
      const row = data?.checklist || null;
      setChecklist(row);
      setFlags({
        electrical_ready: Boolean(row?.electrical_ready),
        civil_ready: Boolean(row?.civil_ready),
        pneumatic_ready: Boolean(row?.pneumatic_ready),
      });
      onStatusChange?.(row?.status || null);
    } catch (err) {
      setError(err?.data?.error || err?.data?.detail || "Failed to load site readiness.");
      onStatusChange?.(null);
    } finally {
      setLoading(false);
    }
  }, [salesOrderId, onStatusChange]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  async function createChecklist() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/field-service/site-readiness", {
        method: "POST",
        body: JSON.stringify({ sales_order_id: Number(salesOrderId), ...flags }),
      });
      setChecklist(data.checklist);
      onStatusChange?.(data.checklist?.status || null);
      setNotice("Site readiness checklist created.");
    } catch (err) {
      if (err?.data?.error === "CHECKLIST_EXISTS" && err?.data?.checklist) {
        setChecklist(err.data.checklist);
        onStatusChange?.(err.data.checklist?.status || null);
      } else {
        setError(err?.data?.error || err?.data?.detail || "Failed to create checklist.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveFlags(nextFlags, nextStatus) {
    if (!checklist?.id) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch(`/field-service/site-readiness/${checklist.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...nextFlags, status: nextStatus || checklist.status }),
      });
      setChecklist(data.checklist);
      setFlags({
        electrical_ready: Boolean(data.checklist?.electrical_ready),
        civil_ready: Boolean(data.checklist?.civil_ready),
        pneumatic_ready: Boolean(data.checklist?.pneumatic_ready),
      });
      onStatusChange?.(data.checklist?.status || null);
      setNotice(nextStatus === "Approved" ? "Site readiness approved — dispatch unlocked." : "Saved.");
    } catch (err) {
      setError(err?.data?.detail || err?.data?.error || "Failed to update site readiness.");
    } finally {
      setSaving(false);
    }
  }

  const status = checklist?.status || "—";
  const style = STATUS_STYLE[status] || STATUS_STYLE.Draft;
  const approved = status === "Approved";
  const editable = canEditReadiness(me) && !approved;
  const canApprove = canApproveReadiness(me) && checklist && !approved;
  const allReady = flags.electrical_ready && flags.civil_ready && flags.pneumatic_ready;

  return (
    <div
      style={{
        border: "1px solid #dce6f5",
        borderRadius: 18,
        padding: 14,
        background: approved ? "linear-gradient(180deg, #f3fff7 0%, #ffffff 100%)" : "linear-gradient(180deg, #ffffff 0%, #f7faff 100%)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.58 }}>Site readiness</div>
          <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6, lineHeight: 1.5 }}>
            Electrical, civil, and pneumatic gates must be approved before dispatch can be scheduled.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span
            style={{
              display: "inline-flex",
              padding: "4px 10px",
              borderRadius: 999,
              background: style.tone,
              color: style.color,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {loading ? "Loading…" : status}
          </span>
          <button type="button" onClick={() => refresh()} disabled={loading || saving}>
            Refresh
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "#9f1428", marginTop: 10, fontSize: 13 }}>{error}</div> : null}
      {notice ? <div style={{ color: "#0d6b33", marginTop: 10, fontSize: 13 }}>{notice}</div> : null}

      {loading ? (
        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.7 }}>Loading checklist…</div>
      ) : !checklist ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, opacity: 0.72, marginBottom: 10 }}>No checklist yet for this sales order.</div>
          {canEditReadiness(me) ? (
            <button type="button" onClick={createChecklist} disabled={saving}>
              {saving ? "Creating…" : "Create site readiness checklist"}
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {[
            ["electrical_ready", "Electrical ready"],
            ["civil_ready", "Civil ready"],
            ["pneumatic_ready", "Pneumatic / utilities ready"],
          ].map(([key, label]) => (
            <label key={key} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(flags[key])}
                disabled={!editable || saving}
                onChange={(e) => {
                  const next = { ...flags, [key]: e.target.checked };
                  setFlags(next);
                }}
              />
              <span>{label}</span>
            </label>
          ))}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            {editable ? (
              <button type="button" onClick={() => saveFlags(flags)} disabled={saving}>
                {saving ? "Saving…" : "Save flags"}
              </button>
            ) : null}
            {editable ? (
              <button
                type="button"
                onClick={() => saveFlags(flags, "Client_Submitted")}
                disabled={saving || !allReady}
                title={!allReady ? "All three readiness flags must be checked first." : undefined}
              >
                Submit for approval
              </button>
            ) : null}
            {canApprove ? (
              <button
                type="button"
                onClick={() => saveFlags({ ...flags, electrical_ready: true, civil_ready: true, pneumatic_ready: true }, "Approved")}
                disabled={saving || !allReady}
                title={!allReady ? "All three readiness flags must be true before approval." : "Approve site readiness and unlock dispatch"}
              >
                {saving ? "Approving…" : "Approve site readiness"}
              </button>
            ) : null}
            {editable && checklist.status !== "Rejected" ? (
              <button type="button" onClick={() => saveFlags(flags, "Rejected")} disabled={saving}>
                Reject
              </button>
            ) : null}
          </div>

          {!approved ? (
            <div style={{ fontSize: 12, color: "#8b5a00", marginTop: 4 }}>
              Create Dispatch stays blocked until status is Approved.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#0b7d45", marginTop: 4 }}>Site approved — dispatch may be created.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function isSiteReadinessApproved(status) {
  return String(status || "") === "Approved";
}
