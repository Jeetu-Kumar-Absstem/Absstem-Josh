import { useEffect, useMemo, useState } from "react";
import { DeskCard, DeskChip, DeskStat, NoticeBanner, PageHero, getDeskStatusAppearance } from "../shared/joshUi";
import { apiFetch, getApiErrorMessage } from "./api";

function money(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function claimTone(status) {
  return getDeskStatusAppearance(status, {
    success: ["reimbursed", "approved"],
    info: ["accounts"],
    warning: ["pending", "submitted"],
    danger: ["returned", "rejected"],
    fallbackTone: "#f5f7fb",
  });
}

export default function Expenses({ launch = null, onConsumeLaunch = null } = {}) {
  const [claims, setClaims] = useState([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [focusClaimId, setFocusClaimId] = useState(null);
  const [form, setForm] = useState({
    employee: "",
    purpose: "",
    category: "Travel",
    amount: "",
  });

  useEffect(() => {
    if (!launch || typeof launch !== "object") return;
    const claimId = Number(launch.claim_id || launch.claimId || launch.id);
    if (Number.isFinite(claimId) && claimId > 0) setFocusClaimId(claimId);
    if (typeof onConsumeLaunch === "function") onConsumeLaunch();
  }, [launch]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const data = await apiFetch("/hr/expenses");
        if (!active) return;
        setClaims(Array.isArray(data?.claims) ? data.claims : []);
      } catch (error) {
        if (!active) return;
        setNotice(getApiErrorMessage(error, "Could not load expenses right now."));
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
    if (!focusClaimId) return;
    const el = document.getElementById(`expense-claim-${focusClaimId}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusClaimId, claims]);

  const orderedClaims = useMemo(() => {
    if (!focusClaimId) return claims;
    const focused = claims.filter((item) => Number(item.id) === Number(focusClaimId));
    const rest = claims.filter((item) => Number(item.id) !== Number(focusClaimId));
    return [...focused, ...rest];
  }, [claims, focusClaimId]);

  const stats = useMemo(() => {
    const managerPending = claims.filter((item) => item.status === "manager_pending").length;
    const accountsPending = claims.filter((item) => item.status === "accounts_pending").length;
    const reimbursed = claims.filter((item) => item.status === "reimbursed").length;
    const pendingAmount = claims
      .filter((item) => item.status === "manager_pending" || item.status === "accounts_pending")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return { managerPending, accountsPending, reimbursed, pendingAmount };
  }, [claims]);

  async function createClaim() {
    if (!form.employee.trim() || !form.purpose.trim() || !String(form.amount).trim()) {
      setNotice("Fill employee, purpose, and amount before creating an expense claim.");
      return;
    }
    try {
      const data = await apiFetch("/hr/expenses", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setClaims((current) => [data.claim, ...current]);
      setForm({ employee: "", purpose: "", category: "Travel", amount: "" });
      setNotice("Expense claim created and sent for manager approval.");
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not create an expense claim right now."));
    }
  }

  async function updateClaim(id, status, message) {
    try {
      const data = await apiFetch(`/hr/expenses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setClaims((current) => current.map((item) => (item.id === id ? data.claim : item)));
      setNotice(message);
    } catch (error) {
      setNotice(getApiErrorMessage(error, "Could not update the claim right now."));
    }
  }

  return (
    <div style={{ maxWidth: 1480 }}>
      <PageHero
        eyebrow="Employee Claims"
        title="Expenses"
        description="Capture employee claims, move them through manager and Accounts review, and keep reimbursement visibility in one place."
        stats={[
          { label: "Manager pending", value: String(stats.managerPending), tone: "#8b5a00" },
          { label: "Accounts pending", value: String(stats.accountsPending), tone: "#234a8f" },
          { label: "Reimbursed", value: String(stats.reimbursed), tone: "#147a3d" },
          { label: "Pending amount", value: `INR ${money(stats.pendingAmount)}`, tone: "#9f2042" },
        ]}
      />

      <NoticeBanner tone="success" message={notice} />

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "minmax(300px, 0.34fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <DeskCard title="New Claim" subtitle="Start an employee expense or travel reimbursement request">
          <div style={{ display: "grid", gap: 10 }}>
            <input value={form.employee} onChange={(e) => setForm((current) => ({ ...current, employee: e.target.value }))} placeholder="Employee name" />
            <input value={form.purpose} onChange={(e) => setForm((current) => ({ ...current, purpose: e.target.value }))} placeholder="Purpose" />
            <select value={form.category} onChange={(e) => setForm((current) => ({ ...current, category: e.target.value }))}>
              <option value="Travel">Travel</option>
              <option value="Local travel">Local travel</option>
              <option value="Office event">Office event</option>
              <option value="Advance">Advance</option>
              <option value="Training">Training</option>
            </select>
            <input value={form.amount} onChange={(e) => setForm((current) => ({ ...current, amount: e.target.value }))} placeholder="Amount" />
            <button type="button" onClick={createClaim}>Create Claim</button>
          </div>
        </DeskCard>

        <DeskCard title="Expense Queue" subtitle="Approve, return, and reimburse from one HR-operational surface">
          <div style={{ display: "grid", gap: 12 }}>
            {loading ? <div style={{ fontSize: 13, opacity: 0.68 }}>Loading expenses...</div> : null}
            {orderedClaims.map((item) => {
              const tone = claimTone(item.status);
              const focused = Number(item.id) === Number(focusClaimId);
              return (
                <div
                  id={`expense-claim-${item.id}`}
                  key={item.id}
                  style={{
                    border: focused ? "2px solid #96b5ff" : "1px solid #e6ebf2",
                    borderRadius: 18,
                    padding: 14,
                    background: focused ? "#f5f8ff" : "#ffffff",
                    display: "grid",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.employee}</div>
                      <div style={{ marginTop: 4, fontSize: 13, opacity: 0.72 }}>
                        {[item.category, `INR ${money(item.amount)}`].join(" • ")}
                      </div>
                    </div>
                    <DeskChip label={item.status.replace(/_/g, " ")} tone={tone.tone} color={tone.color} />
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>{item.purpose}</div>
                  <div style={{ fontSize: 12, opacity: 0.66 }}>{item.bill_status}</div>
                  {item.reference_no ? <div style={{ fontSize: 12, opacity: 0.66 }}>Ref: {item.reference_no}</div> : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {item.receipt_attachment_id ? (
                      <a
                        href={`/hr/expenses/${item.id}/receipt`}
                        target="_blank"
                        rel="noreferrer"
                        className="button-ghost compact-button"
                        style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
                      >
                        View receipt
                      </a>
                    ) : null}
                    {item.status === "manager_pending" ? (
                      <button type="button" onClick={() => updateClaim(item.id, "accounts_pending", `Claim approved by manager for ${item.employee}.`)}>
                        Manager Approve
                      </button>
                    ) : null}
                    {item.status === "accounts_pending" ? (
                      <button type="button" onClick={() => updateClaim(item.id, "reimbursed", `Reimbursement marked complete for ${item.employee}.`)}>
                        Mark Reimbursed
                      </button>
                    ) : null}
                    {item.status !== "reimbursed" ? (
                      <button type="button" onClick={() => updateClaim(item.id, "returned", `Claim returned to ${item.employee} for correction.`)}>
                        Return
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!loading && !claims.length ? <div style={{ fontSize: 13, opacity: 0.66 }}>No expense claims yet.</div> : null}
          </div>
        </DeskCard>
      </div>
    </div>
  );
}
