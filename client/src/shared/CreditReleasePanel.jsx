import { useCallback, useEffect, useState } from "react";
import { toast } from "./joshUi";

const ERROR_MESSAGES = {
  INVALID_REASON: "Enter a reason for the release.",
  INVALID_EXPIRY: "Pick a valid expiry date.",
  INVALID_APPROVED_LIMIT: "Enter an approved amount greater than 0.",
  RELEASE_ALREADY_REQUESTED: "A release is already waiting for approval for this customer.",
  RELEASE_NOT_EDITABLE: "This release was already decided. Refresh to see the latest state.",
  APPROVER_RIGHTS_REQUIRED: "Approving needs Receipts / Invoices approve rights or Customer edit rights.",
  SELF_APPROVAL_NOT_ALLOWED: "You requested this release — another approver must decide it.",
  ONLY_REQUESTER_OR_APPROVER_CAN_CANCEL: "Only the requester or an approver can cancel this release.",
  CREDIT_CONTROL_NOT_READY: "Credit control is not set up on this database.",
  FORBIDDEN: "You don't have rights to change credit releases.",
};

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(ERROR_MESSAGES[data?.error] || data?.detail || data?.error || "Request failed");
    err.data = data;
    throw err;
  }
  return data;
}

function isoDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

function fmtAmount(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function fmtDay(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
}

/**
 * In-place credit release: request, approve/reject, or cancel without leaving the current desk.
 * Uses /credit-control/customers/:id/snapshot and /credit-control/releases.
 */
export default function CreditReleasePanel({ customerId, customerName = "", onChanged = null, onOpenFullDesk = null, compact = false }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [permissions, setPermissions] = useState(null);
  const [ready, setReady] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [requestForm, setRequestForm] = useState({ reason: "", remarks: "", expires_on: isoDate(7) });
  const [approveForm, setApproveForm] = useState({ approved_upto_amount: "", expires_on: "" });

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    setLoadError("");
    try {
      const data = await apiFetch(`/credit-control/customers/${customerId}/snapshot`);
      setReady(data?.ready !== false);
      setSnapshot(data?.snapshot || null);
      setPermissions(data?.permissions || null);
      const latest = data?.snapshot?.latest_release;
      if (latest?.release_status === "requested") {
        setApproveForm({
          approved_upto_amount: String(latest.requested_exposure || ""),
          expires_on: latest.expires_on ? String(latest.expires_on).slice(0, 10) : isoDate(7),
        });
      }
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    load();
  }, [load]);

  async function afterChange(message) {
    toast(message, "success");
    await load();
    if (typeof onChanged === "function") onChanged();
  }

  async function requestRelease(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch("/credit-control/releases", {
        method: "POST",
        body: JSON.stringify({ customer_id: Number(customerId), ...requestForm }),
      });
      setRequestForm({ reason: "", remarks: "", expires_on: isoDate(7) });
      await afterChange("Credit release requested. Approvers will see it in AR Desk.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function decide(releaseId, releaseStatus) {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/credit-control/releases/${releaseId}/status`, {
        method: "POST",
        body: JSON.stringify({
          release_status: releaseStatus,
          approved_upto_amount: releaseStatus === "approved" ? Number(approveForm.approved_upto_amount || 0) : null,
          expires_on: approveForm.expires_on || "",
        }),
      });
      await afterChange(
        releaseStatus === "approved" ? "Credit release approved." : releaseStatus === "rejected" ? "Credit release rejected." : "Credit release cancelled."
      );
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!customerId) return null;

  const boxStyle = {
    display: "grid",
    gap: 8,
    padding: compact ? 10 : 12,
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    background: "#f8fafc",
    fontSize: 13,
  };

  if (loading && !snapshot) return <div style={boxStyle}>Loading credit position…</div>;
  if (loadError) return <div style={{ ...boxStyle, color: "#b42318" }}>{loadError}</div>;
  if (!ready || !snapshot) return <div style={boxStyle}>Credit control is not enabled for this customer.</div>;

  const latest = snapshot.latest_release || null;
  const active = snapshot.active_release || null;
  const pending = latest?.release_status === "requested" ? latest : null;
  const isOwnRequest = pending && permissions && Number(pending.requested_by) === Number(permissions.user_id);
  const canDecide = pending && permissions?.can_approve && (!isOwnRequest || permissions?.self_approval_allowed);
  const blocked =
    Boolean(snapshot.profile?.is_credit_hold) ||
    Boolean(snapshot.evaluation?.over_limit) ||
    Boolean(snapshot.evaluation?.overdue_blocked) ||
    Boolean(snapshot.decisions?.so_confirmation?.block) ||
    Boolean(snapshot.decisions?.dispatch_release?.block);
  const tone = snapshot.attention_level === "high" ? "#b42318" : snapshot.attention_level === "medium" ? "#b45309" : "#0a7a35";

  return (
    <div style={boxStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>Credit release{customerName ? ` · ${customerName}` : ""}</strong>
        {typeof onOpenFullDesk === "function" ? (
          <button type="button" className="button-ghost compact-button" onClick={() => onOpenFullDesk()}>
            Full credit desk
          </button>
        ) : null}
      </div>
      <div style={{ color: tone }}>{snapshot.queue_reason}</div>
      <div style={{ color: "#475569" }}>
        Exposure {fmtAmount(snapshot.exposure?.total_exposure)} · Limit{" "}
        {Number(snapshot.profile?.credit_limit || 0) > 0 ? fmtAmount(snapshot.profile?.credit_limit) : "not set"} · Overdue invoices{" "}
        {snapshot.exposure?.overdue_count || 0}
      </div>
      {active ? (
        <div style={{ color: "#0a7a35" }}>
          Active release up to {fmtAmount(active.approved_upto_amount)} till {fmtDay(active.expires_on)}
          {active.approved_by_name ? ` · approved by ${active.approved_by_name}` : ""}
        </div>
      ) : null}

      {pending ? (
        <div style={{ display: "grid", gap: 6, borderTop: "1px solid #e2e8f0", paddingTop: 8 }}>
          <div>
            <strong>Waiting for approval</strong> · {fmtAmount(pending.requested_exposure)} requested
            {pending.requested_by_name ? ` by ${pending.requested_by_name}` : ""} · till {fmtDay(pending.expires_on)}
          </div>
          {pending.reason ? <div style={{ color: "#475569" }}>Reason: {pending.reason}</div> : null}
          {canDecide ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Approve up to ₹"
                value={approveForm.approved_upto_amount}
                onChange={(e) => setApproveForm((f) => ({ ...f, approved_upto_amount: e.target.value }))}
                disabled={busy}
                style={{ width: 150 }}
              />
              <input
                type="date"
                value={approveForm.expires_on}
                onChange={(e) => setApproveForm((f) => ({ ...f, expires_on: e.target.value }))}
                disabled={busy}
              />
              <button type="button" className="button-primary compact-button" disabled={busy} onClick={() => decide(pending.id, "approved")}>
                Approve release
              </button>
              <button type="button" className="button-ghost compact-button" disabled={busy} onClick={() => decide(pending.id, "rejected")}>
                Reject
              </button>
            </div>
          ) : (
            <div style={{ color: "#64748b" }}>
              {isOwnRequest ? "You raised this request — an approver in Accounts must decide it." : "An approver in Accounts will decide this request."}
            </div>
          )}
          {isOwnRequest || permissions?.can_approve ? (
            <div>
              <button type="button" className="button-ghost compact-button" disabled={busy} onClick={() => decide(pending.id, "cancelled")}>
                Cancel request
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!pending && permissions?.can_request && (blocked || !active) ? (
        <form onSubmit={requestRelease} style={{ display: "grid", gap: 6, borderTop: "1px solid #e2e8f0", paddingTop: 8 }}>
          <div style={{ fontWeight: 600 }}>{blocked ? "Request a release to unblock this customer" : "Request a release"}</div>
          <input
            placeholder="Reason (e.g. payment promised on 5th, PDC received)"
            value={requestForm.reason}
            onChange={(e) => setRequestForm((f) => ({ ...f, reason: e.target.value }))}
            disabled={busy}
            required
          />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              Valid till
              <input
                type="date"
                value={requestForm.expires_on}
                onChange={(e) => setRequestForm((f) => ({ ...f, expires_on: e.target.value }))}
                disabled={busy}
                required
              />
            </label>
            <input
              placeholder="Remarks (optional)"
              value={requestForm.remarks}
              onChange={(e) => setRequestForm((f) => ({ ...f, remarks: e.target.value }))}
              disabled={busy}
              style={{ flex: 1, minWidth: 160 }}
            />
            <button type="submit" className="button-primary compact-button" disabled={busy}>
              {busy ? "Sending…" : "Request release"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
